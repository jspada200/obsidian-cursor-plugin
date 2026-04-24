import * as fs from "fs";
import * as path from "path";
import type { App } from "obsidian";
import { FileSystemAdapter, Notice } from "obsidian";
import type { CursorAgentSettings } from "../settings";

const LOG_NAME = "cursor-agent.log";
const MAX_BYTES = 8 * 1024 * 1024;

function pluginDir(app: App, pluginId: string): string | null {
	const a = app.vault.adapter;
	if (!(a instanceof FileSystemAdapter)) return null;
	return path.join(a.getBasePath(), ".obsidian", "plugins", pluginId);
}

export function getAgentLogPath(app: App, pluginId: string): string | null {
	const dir = pluginDir(app, pluginId);
	if (!dir) return null;
	return path.join(dir, LOG_NAME);
}

/** Reveal `cursor-agent.log` in Finder / Explorer (desktop). */
export function revealAgentLogFile(app: App, pluginId: string): void {
	const p = getAgentLogPath(app, pluginId);
	if (!p) {
		new Notice("Log file path unavailable (desktop vault required).");
		return;
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { shell } = require("electron") as { shell: { showItemInFolder: (path: string) => void } };
		shell.showItemInFolder(p);
	} catch {
		new Notice(`Cursor Agent log:\n${p}`, 20000);
	}
}

function ts(): string {
	return new Date().toISOString();
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max) + `… (${s.length} chars total)`;
}

/**
 * Append-only diagnostic log for the Cursor Agent subprocess (spawn, ACP, stderr).
 */
export class AgentFileLogger {
	readonly logPath: string | null;

	constructor(
		private readonly app: App,
		private readonly pluginId: string,
		private getSettings: () => CursorAgentSettings
	) {
		this.logPath = getAgentLogPath(app, pluginId);
	}

	updateSettings(getSettings: () => CursorAgentSettings): void {
		this.getSettings = getSettings;
	}

	private enabled(): boolean {
		return this.getSettings().agentFileLog !== false;
	}

	private verbose(): boolean {
		return this.getSettings().agentLogVerbose === true;
	}

	private append(line: string): void {
		if (!this.enabled() || !this.logPath) return;
		try {
			if (fs.existsSync(this.logPath)) {
				const st = fs.statSync(this.logPath);
				if (st.size > MAX_BYTES) {
					const bak = this.logPath + ".1";
					try {
						if (fs.existsSync(bak)) fs.unlinkSync(bak);
						fs.renameSync(this.logPath, bak);
					} catch {
						fs.truncateSync(this.logPath, 0);
					}
					fs.appendFileSync(
						this.logPath,
						`[${ts()}] [log] Rotated: previous log saved as ${path.basename(bak)}\n`,
						"utf8"
					);
				}
			}
			fs.appendFileSync(this.logPath, line, "utf8");
		} catch (e) {
			console.error("[Cursor Agent log file]", e);
		}
	}

	line(section: string, message: string, extra?: string): void {
		let out = `[${ts()}] [${section}] ${message}`;
		if (extra) out += `\n${extra}`;
		out += "\n";
		this.append(out);
	}

	spawn(agentPath: string, args: string[], envPathSnippet?: string): void {
		this.line(
			"spawn",
			`${agentPath} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`,
			envPathSnippet ? `PATH head: ${truncate(envPathSnippet, 300)}` : undefined
		);
	}

	rpcSend(id: number, method: string, params?: unknown): void {
		const v = this.verbose();
		let detail: string | undefined;
		if (params !== undefined) {
			if (method === "session/prompt" && params && typeof params === "object") {
				const p = params as { sessionId?: string; prompt?: Array<{ type?: string; text?: string }> };
				const parts = p.prompt ?? [];
				let chars = 0;
				let preview = "";
				for (const part of parts) {
					if (part.text) {
						chars += part.text.length;
						if (v && !preview) preview = truncate(part.text, v ? 8000 : 400);
					}
				}
				detail = `sessionId=${p.sessionId ?? "?"} parts=${parts.length} textChars=${chars}`;
				if (preview) detail += `\npromptPreview:\n${preview}`;
				else if (!v) detail += `\n(enable "Verbose agent log" for prompt excerpt)`;
			} else {
				const raw = JSON.stringify(params);
				detail = truncate(raw, v ? 12000 : 1200);
			}
		}
		this.line("rpc/send", `id=${id} method=${method}`, detail);
	}

	rpcRecv(id: number, payload: unknown, isError: boolean): void {
		let raw: string;
		try {
			raw = JSON.stringify(payload);
		} catch {
			raw = String(payload);
		}
		this.line(
			"rpc/recv",
			`id=${id} ${isError ? "error" : "result"}`,
			truncate(raw, this.verbose() ? 16000 : 2500)
		);
	}

	rpcNotify(method: string, summary: string): void {
		this.line("rpc/notify", `${method} ${summary}`);
	}

	/** Client JSON-RPC response to a server request (permission, plan, etc.). */
	clientResponse(id: number, payload: unknown): void {
		let raw: string;
		try {
			raw = JSON.stringify(payload);
		} catch {
			raw = String(payload);
		}
		this.line("rpc/client-response", `id=${id}`, truncate(raw, this.verbose() ? 8000 : 1500));
	}

	stderr(line: string): void {
		this.line("stderr", line);
	}

	stdoutNonJson(line: string): void {
		this.line("stdout/non-json", truncate(line, 2000));
	}

	procEvent(kind: string, detail?: string): void {
		this.line("process", `${kind}${detail ? " " + detail : ""}`);
	}

	ui(message: string): void {
		this.line("ui", message);
	}
}
