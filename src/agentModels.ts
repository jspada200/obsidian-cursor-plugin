import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AgentFileLogger } from "./logging/agentFileLog";
import { augmentPathEnv } from "./util/agentEnv";

/** Default install layout for the Cursor Agent CLI on Windows (see `%LOCALAPPDATA%\\cursor-agent\\`). */
function defaultAgentPathWhenUnset(): string {
	if (process.platform === "win32") {
		const localAppData =
			process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
		return path.join(localAppData, "cursor-agent", "agent.cmd");
	}
	return path.join(os.homedir(), ".local", "bin", "agent");
}

export function expandAgentPath(configured: string): string {
	const p = configured.trim();
	if (p) return p.replace(/^~(?=$|[\\/])/, os.homedir());
	return defaultAgentPathWhenUnset();
}

/**
 * Node 22+ on Windows: `spawn` / `execFile` on `.cmd`, `.bat`, or `.ps1` without `shell: true`
 * fails with `EINVAL` (security-related behavior). Cursor’s Windows shim is usually `agent.cmd`.
 */
export function agentPathRequiresWindowsShell(agentPath: string): boolean {
	if (process.platform !== "win32") return false;
	return /\.(cmd|bat|ps1)$/i.test(agentPath.trim());
}

export function agentBinaryExists(agentPath: string): boolean {
	try {
		if (!fs.existsSync(agentPath)) return false;
		if (process.platform === "win32") return true;
		fs.accessSync(agentPath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** One selectable model: `id` is what must be passed to `--model`. */
export interface ModelOption {
	id: string;
	label: string;
}

const SEP = " - ";

/**
 * Parse `agent models` / `agent --list-models` output.
 * Lines look like: `composer-2-fast - Composer 2 Fast (current, default)`
 * Only the id before the first ` - ` is valid for `--model`.
 */
export function parseModelsCliOutput(stdout: string): ModelOption[] {
	const out: ModelOption[] = [];
	const seen = new Set<string>();
	for (const raw of stdout.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		if (line === "Available models") continue;
		const i = line.indexOf(SEP);
		if (i <= 0) continue;
		const id = line.slice(0, i).trim();
		const rest = line.slice(i + SEP.length).trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push({
			id,
			label: rest ? `${id} — ${rest}` : id,
		});
	}
	return out;
}

/** If settings stored a full CLI line by mistake, keep only the model id. */
export function sanitizeModelId(stored: string): string {
	const t = stored.trim();
	if (!t) return "";
	const i = t.indexOf(SEP);
	if (i > 0) return t.slice(0, i).trim();
	return t;
}

/**
 * List models via `agent models`, then fallback to `agent --list-models`.
 * Uses the same PATH augmentation as the ACP spawn so the executable resolves helpers if needed.
 */
export async function fetchAvailableModels(
	agentPath: string,
	log?: AgentFileLogger | null
): Promise<ModelOption[]> {
	const env = augmentPathEnv();
	const execOpts = {
		timeout: 45000,
		maxBuffer: 4 * 1024 * 1024,
		env,
		...(agentPathRequiresWindowsShell(agentPath) ? { shell: true as const } : {}),
	};

	const run = (args: string[]) =>
		new Promise<{ stdout: string; stderr: string; err: Error | null }>((resolve) => {
			execFile(agentPath, args, execOpts, (err, stdout, stderr) => {
				resolve({
					stdout: stdout?.toString() ?? "",
					stderr: stderr?.toString() ?? "",
					err: err ?? null,
				});
			});
		});

	log?.line("models", `exec: ${JSON.stringify([agentPath, "models"])}`);

	let { stdout, stderr, err } = await run(["models"]);
	if (!err && stdout.trim()) {
		const parsed = parseModelsCliOutput(stdout);
		log?.line(
			"models",
			`agent models: ok parsed=${parsed.length} ids=${parsed
				.slice(0, 12)
				.map((m) => m.id)
				.join(", ")}${parsed.length > 12 ? "…" : ""}`
		);
		if (stderr.trim()) log?.line("models", `agent models stderr: ${stderr.trim().slice(0, 1200)}`);
		return parsed;
	}

	log?.line(
		"models",
		`agent models failed or empty: ${err?.message ?? "no output"} stderr=${stderr.slice(0, 800)}`
	);

	log?.line("models", `fallback exec: ${JSON.stringify([agentPath, "--list-models"])}`);
	({ stdout, stderr, err } = await run(["--list-models"]));
	if (!err && stdout.trim()) {
		const parsed = parseModelsCliOutput(stdout);
		log?.line("models", `--list-models: ok parsed=${parsed.length}`);
		if (stderr.trim()) log?.line("models", `--list-models stderr: ${stderr.trim().slice(0, 1200)}`);
		return parsed;
	}

	log?.line("models", `--list-models failed: ${err?.message ?? "empty"} stderr=${stderr.slice(0, 800)}`);
	return [];
}
