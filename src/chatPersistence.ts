import type { ChatMessage, ChatRole, TabTitleSource, ToolEntry } from "./chatTypes";

const CHAT_DATA_VERSION = 2;

const ROLES: ReadonlySet<ChatRole> = new Set([
	"user",
	"assistant",
	"system",
	"thought",
	"tool_group",
	"status",
]);

/**
 * Strips and validates data loaded from `data.json` (may be from older plugin versions).
 */
export function sanitizeChatMessages(input: unknown): ChatMessage[] {
	if (!Array.isArray(input)) return [];
	const out: ChatMessage[] = [];
	for (const item of input) {
		if (!item || typeof item !== "object") continue;
		const o = item as Record<string, unknown>;
		const r = o.role;
		if (typeof r !== "string" || !ROLES.has(r as ChatRole)) continue;
		const content = typeof o.content === "string" ? o.content : "";
		const m: ChatMessage = { role: r as ChatRole, content };
		if (o.toolEntries && Array.isArray(o.toolEntries)) {
			const te: ToolEntry[] = [];
			for (const e of o.toolEntries) {
				if (!e || typeof e !== "object") continue;
				const ex = e as Record<string, unknown>;
				if (typeof ex.label !== "string" || typeof ex.text !== "string") continue;
				const entry: ToolEntry = { label: ex.label, text: ex.text };
				if (typeof ex.toolCallId === "string") entry.toolCallId = ex.toolCallId;
				te.push(entry);
			}
			if (te.length) m.toolEntries = te;
		}
		out.push(m);
	}
	return out;
}

function isUuidLike(s: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		s
	);
}

/** Snapshots written to `data.json` (plugin folder). */
export function normalizePersistedChatData(raw: unknown): {
	tabs: Array<{
		localId: string;
		acpSessionId: string | null;
		title: string;
		tabTitleSource: TabTitleSource;
		messages: ChatMessage[];
	}>;
	activeTabId: string | null;
	version: number;
} {
	const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
	if (!o || !("tabs" in o)) {
		return { tabs: [], activeTabId: null, version: CHAT_DATA_VERSION };
	}
	const tabsIn = o.tabs;
	if (!Array.isArray(tabsIn)) {
		return { tabs: [], activeTabId: null, version: CHAT_DATA_VERSION };
	}
	function parseTabTitleSource(v: unknown): TabTitleSource {
		if (v === "default" || v === "auto" || v === "user") return v;
		return "user";
	}

	const tabs: Array<{
		localId: string;
		acpSessionId: string | null;
		title: string;
		tabTitleSource: TabTitleSource;
		messages: ChatMessage[];
	}> = [];
	for (const row of tabsIn) {
		if (!row || typeof row !== "object") continue;
		const t = row as Record<string, unknown>;
		const rawId = typeof t.localId === "string" ? t.localId.trim() : "";
		const localId = rawId && isUuidLike(rawId) ? rawId : crypto.randomUUID();
		const title =
			typeof t.title === "string" && t.title.length > 0
				? t.title
				: `Chat ${tabs.length + 1}`;
		const acpSessionId =
			t.acpSessionId === null || t.acpSessionId === undefined
				? null
				: typeof t.acpSessionId === "string"
					? t.acpSessionId
					: null;
		const messages = sanitizeChatMessages(t.messages);
		/* v1 data had no field — do not auto-rename on first message for existing tabs. */
		const tabTitleSource = parseTabTitleSource(t.tabTitleSource);
		tabs.push({ localId, title, acpSessionId, tabTitleSource, messages });
	}
	const activeTabId =
		typeof o.activeTabId === "string" && o.activeTabId.length > 0 ? o.activeTabId : null;
	/* Pick first tab if active is missing. */
	const valid =
		(activeTabId && tabs.some((t) => t.localId === activeTabId) ? activeTabId : null) ??
		tabs[0]?.localId ??
		null;
	return { tabs, activeTabId: valid, version: CHAT_DATA_VERSION };
}

export const CHAT_PERSISTENCE_VERSION = CHAT_DATA_VERSION;
