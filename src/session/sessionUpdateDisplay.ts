/**
 * Map Cursor ACP `session/update` payloads into UI stream events.
 * Shape varies by CLI version; this is defensive and extensible.
 */

export type StreamAppend =
	| { type: "assistant"; text: string }
	| { type: "thought"; text: string }
	| { type: "tool"; label: string; text: string }
	| { type: "status"; text: string }
	| { type: "skip" };

function truncate(s: string, n: number): string {
	return s.length <= n ? s : s.slice(0, n) + "…";
}

function unwrapUpdate(params: unknown): Record<string, unknown> | null {
	if (!params || typeof params !== "object") return null;
	const p = params as Record<string, unknown>;
	const u = p.update;
	if (u && typeof u === "object") return u as Record<string, unknown>;
	return p;
}

function pickStringContent(c: Record<string, unknown>, keys: string[]): string | undefined {
	for (const k of keys) {
		const v = c[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

function formatToolDetail(content: Record<string, unknown>): string {
	const name = String(content.toolName ?? content.name ?? "tool");
	const args = content.arguments ?? content.args ?? content.input ?? content.params;
	let argsStr = "";
	if (typeof args === "string") argsStr = truncate(args, 600);
	else if (args && typeof args === "object") argsStr = truncate(JSON.stringify(args), 600);
	return argsStr ? `${name} ${argsStr}` : name;
}

function formatSessionInfo(upd: Record<string, unknown>): string | undefined {
	const si = (upd.sessionInfo ?? upd.info ?? upd.session) as unknown;
	if (!si || typeof si !== "object") return undefined;
	const o = si as Record<string, unknown>;
	const parts: string[] = [];
	for (const k of ["model", "modelId", "currentModelId", "title", "phase", "status"]) {
		if (o[k] != null && String(o[k]).length) parts.push(`${k}: ${String(o[k])}`);
	}
	return parts.length ? parts.join(" · ") : undefined;
}

function compactFallback(kind: string, upd: Record<string, unknown>): string {
	const skipKeys = new Set(["sessionUpdate", "sessionId", "content"]);
	const keys = Object.keys(upd).filter((k) => !skipKeys.has(k));
	if (keys.length === 0) return kind;
	const parts = keys.slice(0, 5).map((k) => {
		const v = upd[k];
		if (v === null || v === undefined) return `${k}=`;
		if (typeof v === "object") return `${k}={…}`;
		return `${k}=${truncate(String(v), 100)}`;
	});
	return `${kind}: ${parts.join(" ")}`;
}

/**
 * Turn one `session/update` notification into something to show in the transcript.
 */
export function parseSessionUpdateForDisplay(params: unknown): StreamAppend {
	const upd = unwrapUpdate(params);
	if (!upd) return { type: "skip" };

	const kind = String(
		upd.sessionUpdate ?? (upd as { sessionUpdateType?: string }).sessionUpdateType ?? ""
	);
	const content = (upd.content ?? {}) as Record<string, unknown>;

	/* Final assistant answer stream (sometimes shares a chunk with reasoning fields) */
	if (kind === "agent_message_chunk") {
		const t = pickStringContent(content, ["text", "delta", "message"]);
		if (t) return { type: "assistant", text: t };
		const th = pickThoughtOnly(content);
		if (th) return { type: "thought", text: th };
		return { type: "skip" };
	}

	/* Reasoning / thinking streams (names vary by server) */
	const thoughtKind =
		kind.includes("thought") ||
		kind.includes("thinking") ||
		kind.includes("reasoning") ||
		kind === "thinking_delta";

	if (thoughtKind) {
		const t =
			pickStringContent(content, ["text", "thought", "thinking", "reasoning", "delta", "message"]) ??
			pickThoughtOnly(content);
		if (t) return { type: "thought", text: t };
	}

	const thoughtOnly = pickThoughtOnly(content);
	if (thoughtOnly && !pickStringContent(content, ["text"])) {
		return { type: "thought", text: thoughtOnly };
	}

	/* Tool lifecycle */
	if (
		kind.includes("tool") ||
		content.toolCallId ||
		content.toolName ||
		content.tool_call_id
	) {
		return {
			type: "tool",
			label: kind || "tool",
			text: formatToolDetail(content),
		};
	}

	if (kind === "available_commands_update") return { type: "skip" };

	if (kind === "session_info_update") {
		const s = formatSessionInfo(upd) ?? formatSessionInfo(content);
		if (s) return { type: "status", text: s };
		return { type: "skip" };
	}

	if (kind) {
		const inner = formatSessionInfo(upd);
		if (inner) return { type: "status", text: inner };
		const summary = compactFallback(kind, upd);
		if (summary.length < 400) return { type: "status", text: summary };
		return { type: "status", text: truncate(summary, 350) };
	}

	return { type: "skip" };
}

function pickThoughtOnly(c: Record<string, unknown>): string | undefined {
	return pickStringContent(c, ["thought", "thinking", "reasoning"]);
}
