import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as readline from "readline";
import { agentPathRequiresWindowsShell } from "../agentModels";
import { augmentPathEnv } from "../util/agentEnv";
import type { AgentFileLogger } from "../logging/agentFileLog";
import type { JsonRpcRequest, JsonRpcResponse, SessionPromptPart } from "./types";

export type SessionUpdateHandler = (msg: unknown) => void;

/** Drives the chat load banner; mirrors cursor-agent.log stages: spawn → initialize → authenticate. */
export type AcpConnectProgressPhase =
	| "spawning"
	| "initializing"
	| "authenticating"
	| "ready"
	| "error";

export interface AcpClientHooks {
	/** Fired as the subprocess and ACP JSON-RPC handshake progress (see AgentFileLogger). */
	onConnectProgress?: (phase: AcpConnectProgressPhase) => void;
	onSessionUpdate: SessionUpdateHandler;
	onPermissionRequest: (
		params: unknown,
		respond: (result: unknown) => void
	) => void;
	onCursorCreatePlan: (
		params: unknown,
		respond: (result: unknown) => void
	) => void;
	onCursorAskQuestion: (
		params: unknown,
		respond: (result: unknown) => void
	) => void;
	onStderrLine?: (line: string) => void;
}

export interface AcpSpawnOptions {
	agentPath: string;
	workspaceRoot: string;
	mode: "agent" | "ask";
	model: string;
	trustWorkspace: boolean;
	extraArgs: string[];
}

/**
 * Cursor Agent CLI in ACP mode — JSON-RPC over newline-delimited stdout.
 */
export class AcpClient {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
	private rl: readline.Interface | null = null;
	private hooks: AcpClientHooks;
	private sendQueue: Promise<void> = Promise.resolve();
	private readonly diag: string[] = [];
	private readonly maxDiag = 24;

	private pushDiag(line: string): void {
		this.diag.push(line.trim());
		if (this.diag.length > this.maxDiag) this.diag.shift();
	}

	/** Last lines from stderr / non-JSON stdout (for error messages). */
	getDiagnostics(): string {
		return this.diag.length ? "\n\n" + this.diag.join("\n") : "";
	}

	private fail(msg: string): Error {
		return new Error(msg + this.getDiagnostics());
	}

	constructor(
		hooks: AcpClientHooks,
		private readonly log: AgentFileLogger | null = null
	) {
		this.hooks = hooks;
	}

	isRunning(): boolean {
		return this.proc !== null && this.proc.exitCode === null;
	}

	async spawn(opt: AcpSpawnOptions): Promise<void> {
		await this.dispose();
		this.diag.length = 0;

		if (!fs.existsSync(opt.agentPath)) {
			throw this.fail(
				`Cursor Agent CLI not found at:\n${opt.agentPath}\nInstall the CLI or set the exact path under Settings → Cursor Agent.`
			);
		}

		const args: string[] = ["--workspace", opt.workspaceRoot];
		if (opt.trustWorkspace) args.push("--trust");
		if (opt.mode === "ask") args.push("--mode", "ask");
		if (opt.model.trim()) args.push("--model", opt.model.trim());
		args.push(...opt.extraArgs.filter((a) => a.length > 0));
		args.push("acp");

		const mergedEnv = augmentPathEnv();
		this.log?.spawn(opt.agentPath, args, (mergedEnv.PATH ?? "").slice(0, 400));

		this.hooks.onConnectProgress?.("spawning");

		this.proc = spawn(opt.agentPath, args, {
			env: mergedEnv,
			stdio: ["pipe", "pipe", "pipe"],
			...(agentPathRequiresWindowsShell(opt.agentPath) ? { shell: true } : {}),
		});

		this.proc.stderr?.on("data", (chunk: Buffer) => {
			const s = chunk.toString();
			for (const line of s.split("\n")) {
				if (!line.trim()) continue;
				this.pushDiag("[stderr] " + line);
				this.log?.stderr(line);
				if (this.hooks.onStderrLine) this.hooks.onStderrLine(line);
			}
		});

		this.rl = readline.createInterface({ input: this.proc.stdout });
		this.rl.on("line", (line) => this.onLine(line));
		this.proc.on("error", (err: NodeJS.ErrnoException) => {
			this.log?.procEvent("spawn_error", `${err.code ?? ""} ${err.message}`);
			const hint =
				err.code === "ENOENT"
					? " (executable missing — set the full path to `agent` in plugin settings)"
					: "";
			const wrapped = this.fail(`Failed to start agent: ${err.message}${hint}`);
			for (const [, w] of this.pending) w.reject(wrapped);
			this.pending.clear();
		});
		this.proc.on("close", (code, signal) => {
			this.log?.procEvent("exit", `code=${code ?? "?"} signal=${signal ?? ""}`);
			const detail =
				code !== null && code !== 0 ? ` (exit ${code}${signal ? ` ${signal}` : ""})` : "";
			for (const [, w] of this.pending) {
				w.reject(this.fail(`ACP process exited${detail}`));
			}
			this.pending.clear();
		});

		/* [rpc/send] id=* method=initialize — ACP handshakes the protocol */
		this.hooks.onConnectProgress?.("initializing");
		try {
			await this.request("initialize", {
				protocolVersion: 1,
				clientCapabilities: {
					fs: { readTextFile: false, writeTextFile: false },
					terminal: false,
				},
				clientInfo: { name: "obsidian-cursor-plugin", version: "1.0.0" },
			});

			/* [rpc/send] method=authenticate methodId=cursor_login */
			this.hooks.onConnectProgress?.("authenticating");
			await this.request("authenticate", { methodId: "cursor_login" });
			this.hooks.onConnectProgress?.("ready");
		} catch (e) {
			this.hooks.onConnectProgress?.("error");
			throw e;
		}
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.sendQueue.then(fn, fn);
		this.sendQueue = run.then(
			() => {},
			() => {}
		);
		return run;
	}

	private writeLine(obj: unknown): void {
		if (!this.proc?.stdin) throw new Error("ACP not connected");
		const line = JSON.stringify(obj) + "\n";
		this.proc.stdin.write(line);
	}

	request(method: string, params?: unknown): Promise<unknown> {
		return this.enqueue(() => {
			if (!this.proc?.stdin) throw new Error("ACP not connected");
			const id = this.nextId++;
			this.log?.rpcSend(id, method, params);
			return new Promise((resolve, reject) => {
				this.pending.set(id, { resolve, reject });
				this.writeLine({ jsonrpc: "2.0", id, method, params });
			});
		});
	}

	respond(id: number, result: unknown): void {
		this.log?.clientResponse(id, result);
		this.writeLine({ jsonrpc: "2.0", id, result });
	}

	respondError(id: number, code: number, message: string): void {
		this.log?.clientResponse(id, { error: { code, message } });
		this.writeLine({ jsonrpc: "2.0", id, error: { code, message } });
	}

	async sessionNew(cwd: string): Promise<{ sessionId: string }> {
		const r = (await this.request("session/new", {
			cwd,
			mcpServers: [],
		})) as { sessionId?: string };
		if (!r?.sessionId) throw this.fail("session/new missing sessionId");
		return { sessionId: r.sessionId };
	}

	async sessionLoad(sessionId: string): Promise<unknown> {
		return this.request("session/load", { sessionId });
	}

	async sessionPrompt(sessionId: string, parts: SessionPromptPart[]): Promise<unknown> {
		return this.request("session/prompt", {
			sessionId,
			prompt: parts,
		});
	}

	async sessionCancel(sessionId: string): Promise<unknown> {
		try {
			return await this.request("session/cancel", { sessionId });
		} catch {
			return undefined;
		}
	}

	private onLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;

		let msg: JsonRpcRequest & JsonRpcResponse;
		try {
			msg = JSON.parse(trimmed);
		} catch {
			this.pushDiag("[stdout] " + trimmed.slice(0, 400));
			this.log?.stdoutNonJson(trimmed);
			return;
		}

		if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined)) {
			const id = msg.id as number;
			this.log?.rpcRecv(id, msg.error ?? msg.result, !!msg.error);
			const w = this.pending.get(id);
			if (!w) {
				this.log?.line("rpc/orphan", `response for unknown id=${id}`);
				return;
			}
			this.pending.delete(id);
			if (msg.error) {
				let errMsg = msg.error.message ?? "JSON-RPC error";
				const data = msg.error.data;
				if (data && typeof data === "object") {
					const d = data as Record<string, unknown>;
					if (typeof d.details === "string") errMsg += ": " + d.details;
					else if (typeof d.detail === "string") errMsg += ": " + d.detail;
				}
				w.reject(this.fail(errMsg));
			}
			else w.resolve(msg.result);
			return;
		}

		if (msg.method === "session/update") {
			this.log?.rpcNotify("session/update", this.summarizeSessionUpdate(msg.params));
			this.hooks.onSessionUpdate(msg.params);
			return;
		}

		if (msg.method === "session/request_permission" && msg.id !== undefined) {
			const id = msg.id as number;
			this.log?.rpcNotify("session/request_permission", `id=${id}`);
			this.hooks.onPermissionRequest(msg.params, (result) => this.respond(id, result));
			return;
		}

		if (msg.method === "cursor/create_plan" && msg.id !== undefined) {
			const id = msg.id as number;
			this.log?.rpcNotify("cursor/create_plan", `id=${id}`);
			this.hooks.onCursorCreatePlan(msg.params, (result) => this.respond(id, result));
			return;
		}

		if (msg.method === "cursor/ask_question" && msg.id !== undefined) {
			const id = msg.id as number;
			this.log?.rpcNotify("cursor/ask_question", `id=${id}`);
			this.hooks.onCursorAskQuestion(msg.params, (result) => this.respond(id, result));
			return;
		}

		this.log?.line("rpc/unhandled", trimmed.slice(0, 1500));
	}

	private summarizeSessionUpdate(params: unknown): string {
		try {
			if (!params || typeof params !== "object") return String(params);
			const o = params as Record<string, unknown>;
			const inner = (o.update ?? o) as Record<string, unknown>;
			const su = inner.sessionUpdate;
			const sid = (inner.sessionId ?? o.sessionId) as string | undefined;
			let s = `sessionId=${sid ?? "?"} kind=${String(su)}`;
			if (su === "agent_message_chunk") {
				const t = (inner.content as { text?: string } | undefined)?.text;
				if (t) s += ` chunkLen=${t.length}`;
			}
			return s;
		} catch {
			return "unparseable";
		}
	}

	async dispose(): Promise<void> {
		this.log?.procEvent("dispose", "");
		if (this.rl) {
			this.rl.close();
			this.rl = null;
		}
		if (this.proc) {
			try {
				this.proc.stdin?.end();
			} catch {
				/* ignore */
			}
			try {
				this.proc.kill();
			} catch {
				/* ignore */
			}
			this.proc = null;
		}
		this.pending.clear();
	}
}
