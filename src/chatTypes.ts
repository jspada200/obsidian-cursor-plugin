/** JSON-serializable types for the Cursor Agent transcript and plugin data. */

export type ChatRole = "user" | "assistant" | "system" | "thought" | "tool_group" | "status";

export interface ToolEntry {
	/** Shown in the tool row header (e.g. `read_file`, `grep`) */
	label: string;
	/** Args, output, or status text */
	text: string;
	/** When present, `tool_call_update` merges into this entry */
	toolCallId?: string;
}

export interface ChatMessage {
	role: ChatRole;
	content: string;
	/** Consecutive tool calls merged into one turn */
	toolEntries?: ToolEntry[];
}

export interface ChatTabState {
	localId: string;
	acpSessionId: string | null;
	title: string;
	messages: ChatMessage[];
}
