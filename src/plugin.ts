import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { AcpClient, type AcpConnectProgressPhase } from "./acp/client";
import { expandAgentPath, sanitizeModelId } from "./agentModels";
import { AgentFileLogger, revealAgentLogFile } from "./logging/agentFileLog";
import { DEFAULT_SETTINGS, type AgentMode, type CursorAgentSettings } from "./settings";
import { CursorChatView, VIEW_TYPE_CURSOR_AGENT } from "./ui/CursorChatView";
import { CursorAgentSettingTab } from "./ui/CursorAgentSettingTab";
import { getVaultOsPath } from "./util/vaultPath";
import type { ChatMessage, TabTitleSource } from "./chatTypes";
import { CHAT_PERSISTENCE_VERSION, normalizePersistedChatData } from "./chatPersistence";
import { buildPluginBootstrapContextText } from "./obsidianContextPreamble";
import { resolveAcpSessionIdFromUpdate } from "./acp/resolveSessionId";

export interface PersistedChatTabs {
	/** Bumped when the on-disk `chat` shape changes. */
	version: number;
	tabs: Array<{
		localId: string;
		acpSessionId: string | null;
		title: string;
		tabTitleSource: TabTitleSource;
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
	/** Awaited by `sendMessage` so prewarm + invisible bootstrap finish before a user turn. */
	private initialBootstrapChain: Promise<void> = Promise.resolve();
	/**
	 * Server session for `this.tabs[0]`, created on load after `session/new` + a hidden
	 * `session/prompt` — applied when the first tab has no `acpSessionId`.
	 */
	private stagedSessionForFirstTab: string | null = null;
	/** While set, `session/update` for this id is not rendered (invisible bootstrap reply). */
	private suppressUiForSessionId: string | null = null;

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
				onSessionUpdate: (params) => this.onAgentSessionUpdate(params),
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

	/** Invisible on-load `session/prompt` — not shown in the chat transcript. */
	private onAgentSessionUpdate(params: unknown): void {
		if (this.suppressUiForSessionId) {
			const sid = resolveAcpSessionIdFromUpdate(params);
			if (!sid || sid === this.suppressUiForSessionId) return;
		}
		this.acpChatView?.acpOnSessionUpdate(params);
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
			void this.saveData(this.buildPluginDataObjectForDisk());
		}
		this.stagedSessionForFirstTab = null;
		this.suppressUiForSessionId = null;
	}

	/**
	 * Connect, then `session/new` + hidden `session/prompt` (Obsidian context) for the
	 * first tab, before the user sends a message. Does not add anything to the transcript.
	 */
	private startAcpPrewarm(): void {
		this.agentLog.ui("startAcpPrewarm");
		const mode = this.settings.defaultMode;
		const model = sanitizeModelId(this.settings.defaultModel);
		this.initialBootstrapChain = (async () => {
			try {
				await this.ensureAcp(null, mode, model);
				await this.runPluginLoadSessionBootstrap();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				this.agentLog.line("prewarm/initial-chain/error", msg);
			}
		})();
	}

	/**
	 * ACP `session/new` + hidden `session/prompt` — same queue as `ensureAcp` so
	 * nothing interleaves with a concurrent reconnect.
	 */
	private runPluginLoadSessionBootstrap(): Promise<void> {
		return this.withAcpConnect(async () => {
			if (!this.acp?.isRunning()) return;
			const vaultRoot = getVaultOsPath(this.app);
			if (!vaultRoot) {
				this.agentLog.line("bootstrap/initial", "skip: no vault OS path");
				return;
			}
			const { sessionId } = await this.acp.sessionNew(vaultRoot);
			const vaultName = this.app.vault.getName();
			const text = buildPluginBootstrapContextText(vaultRoot, vaultName);
			this.suppressUiForSessionId = sessionId;
			let promptOk = false;
			try {
				this.agentLog.ui(`bootstrap/initial: session/prompt (hidden) sessionId=${sessionId}`);
				await this.acp.sessionPrompt(sessionId, [{ type: "text", text }]);
				promptOk = true;
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				this.agentLog.line("bootstrap/initial-prompt-error", msg);
			} finally {
				this.suppressUiForSessionId = null;
			}
			if (promptOk) {
				this.stagedSessionForFirstTab = sessionId;
				this.agentLog.ui(`bootstrap/initial: staged for first tab sessionId=${sessionId}`);
				this.acpChatView?.applyStagedSessionIdForFirstTabFromPlugin();
			}
		});
	}

	/**
	 * Resolves after the on-load ACP prewarm and optional invisible bootstrap, so
	 * `sendMessage` does not race a parallel `session/new` for the first tab.
	 */
	async waitForPrewarmAndInitialBootstrap(): Promise<void> {
		try {
			await this.initialBootstrapChain;
		} catch {
			/* `runPluginLoadSessionBootstrap` errors are logged; chat can still work */
		}
	}

	/**
	 * Picks up the server session for `tabs[0]` after plugin-load bootstrap. Returns
	 * the id once, then `null` (or `null` if there was no staged id).
	 */
	consumeStagedSessionForFirstTab(): string | null {
		const id = this.stagedSessionForFirstTab;
		if (!id) return null;
		this.stagedSessionForFirstTab = null;
		return id;
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
		this.stagedSessionForFirstTab = null;
		this.suppressUiForSessionId = null;
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
		/* In-memory `persistedSnapshot` can lag the view if the leaf unloads in an order
		 * that skips `onClose` — take the last open state from the chat view when possible. */
		if (this.acpChatView) {
			this.persistedSnapshot = this.acpChatView.buildPersistedChatTabs();
		}
		if (this.acp) {
			void this.acp.dispose();
			this.acp = null;
		}
		this.acpConnectQueue = Promise.resolve();
		this.setAcpConnectPhase("idle");
		this.stagedSessionForFirstTab = null;
		this.suppressUiForSessionId = null;
		this.setAcpChatView(null);
		void this.saveData(this.buildPluginDataObjectForDisk());
	}

	/**
	 * `saveData` overwrites the whole `data.json` in Obsidian — we must always include
	 * `chat` when we have something to keep, or settings-only saves will wipe history.
	 */
	private buildPluginDataObjectForDisk(): PluginData {
		const o: PluginData = { settings: this.settings };
		if (this.persistedSnapshot) {
			o.chat = { ...this.persistedSnapshot, version: CHAT_PERSISTENCE_VERSION };
		}
		return o;
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Partial<PluginData> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw?.settings ?? {});
		if (raw?.chat && typeof raw.chat === "object" && !Array.isArray(raw.chat)) {
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
		/* In-memory `persistedSnapshot` should match load, but re-merge from disk to avoid
		 * dropping `chat` if the reference was ever out of sync. */
		const from = ((await this.loadData()) as Partial<PluginData> | null) ?? {};
		const fromChat =
			from?.chat && typeof from.chat === "object" && !Array.isArray(from.chat)
				? (() => {
						const n = normalizePersistedChatData(from.chat);
						return {
							version: CHAT_PERSISTENCE_VERSION,
							tabs: n.tabs,
							activeTabId: n.activeTabId,
						} as PersistedChatTabs;
					})()
				: undefined;
		if (!this.persistedSnapshot && fromChat) {
			this.persistedSnapshot = fromChat;
		}
		await this.saveData(this.buildPluginDataObjectForDisk());
	}

	async persistTabs(chat: PersistedChatTabs): Promise<void> {
		this.persistedSnapshot = { ...chat, version: CHAT_PERSISTENCE_VERSION };
		await this.saveData(this.buildPluginDataObjectForDisk());
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
