/**
 * Map Cursor ACP `session/update` payloads into UI stream events.
 * Shape varies by CLI version; this is defensive and extensible.
 */

export type StreamAppend =
	| { type: "assistant"; text: string }
	| { type: "thought"; text: string }
	| {
			type: "tool";
			/** Raw ACP `sessionUpdate` value, e.g. `tool_call`, `tool_call_update` */
			sessionUpdateKind: string;
			/** Human-readable tool name when present in the payload */
			toolName: string;
			/** Arguments, status, or result snippet */
			detail: string;
			toolCallId?: string;
	  }
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

function getToolCallId(
	content: Record<string, unknown>,
	upd: Record<string, unknown>
): string | undefined {
	for (const o of [upd, content] as const) {
		for (const k of ["toolCallId", "tool_call_id", "callId"] as const) {
			const v = o[k];
			if (typeof v === "string" && v.length > 0) return v;
		}
	}
	return undefined;
}

/**
 * ACP spec: `tool_call` / `tool_call_update` use fields on the **update** object
 * (`title`, `kind`, `toolCallId`), not only `content`. Cursor sends human-readable
 * `title` here; we must not rely on `content` alone.
 * @see https://agentclientprotocol.com/protocol/tool-calls.md
 */
const ACP_KIND_LABEL: Record<string, string> = {
	read: "Read",
	edit: "Edit",
	delete: "Delete",
	move: "Move",
	search: "Search",
	execute: "Run",
	think: "Think",
	fetch: "Fetch",
	other: "Tool",
};

function acpKindLabel(kind: string): string {
	return ACP_KIND_LABEL[kind] ?? (kind ? kind[0]!.toUpperCase() + kind.slice(1) : "Tool");
}

function parseNameFromRawInput(raw: unknown): string | undefined {
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	const s = raw.trim();
	if (!s.startsWith("{") && !s.startsWith("[")) return undefined;
	try {
		const v = JSON.parse(s) as unknown;
		if (v && typeof v === "object" && "name" in (v as object)) {
			const n = (v as { name?: unknown }).name;
			if (typeof n === "string" && n) return n;
		}
	} catch {
		/* ignore */
	}
	return undefined;
}

function getToolDisplayNameFromContent(
	content: Record<string, unknown>,
	sessionUpdateKind: string
): string | undefined {
	const pick = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
	let n =
		pick(content.title) ||
		pick(content.toolName) ||
		pick(content.name) ||
		pick(content.functionName);
	const fn = content.function;
	if (!n && fn && typeof fn === "object") {
		const o = fn as { name?: string };
		if (o.name) n = o.name;
	}
	const tool = content.tool;
	if (!n && tool && typeof tool === "object") {
		const o = tool as { name?: string; toolName?: string };
		n = o.toolName ?? o.name;
	}
	if (n) return n;
	const inv = content.invocation ?? content.mcp;
	if (inv && typeof inv === "object") {
		const o = inv as { toolName?: string; name?: string };
		n = o.toolName ?? o.name;
	}
	if (n) return n;
	if (sessionUpdateKind === "tool_call_update") return undefined;
	return undefined;
}

/** Best label for a tool row: ACP `title` / `kind` first, then nested content. */
function resolveToolDisplayName(
	upd: Record<string, unknown>,
	content: Record<string, unknown>,
	sessionUpdateKind: string
): string {
	if (typeof upd.title === "string" && upd.title.trim().length > 0) {
		return upd.title.trim();
	}
	const fromContent = getToolDisplayNameFromContent(content, sessionUpdateKind);
	if (fromContent) return fromContent;

	const meta = upd._meta;
	if (meta && typeof meta === "object") {
		const m = meta as { toolName?: string; name?: string };
		if (typeof m.toolName === "string" && m.toolName) return m.toolName;
		if (typeof m.name === "string" && m.name) return m.name;
	}

	if (typeof upd.kind === "string" && upd.kind.trim().length > 0) {
		return acpKindLabel(upd.kind.trim());
	}

	for (const k of ["rawInput", "rawinput", "input"] as const) {
		const n = parseNameFromRawInput(upd[k]);
		if (n) return n;
	}
	const n2 = parseNameFromRawInput(content.rawInput);
	if (n2) return n2;

	/* Shallow content walk for rare nesting (defensive) */
	for (const sub of [content.data, content.payload, content.call] as const) {
		if (sub && typeof sub === "object") {
			const t = (sub as { title?: string; name?: string; toolName?: string }).title;
			if (typeof t === "string" && t.trim()) return t.trim();
		}
	}

	if (sessionUpdateKind === "tool_call_update") return "…";
	if (sessionUpdateKind === "tool_call") return "Tool";
	if (sessionUpdateKind.toLowerCase().includes("tool")) return sessionUpdateKind;
	return "Tool";
}

function formatToolDetail(content: Record<string, unknown>, upd: Record<string, unknown>): string {
	const args =
		content.arguments ??
		content.args ??
		content.input ??
		content.params ??
		upd.rawInput ??
		upd.rawinput;
	let argsStr = "";
	if (typeof args === "string") argsStr = truncate(args, 600);
	else if (args && typeof args === "object") argsStr = truncate(JSON.stringify(args), 600);
	return argsStr || "";
}

function firstTextFromAcpContentBlocks(blocks: unknown): string | undefined {
	if (!Array.isArray(blocks)) return undefined;
	for (const b of blocks) {
		if (!b || typeof b !== "object") continue;
		const o = b as { type?: string; content?: { type?: string; text?: string } };
		if (o.type === "content" && o.content?.type === "text" && o.content.text) {
			return o.content.text;
		}
	}
	return undefined;
}

function formatToolUpdateDetail(
	content: Record<string, unknown>,
	upd: Record<string, unknown>
): string {
	if (upd.status != null) return `status: ${String(upd.status)}`;
	if (content.status != null) return `status: ${String(content.status)}`;
	const fromBlocks =
		firstTextFromAcpContentBlocks(content.content) ?? firstTextFromAcpContentBlocks(upd.content);
	if (fromBlocks) return truncate(fromBlocks, 800);
	for (const k of ["message", "text", "error", "result", "output"]) {
		const v = content[k] ?? upd[k];
		if (v == null) continue;
		if (typeof v === "string") return truncate(v, 800);
		if (typeof v === "object") return truncate(JSON.stringify(v), 800);
	}
	return formatToolDetail(content, upd) || "";
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
		const toolName = resolveToolDisplayName(upd, content, kind);
		const toolCallId = getToolCallId(content, upd);
		const isUpdate = kind === "tool_call_update" || kind.includes("update");
		const detail = isUpdate ? formatToolUpdateDetail(content, upd) : formatToolDetail(content, upd);
		return {
			type: "tool",
			sessionUpdateKind: kind || "tool",
			toolName,
			detail,
			toolCallId,
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
