import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { AgentFileLogger, revealAgentLogFile } from "./logging/agentFileLog";
import { DEFAULT_SETTINGS, type CursorAgentSettings } from "./settings";
import { CursorChatView, VIEW_TYPE_CURSOR_AGENT } from "./ui/CursorChatView";
import { CursorAgentSettingTab } from "./ui/CursorAgentSettingTab";

export interface PersistedChatTabs {
	tabs: Array<{ localId: string; acpSessionId: string | null; title: string }>;
	activeTabId: string | null;
}

interface PluginData {
	settings: CursorAgentSettings;
	chat?: PersistedChatTabs;
}

export class CursorAgentPlugin extends Plugin {
	settings: CursorAgentSettings = DEFAULT_SETTINGS;
	/** Latest tab metadata for persistence (hydrated from disk on load). */
	persistedSnapshot: PersistedChatTabs | undefined;
	/** File log for agent subprocess / ACP diagnostics (see settings). */
	agentLog!: AgentFileLogger;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.agentLog = new AgentFileLogger(this.app, this.manifest.id, () => this.settings);

		this.registerView(VIEW_TYPE_CURSOR_AGENT, (leaf: WorkspaceLeaf) => new CursorChatView(leaf, this));

		this.addRibbonIcon("message-circle", "Open Cursor Agent", () => void this.activateView());

		this.addCommand({
			id: "open-cursor-agent",
			name: "Open Cursor Agent chat",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "reveal-cursor-agent-log",
			name: "Reveal Cursor Agent log file",
			callback: () => revealAgentLogFile(this.app, this.manifest.id),
		});

		this.addSettingTab(new CursorAgentSettingTab(this.app, this));
	}

	onunload(): void {
		void this.saveData({
			settings: this.settings,
			...(this.persistedSnapshot ? { chat: this.persistedSnapshot } : {}),
		});
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Partial<PluginData> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw?.settings ?? {});
		this.persistedSnapshot = raw?.chat;
	}

	async saveSettings(): Promise<void> {
		await this.saveData({
			settings: this.settings,
			...(this.persistedSnapshot ? { chat: this.persistedSnapshot } : {}),
		});
	}

	async persistTabs(chat: PersistedChatTabs): Promise<void> {
		this.persistedSnapshot = chat;
		await this.saveData({
			settings: this.settings,
			chat,
		});
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_CURSOR_AGENT);
		if (leaves.length > 0) leaf = leaves[0] ?? null;
		else {
			leaf = workspace.getRightLeaf(false);
			if (leaf) await leaf.setViewState({ type: VIEW_TYPE_CURSOR_AGENT, active: true });
		}
		if (leaf) workspace.revealLeaf(leaf);
		else new Notice("Could not open Cursor Agent panel");
	}
}
