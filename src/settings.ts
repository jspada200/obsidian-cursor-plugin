export type AgentMode = "agent" | "ask";

/** Maps legacy `plan` to `ask` and invalid values to `agent`. */
export function normalizeAgentMode(m: string | undefined): AgentMode {
	if (m === "ask" || m === "agent") return m;
	if (m === "plan") return "ask";
	return "agent";
}

export interface CursorAgentSettings {
	agentBinaryPath: string;
	extraAgentArgs: string;
	defaultMode: AgentMode;
	defaultModel: string;
	trustWorkspace: boolean;
	autoApprovePermissions: "never" | "allow_once_default" | "allow_always_shell";
	includeOpenTabs: boolean;
	includeLinkedNotes: boolean;
	maxContextLinks: number;
	maxContextTabs: number;
	/** Append diagnostics to cursor-agent.log under the plugin folder. */
	agentFileLog: boolean;
	/** Include longer RPC payloads and prompt excerpts in the log (may contain note text). */
	agentLogVerbose: boolean;
}

export const DEFAULT_SETTINGS: CursorAgentSettings = {
	agentBinaryPath: "",
	extraAgentArgs: "",
	defaultMode: "agent",
	defaultModel: "",
	trustWorkspace: true,
	autoApprovePermissions: "never",
	includeOpenTabs: true,
	includeLinkedNotes: true,
	maxContextLinks: 24,
	maxContextTabs: 16,
	agentFileLog: true,
	agentLogVerbose: false,
};
