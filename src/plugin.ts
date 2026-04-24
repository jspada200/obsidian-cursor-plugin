import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { AcpClient, type AcpConnectProgressPhase } from "./acp/client";
import { expandAgentPath, sanitizeModelId } from "./agentModels";
import { AgentFileLogger, revealAgentLogFile } from "./logging/agentFileLog";
import { DEFAULT_SETTINGS, type AgentMode, type CursorAgentSettings } from "./settings";
import { CursorChatView, VIEW_TYPE_CURSOR_AGENT } from "./ui/CursorChatView";
import { CursorAgentSettingTab } from "./ui/CursorAgentSettingTab";
import { getVaultOsPath } from "./util/vaultPath";
import type { ChatMessage } from "./chatTypes";
import { CHAT_PERSISTENCE_VERSION, normalizePersistedChatData } from "./chatPersistence";

export interface PersistedChatTabs {
	/** Bumped when the on-disk `chat` shape changes. */
	version: number;
	tabs: Array<{
		localId: string;
		acpSessionId: string | null;
		title: string;
		messages: ChatMessage[];
	}>;
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
	/**
	 * Shared ACP process — started on plugin load and reused across chat view opens
	 * until settings change or dispose.
	 */
	acp: AcpClient | null = null;
	/** Serialize spawn / initialize / authenticate. */
	private acpConnectQueue: Promise<void> = Promise.resolve();
	/** For permission / plan / ask UI. Null while panel is closed. */
	private acpChatView: CursorChatView | null = null;
	/**
	 * ACP load state (aligned with AcpClient `onConnectProgress` and `cursor-agent.log`):
	 * `spawn` → `initialize` → `authenticate` → `ready`.
	 */
	private acpConnectPhase: AcpConnectProgressPhase | "idle" = "idle";

	/** @internal — chat view calls on open/close. */
	setAcpChatView(view: CursorChatView | null): void {
		this.acpChatView = view;
		if (view) {
			view.syncLoadBanner();
		}
	}

	getAcpConnectPhase(): AcpConnectProgressPhase | "idle" {
		return this.acpConnectPhase;
	}

	private setAcpConnectPhase(phase: AcpConnectProgressPhase | "idle"): void {
		this.acpConnectPhase = phase;
		this.acpChatView?.syncLoadBanner();
	}

	private withAcpConnect<T>(work: () => Promise<T>): Promise<T> {
		const run = this.acpConnectQueue.then(work);
		this.acpConnectQueue = run.then(
			() => {},
			() => {}
		);
		return run;
	}

	private createAcpClient(): AcpClient {
		return new AcpClient(
			{
				onSessionUpdate: (params) => this.acpChatView?.acpOnSessionUpdate(params),
				onPermissionRequest: (params, respond) => {
					if (this.acpChatView) this.acpChatView.acpOnPermissionRequest(params, respond);
					else {
						/* Prewarm before panel open — mirror auto-approve or fail closed. */
						const pol = this.settings.autoApprovePermissions;
						if (pol === "allow_once_default") {
							respond({ outcome: { outcome: "selected", optionId: "allow-once" } });
							return;
						}
						if (pol === "allow_always_shell") {
							respond({ outcome: { outcome: "selected", optionId: "allow-always" } });
							return;
						}
						respond({ outcome: { outcome: "selected", optionId: "reject-once" } });
					}
				},
				onCursorCreatePlan: (params, respond) => {
					if (this.acpChatView) this.acpChatView.acpOnCreatePlan(params, respond);
					else respond({ outcome: { outcome: "rejected", reason: "Cursor Agent panel is not open" } });
				},
				onCursorAskQuestion: (params, respond) => {
					if (this.acpChatView) this.acpChatView.acpOnAskQuestion(params, respond);
					else
						respond({
							outcome: {
								outcome: "answered",
								answers: [] as { questionId: string; optionIds: string[] }[],
							},
						});
				},
				onStderrLine: (line) => console.warn("[cursor-agent stderr]", line),
				onConnectProgress: (phase) => {
					this.setAcpConnectPhase(phase);
				},
			},
			this.agentLog
		);
	}

	/**
	 * Ensures a running `agent … acp` process (reuses the same one until disposed).
	 * @param view — if open, used for post-spawn session id invalidation; can be null during preload.
	 */
	async ensureAcp(view: CursorChatView | null, mode: AgentMode, model: string): Promise<void> {
		if (this.acp?.isRunning()) return;
		return this.withAcpConnect(async () => {
			if (this.acp?.isRunning()) return;

			const vaultRoot = getVaultOsPath(this.app);
			if (!vaultRoot) {
				new Notice("Vault path unavailable — desktop vault required.");
				throw new Error("No vault OS path");
			}
			this.agentLog.ui(
				`ensureAcp spawn mode=${mode} model=${model || "(default)"} vault=${vaultRoot} view=${view ? "yes" : "no"}`
			);
			if (!this.acp) this.acp = this.createAcpClient();
			await this.acp.spawn({
				agentPath: expandAgentPath(this.settings.agentBinaryPath),
				workspaceRoot: vaultRoot,
				mode,
				model,
				trustWorkspace: this.settings.trustWorkspace,
				extraArgs: this.settings.extraAgentArgs
					.split(/\s+/)
					.map((s) => s.trim())
					.filter(Boolean),
			});
			this.clearAcpSessionIdsFromDiskAndView(view);
			this.agentLog.ui("ensureAcp: cleared tab session IDs after spawn (new agent process)");
		});
	}

	private clearAcpSessionIdsFromDiskAndView(view: CursorChatView | null): void {
		if (view) {
			for (const t of view.tabs) t.acpSessionId = null;
			void view.flushPersist();
		}
		if (this.acpChatView) {
			for (const t of this.acpChatView.tabs) t.acpSessionId = null;
			void this.acpChatView.flushPersist();
		}
		if (this.persistedSnapshot?.tabs?.length) {
			for (const t of this.persistedSnapshot.tabs) t.acpSessionId = null;
			void this.saveData({ settings: this.settings, chat: this.persistedSnapshot });
		}
	}

	/** Prewarm using default mode/model from settings (same as a fresh panel). */
	private startAcpPrewarm(): void {
		this.agentLog.ui("startAcpPrewarm");
		const mode = this.settings.defaultMode;
		const model = sanitizeModelId(this.settings.defaultModel);
		void this.ensureAcp(null, mode, model).catch((e) => {
			const msg = e instanceof Error ? e.message : String(e);
			this.agentLog.line("prewarm/error", msg);
		});
	}

	/** For mode/model changes: restart agent and drop sessions. */
	async disposeAcp(): Promise<void> {
		await this.acpConnectQueue;
		if (this.acp) {
			await this.acp.dispose();
			this.acp = null;
		}
		this.acpConnectQueue = Promise.resolve();
		this.setAcpConnectPhase("idle");
	}

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
		this.startAcpPrewarm();
	}

	onunload(): void {
		if (this.acp) {
			void this.acp.dispose();
			this.acp = null;
		}
		this.acpConnectQueue = Promise.resolve();
		this.setAcpConnectPhase("idle");
		this.setAcpChatView(null);
		void this.saveData({
			settings: this.settings,
			...(this.persistedSnapshot ? { chat: this.persistedSnapshot } : {}),
		});
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Partial<PluginData> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw?.settings ?? {});
		if (raw?.chat && typeof raw.chat === "object") {
			const n = normalizePersistedChatData(raw.chat);
			this.persistedSnapshot = {
				version: CHAT_PERSISTENCE_VERSION,
				tabs: n.tabs,
				activeTabId: n.activeTabId,
			};
		} else {
			this.persistedSnapshot = undefined;
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData({
			settings: this.settings,
			...(this.persistedSnapshot ? { chat: this.persistedSnapshot } : {}),
		});
	}

	async persistTabs(chat: PersistedChatTabs): Promise<void> {
		this.persistedSnapshot = { ...chat, version: CHAT_PERSISTENCE_VERSION };
		await this.saveData({
			settings: this.settings,
			chat: this.persistedSnapshot,
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
