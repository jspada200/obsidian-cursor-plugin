import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import { buildVaultContextBlock, searchNotesByNameOrTag } from "../context/buildContext";
import type { CursorAgentPlugin, PersistedChatTabs } from "../plugin";
import type { AgentMode } from "../settings";
import { CreatePlanModal, PermissionModal, AskQuestionModal } from "./modals";
import type { PermissionChoice } from "./modals";
import { getVaultOsPath } from "../util/vaultPath";
import {
	type ModelOption,
	expandAgentPath,
	fetchAvailableModels,
	sanitizeModelId,
} from "../agentModels";
import { parseSessionUpdateForDisplay } from "../session/sessionUpdateDisplay";
import { CHAT_PERSISTENCE_VERSION } from "../chatPersistence";
import { resolveAcpSessionIdFromUpdate } from "../acp/resolveSessionId";
import type { ChatMessage, ChatTabState, TabTitleSource, ToolEntry } from "../chatTypes";
import {
	copyToClipboard,
	createMarkdownNoteAtRoot,
	formatSessionAsMarkdown,
} from "../util/chatNoteExport";
import { titleFromFirstUserMessage } from "../util/tabTitle";
import { expandVaultNoteLineMarkers, tryOpenTranscriptVaultLink } from "../util/assistantVaultLinks";

export const VIEW_TYPE_CURSOR_AGENT = "cursor-agent-chat-view";

export type { ChatMessage, ChatTabState, ToolEntry, ChatRole, TabTitleSource } from "../chatTypes";

export class CursorChatView extends ItemView {
	tabs: ChatTabState[] = [];
	activeTabId: string | null = null;
	mode: AgentMode = "agent";
	model: string = "";
	modelOptions: ModelOption[] = [];
	private composeEl: HTMLTextAreaElement | null = null;
	private transcriptEl: HTMLDivElement | null = null;
	private tabsRowEl: HTMLDivElement | null = null;
	private mentionEl: HTMLDivElement | null = null;
	private mentionStart = -1;
	private modelSelectRef: HTMLSelectElement | null = null;
	private modeSelectRef: HTMLSelectElement | null = null;
	private transcriptRenderPending = false;
	/** Filled when panel is open; top-of-chat load / working banner. */
	private loadBannerEl: HTMLDivElement | null = null;
	private loadBannerLabelEl: HTMLSpanElement | null = null;
	/** Shown when ACP is ready but session/new or session/prompt is still in progress (matches log: rpc send session/new, then session/prompt, then first session/update). */
	private requestPhase: "none" | "session_new" | "awaiting_first_reply" = "none";
	/** Cleared on first non-skip session/update for this session after a prompt. */
	private pendingFirstReplySessionId: string | null = null;
	private persistDebounceHandle = 0;
	/** When set, `renderTabs` shows an input for this tab (double-click to rename). */
	private editingTabId: string | null = null;

	constructor(leaf: WorkspaceLeaf, readonly plugin: CursorAgentPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_CURSOR_AGENT;
	}

	getDisplayText(): string {
		return "Cursor Agent";
	}

	getIcon(): string {
		return "message-circle";
	}

	async onOpen(): Promise<void> {
		this.plugin.setAcpChatView(this);
		this.mode = this.plugin.settings.defaultMode;
		this.model = sanitizeModelId(this.plugin.settings.defaultModel);

		/* Always rehydrate from the plugin’s snapshot (from disk) — do not require empty in-memory
		 * `tabs` or a stale single-open session would never reload from data.json. */
		const snap = this.plugin.persistedSnapshot;
		if (snap?.tabs?.length) {
			this.tabs = snap.tabs.map((t) => cloneTabWithMessages(t as ChatTabState));
			this.activeTabId = snap.activeTabId ?? this.tabs[0]?.localId ?? null;
		}

		const root = this.containerEl.children[1];
		root.empty();
		root.addClass("cursor-agent-root");

		const topbar = root.createDiv({ cls: "cursor-agent-topbar" });
		this.tabsRowEl = topbar.createDiv({ cls: "cursor-agent-tabs-row" });
		topbar.createEl("button", { cls: "cursor-agent-topbar-btn", attr: { "aria-label": "Save whole session as note", type: "button" } }, (b) => {
			setIcon(b, "download");
			b.addEventListener("click", () => void this.saveSessionAsNote());
		});
		topbar.createEl("button", { cls: "cursor-agent-topbar-btn", attr: { "aria-label": "New chat", type: "button" } }, (b) => {
			setIcon(b, "plus");
			b.addEventListener("click", () => this.addTab());
		});

		const loadLane = root.createDiv({ cls: "cursor-agent-load-lane" });
		this.loadBannerEl = loadLane.createDiv({ cls: "cursor-agent-load-banner is-hidden" });
		this.loadBannerLabelEl = this.loadBannerEl.createSpan({ cls: "cursor-agent-load-banner-label" });
		/* Prewarm or reconnect may be in progress before first send — show steps from the same ACP phase signals as cursor-agent.log */
		this.syncLoadBanner();

		this.transcriptEl = root.createDiv({ cls: "cursor-agent-transcript" });

		const composerWrap = root.createDiv({ cls: "cursor-agent-composer-outer" });
		const surface = composerWrap.createDiv({ cls: "cursor-agent-composer-surface" });
		this.mentionEl = surface.createDiv({ cls: "cursor-agent-mention-popover hidden" });
		this.composeEl = surface.createEl("textarea", {
			cls: "cursor-agent-composer-input",
			attr: { placeholder: "Message, @ to mention a note" },
		});
		this.composeEl.addEventListener("input", () => {
			this.adjustComposerHeight();
			this.onComposerInput();
		});
		this.composeEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				void this.sendMessage();
			}
		});

		const composerFooter = surface.createDiv({ cls: "cursor-agent-composer-footer" });
		const footerLeft = composerFooter.createDiv({ cls: "cursor-agent-composer-footer-left" });
		this.modeSelectRef = footerLeft.createEl("select", { cls: "cursor-agent-pill-select" });
		for (const m of ["agent", "plan", "ask"] as const) {
			this.modeSelectRef.createEl("option", { text: m, value: m });
		}
		this.modeSelectRef.value = this.mode;
		this.modeSelectRef.addEventListener("change", async () => {
			if (!this.modeSelectRef) return;
			this.mode = this.modeSelectRef.value as AgentMode;
			await this.onModeOrModelChanged();
		});

		this.modelSelectRef = footerLeft.createEl("select", { cls: "cursor-agent-pill-select cursor-agent-pill-select-wide" });
		this.modelSelectRef.addEventListener("change", async () => {
			if (!this.modelSelectRef) return;
			this.model = this.modelSelectRef.value;
			await this.onModeOrModelChanged();
		});
		void this.refreshModelDropdown(this.modelSelectRef);

		footerLeft.createEl("button", { cls: "cursor-agent-refresh-models", text: "Refresh", attr: { type: "button" } }, (b) => {
			b.addEventListener("click", () => {
				if (this.modelSelectRef) void this.refreshModelDropdown(this.modelSelectRef);
			});
		});

		composerFooter.createEl("button", {
			cls: "cursor-agent-send-fab",
			attr: { type: "button", "aria-label": "Send" },
		}, (b) => {
			setIcon(b, "arrow-up");
			b.addEventListener("click", () => void this.sendMessage());
		});

		if (this.tabs.length === 0) this.addTab(false);
		else this.renderTabs();
		this.renderTranscript();
		this.adjustComposerHeight();
		this.applyStagedSessionIdForFirstTabFromPlugin();
	}

	/**
	 * Binds the plugin-load ACP `sessionId` to `tabs[0]` (hidden bootstrap + session ready
	 * before the user’s first message).
	 */
	applyStagedSessionIdForFirstTabFromPlugin(): void {
		const t = this.tabs[0];
		if (!t || t.acpSessionId) return;
		const id = this.plugin.consumeStagedSessionForFirstTab();
		if (!id) return;
		t.acpSessionId = id;
		void this.flushPersist();
	}

	/**
	 * ACP connect phase + in-flight `session/new` and `session/prompt` (plugin calls this
	 * after `onConnectProgress`). Always reads current state from the plugin and `requestPhase`.
	 */
	syncLoadBanner(): void {
		const el = this.loadBannerEl;
		const label = this.loadBannerLabelEl;
		if (!el || !label) return;
		const acp = this.plugin.getAcpConnectPhase();
		/* 1) Handshake / process errors (cursor-agent.log: spawn, initialize, authenticate) */
		if (acp !== "idle" && acp !== "ready") {
			el.removeClass("is-hidden");
			el.setAttribute("aria-hidden", "false");
			if (acp === "spawning")
				label.setText(
					"Starting the Cursor Agent process… (log: [spawn])"
				);
			else if (acp === "initializing")
				label.setText(
					"Connecting: protocol initialize… (log: rpc/send method=initialize)"
				);
			else if (acp === "authenticating")
				label.setText("Authenticating with Cursor… (log: authenticate, cursor_login)");
			else if (acp === "error")
				label.setText(
					"Connection failed — check cursor-agent.log, then try again or change mode/model to reconnect."
				);
			else label.setText("Connecting to Cursor Agent…");
			el.toggleClass("is-error", acp === "error");
			el.toggleClass("is-pending", acp !== "error");
			return;
		}
		/* 2) First message path after handshake: session/new, then time until first streamed update */
		if (acp === "ready" && this.requestPhase === "session_new") {
			el.removeClass("is-hidden");
			el.setAttribute("aria-hidden", "false");
			label.setText(
				"Creating a chat session (session/new in the log). Usually quick…"
			);
			el.toggleClass("is-error", false);
			el.toggleClass("is-pending", true);
			return;
		}
		if (acp === "ready" && this.requestPhase === "awaiting_first_reply") {
			el.removeClass("is-hidden");
			el.setAttribute("aria-hidden", "false");
			label.setText(
				"Work in progress: your message is sent (session/prompt in the log). " +
					"The first model reply often takes 20–60s while the agent and model start — this is normal. " +
					"Streaming will appear here when the first update arrives (session/update)."
			);
			el.toggleClass("is-error", false);
			el.toggleClass("is-pending", true);
			return;
		}
		el.addClass("is-hidden");
		el.setAttribute("aria-hidden", "true");
		label.setText("");
		el.toggleClass("is-error", false);
		el.toggleClass("is-pending", false);
	}

	private setRequestPhase(phase: "none" | "session_new" | "awaiting_first_reply"): void {
		this.requestPhase = phase;
		if (phase === "none") {
			this.pendingFirstReplySessionId = null;
		}
		this.plugin.agentLog.line("ui/request-banner", `phase=${phase}`);
		this.syncLoadBanner();
	}

	private adjustComposerHeight(): void {
		const el = this.composeEl;
		if (!el) return;
		el.style.height = "auto";
		const max = 200;
		const min = 44;
		el.style.height = `${Math.min(max, Math.max(min, el.scrollHeight))}px`;
	}

	async onModeOrModelChanged(): Promise<void> {
		await this.resetAcpSessions("Connection settings changed — starting new agent process.");
	}

	private async resetAcpSessions(reason: string): Promise<void> {
		this.setRequestPhase("none");
		await this.plugin.disposeAcp();
		for (const t of this.tabs) t.acpSessionId = null;
		void this.flushPersist();
		new Notice(reason);
	}

	private async refreshModelDropdown(select: HTMLSelectElement): Promise<void> {
		const agentPath = expandAgentPath(this.plugin.settings.agentBinaryPath);
		this.plugin.agentLog.line("models", `refreshModelDropdown binary=${agentPath}`);
		this.modelOptions = await fetchAvailableModels(agentPath, this.plugin.agentLog);
		const prev = sanitizeModelId(this.model || this.plugin.settings.defaultModel);
		select.empty();
		select.createEl("option", { text: "(Cursor default)", value: "" });
		const ids = new Set(this.modelOptions.map((m) => m.id));
		for (const m of this.modelOptions) {
			select.createEl("option", { text: m.label, value: m.id });
		}
		if (prev && ids.has(prev)) select.value = prev;
		else if (prev) {
			select.createEl("option", {
				text: `${prev} (not in latest list)`,
				value: prev,
			});
			select.value = prev;
		}
	}

	addTab(focus = true): void {
		const localId = crypto.randomUUID();
		const n = this.tabs.length + 1;
		this.tabs.push({
			localId,
			acpSessionId: null,
			title: `Chat ${n}`,
			tabTitleSource: "default",
			messages: [],
		});
		this.activeTabId = localId;
		this.renderTabs();
		this.renderTranscript();
		void this.flushPersist();
		if (focus) new Notice("New chat");
	}

	private closeTab(localId: string): void {
		if (this.tabs.length <= 1) {
			new Notice("Keep at least one tab");
			return;
		}
		if (this.editingTabId === localId) this.editingTabId = null;
		this.tabs = this.tabs.filter((t) => t.localId !== localId);
		if (this.activeTabId === localId) this.activeTabId = this.tabs[0]?.localId ?? null;
		this.renderTabs();
		this.renderTranscript();
		void this.flushPersist();
	}

	private activeTab(): ChatTabState | null {
		return this.tabs.find((t) => t.localId === this.activeTabId) ?? null;
	}

	private startTabRename(localId: string): void {
		this.editingTabId = localId;
		this.activeTabId = localId;
		this.renderTabs();
		this.renderTranscript();
	}

	private commitTabRename(localId: string, value: string): void {
		if (this.editingTabId !== localId) return;
		this.editingTabId = null;
		const t = this.tabs.find((x) => x.localId === localId);
		if (t) {
			const s = value.trim();
			if (s.length > 0) t.title = s;
			t.tabTitleSource = "user";
		}
		this.renderTabs();
		void this.flushPersist();
	}

	private cancelTabRename(): void {
		this.editingTabId = null;
		this.renderTabs();
	}

	private renderTabs(): void {
		if (!this.tabsRowEl) return;
		this.tabsRowEl.empty();
		for (const t of this.tabs) {
			if (t.localId === this.editingTabId) {
				const input = this.tabsRowEl.createEl("input", {
					cls:
						"cursor-agent-tab-pill cursor-agent-tab-input" +
						(t.localId === this.activeTabId ? " is-active" : ""),
					attr: {
						type: "text",
						"aria-label": "Chat title",
					},
					value: t.title,
				});
				input.addEventListener("click", (e) => e.stopPropagation());
				input.addEventListener("blur", () => {
					if (this.editingTabId === t.localId) {
						this.commitTabRename(t.localId, input.value);
					}
				});
				input.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						input.blur();
					} else if (e.key === "Escape") {
						e.preventDefault();
						this.cancelTabRename();
					}
				});
				continue;
			}
			const wrap = this.tabsRowEl.createDiv({ cls: "cursor-agent-tab-wrap" });
			const tab = wrap.createEl("button", {
				cls:
					"cursor-agent-tab-pill" +
					(t.localId === this.activeTabId ? " is-active" : "") +
					(this.tabs.length > 1 ? " has-hover-close" : ""),
				text: t.title,
				attr: { type: "button" },
			});
			tab.addEventListener("click", (e) => {
				if (e.shiftKey) {
					this.closeTab(t.localId);
					return;
				}
				/* Second click of a double-click: rename, do not re-fire as switch. */
				if (e.detail === 2) {
					e.preventDefault();
					this.startTabRename(t.localId);
					return;
				}
				this.activeTabId = t.localId;
				this.renderTabs();
				this.renderTranscript();
				void this.flushPersist();
			});
			if (this.tabs.length > 1) {
				const closeBtn = wrap.createEl("button", {
					cls: "cursor-agent-tab-close",
					attr: { type: "button", "aria-label": "Close tab" },
				});
				setIcon(closeBtn, "x");
				closeBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					e.preventDefault();
					this.closeTab(t.localId);
				});
			}
		}
		if (this.editingTabId) {
			requestAnimationFrame(() => {
				const inp = this.tabsRowEl?.querySelector<HTMLInputElement>("input.cursor-agent-tab-input");
				if (inp) {
					inp.focus();
					inp.select();
				}
			});
		}
	}

	private queueRenderTranscript(): void {
		if (this.transcriptRenderPending) return;
		this.transcriptRenderPending = true;
		window.requestAnimationFrame(() => {
			this.transcriptRenderPending = false;
			void this.renderTranscriptImpl();
			this.scheduleFlushPersist();
		});
	}

	private scheduleFlushPersist(): void {
		window.clearTimeout(this.persistDebounceHandle);
		this.persistDebounceHandle = window.setTimeout(() => {
			this.persistDebounceHandle = 0;
			void this.flushPersist();
		}, 900);
	}

	private renderTranscript(): void {
		void this.renderTranscriptImpl();
	}

	/**
	 * Resolves markdown links in the chat transcript as vault-root-relative (not relative to
	 * whatever note is currently focused) so `VAULT:` / `[[...]]` / `[](path.md)` open the right file.
	 */
	private transcriptMarkdownSourcePath(): string {
		return "";
	}

	private async saveSessionAsNote(): Promise<void> {
		const tab = this.activeTab();
		if (!tab) return;
		if (tab.messages.length === 0) {
			new Notice("Nothing to save in this chat.");
			return;
		}
		try {
			const body = formatSessionAsMarkdown(tab);
			const file = await createMarkdownNoteAtRoot(this.app, tab.title, body);
			const leaf = this.app.workspace.getLeaf("tab");
			await leaf.openFile(file);
			new Notice(`Session saved: ${file.path}`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Could not save note: ${msg}`, 12000);
		}
	}

	private async saveAssistantResponseAsNote(assistantMarkdown: string): Promise<void> {
		const tab = this.activeTab();
		if (!tab) return;
		if (!assistantMarkdown.trim()) {
			new Notice("Empty response — nothing to save.");
			return;
		}
		try {
			const file = await createMarkdownNoteAtRoot(this.app, tab.title, assistantMarkdown);
			const leaf = this.app.workspace.getLeaf("tab");
			await leaf.openFile(file);
			new Notice(`Saved: ${file.path}`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Could not save note: ${msg}`, 12000);
		}
	}

	private async renderTranscriptImpl(): Promise<void> {
		if (!this.transcriptEl) return;
		this.transcriptEl.empty();
		const tab = this.activeTab();
		if (!tab) return;
		const sourcePath = this.transcriptMarkdownSourcePath();

		for (const m of tab.messages) {
			const turn = this.transcriptEl.createDiv({
				cls: "cursor-agent-turn cursor-agent-turn-" + m.role,
			});
			const bubble = turn.createDiv({ cls: "cursor-agent-bubble" });

			if (m.role === "assistant") {
				const raw = m.content;
				const toRender = expandVaultNoteLineMarkers(raw);
				const shell = bubble.createDiv({ cls: "cursor-agent-assistant-shell" });
				const toolbar = shell.createDiv({ cls: "cursor-agent-msg-toolbar" });
				toolbar.createEl("button", { cls: "cursor-agent-msg-toolbtn", attr: { type: "button", "aria-label": "Copy this response" } }, (b) => {
					setIcon(b, "copy");
					b.addEventListener("click", (ev) => {
						ev.stopPropagation();
						void copyToClipboard(raw)
							.then(() => new Notice("Copied to clipboard"))
							.catch((err) =>
								new Notice(
									`Copy failed: ${err instanceof Error ? err.message : String(err)}`,
									8000
								)
							);
					});
				});
				toolbar.createEl("button", { cls: "cursor-agent-msg-toolbtn", attr: { type: "button", "aria-label": "Save this response as a new note" } }, (b) => {
					setIcon(b, "file-plus");
					b.addEventListener("click", (ev) => {
						ev.stopPropagation();
						void this.saveAssistantResponseAsNote(raw);
					});
				});
				const md = shell.createDiv({ cls: "cursor-agent-md markdown-rendered" });
				await MarkdownRenderer.render(this.app, toRender, md, sourcePath, this);
				this.registerDomEvent(
					md,
					"click",
					(e: MouseEvent) => {
						tryOpenTranscriptVaultLink(e, this.app, sourcePath);
					},
					{ capture: true }
				);
				continue;
			}

			if (m.role === "thought") {
				const details = bubble.createEl("details", { cls: "cursor-agent-thought-details" });
				details.createEl("summary", { cls: "cursor-agent-thought-summary", text: "Thinking" });
				const body = details.createDiv({ cls: "cursor-agent-thought-body markdown-rendered" });
				const thoughtRender = expandVaultNoteLineMarkers(m.content);
				await MarkdownRenderer.render(this.app, thoughtRender, body, sourcePath, this);
				this.registerDomEvent(
					body,
					"click",
					(e: MouseEvent) => {
						tryOpenTranscriptVaultLink(e, this.app, sourcePath);
					},
					{ capture: true }
				);
				continue;
			}

			if (m.role === "tool_group" && m.toolEntries && m.toolEntries.length > 0) {
				const entries = m.toolEntries;
				const n = entries.length;
				const last = entries[entries.length - 1];
				const summaryText =
					n === 1
						? `Tools — ${last.label}`
						: `Tools (${n}) — ${last.label}`;
				const det = bubble.createEl("details", { cls: "cursor-agent-tool-details" });
				det.createEl("summary", { cls: "cursor-agent-tool-summary", text: summaryText });
				const list = det.createDiv({ cls: "cursor-agent-tool-group-list" });
				for (const e of entries) {
					const row = list.createDiv({ cls: "cursor-agent-tool-row" });
					row.createEl("div", { cls: "cursor-agent-tool-row-label", text: e.label });
					if (e.text?.trim()) {
						row.createEl("div", { cls: "cursor-agent-tool-row-body", text: e.text });
					}
				}
				continue;
			}

			bubble.createEl("div", { cls: "cursor-agent-bubble-content", text: m.content });
		}

		this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
	}

	private onComposerInput(): void {
		const el = this.composeEl;
		const pop = this.mentionEl;
		if (!el || !pop) return;
		const pos = el.selectionStart;
		const text = el.value.slice(0, pos);
		const at = text.lastIndexOf("@");
		if (at < 0 || (at > 0 && !/\s/.test(text[at - 1]))) {
			pop.addClass("hidden");
			return;
		}
		const q = text.slice(at + 1);
		if (/\s/.test(q)) {
			pop.addClass("hidden");
			return;
		}
		this.mentionStart = at;
		pop.removeClass("hidden");
		pop.empty();
		const hits = searchNotesByNameOrTag(this.app, q, 12);
		if (hits.length === 0) {
			pop.createDiv({ text: "No matches", cls: "cursor-agent-mention-empty" });
			return;
		}
		for (const f of hits) {
			const row = pop.createDiv({ cls: "cursor-agent-mention-item", text: f.path });
			row.addEventListener("click", () => this.insertMention(f.path));
		}
	}

	private insertMention(path: string): void {
		const el = this.composeEl;
		const pop = this.mentionEl;
		if (!el || !pop || this.mentionStart < 0) return;
		const before = el.value.slice(0, this.mentionStart);
		const after = el.value.slice(el.selectionStart);
		const insert = `@${path} `;
		el.value = before + insert + after;
		const caret = (before + insert).length;
		el.setSelectionRange(caret, caret);
		pop.addClass("hidden");
		this.mentionStart = -1;
	}

	private extractMentionPaths(text: string): Set<string> {
		const set = new Set<string>();
		const re = /@(\S+)/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			const p = m[1];
			if (this.app.vault.getAbstractFileByPath(p)) set.add(p);
		}
		return set;
	}

	/** @internal — ACP JSON-RPC; forwards from CursorAgentPlugin. */
	acpOnPermissionRequest(params: unknown, respond: (r: unknown) => void): void {
		let summary = "";
		try {
			summary = typeof params === "string" ? params : JSON.stringify(params, null, 2);
		} catch {
			summary = String(params);
		}

		let auto: PermissionChoice | null = null;
		const pol = this.plugin.settings.autoApprovePermissions;
		if (pol === "allow_once_default") auto = "allow-once";
		if (pol === "allow_always_shell") auto = "allow-always";

		const finish = (choice: PermissionChoice) => {
			respond({
				outcome: { outcome: "selected", optionId: choice },
			});
		};

		if (auto) {
			finish(auto);
			return;
		}

		const modal = new PermissionModal(this.app, summary, (choice) => finish(choice));
		modal.open();
	}

	/** @internal */
	acpOnCreatePlan(params: unknown, respond: (r: unknown) => void): void {
		const p = params as {
			overview?: string;
			plan?: string;
			name?: string;
		};
		const modal = new CreatePlanModal(
			this.app,
			p?.overview ?? "",
			p?.plan ?? "",
			(accepted) => {
				if (accepted) respond({ outcome: { outcome: "accepted" } });
				else respond({ outcome: { outcome: "rejected", reason: "User rejected plan" } });
			}
		);
		modal.open();
	}

	/** @internal */
	acpOnAskQuestion(params: unknown, respond: (r: unknown) => void): void {
		const p = params as {
			title?: string;
			questions?: Array<{
				id: string;
				prompt: string;
				options: Array<{ id: string; label: string }>;
				allowMultiple?: boolean;
			}>;
		};
		const qs = p.questions ?? [];
		const modal = new AskQuestionModal(this.app, p.title, qs, (answers) => {
			respond({
				outcome: {
					outcome: "answered",
					answers,
				},
			});
		});
		modal.open();
	}

	private appendAssistantChunk(tab: ChatTabState, text: string): void {
		const last = tab.messages[tab.messages.length - 1];
		if (!last || last.role !== "assistant") {
			tab.messages.push({ role: "assistant", content: text });
		} else {
			last.content += text;
		}
	}

	private appendThoughtChunk(tab: ChatTabState, text: string): void {
		const last = tab.messages[tab.messages.length - 1];
		if (!last || last.role !== "thought") {
			tab.messages.push({ role: "thought", content: text });
		} else {
			last.content += text;
		}
	}

	private applyToolEvent(
		tab: ChatTabState,
		args: {
			kind: string;
			toolName: string;
			detail: string;
			toolCallId?: string;
		}
	): void {
		const lastMsg = tab.messages[tab.messages.length - 1];
		const inGroup = lastMsg?.role === "tool_group" && lastMsg.toolEntries?.length;

		const isUpdate = args.kind === "tool_call_update" || args.kind.includes("update");

		/** Append detail lines into an existing tool row */
		const appendDetail = (e: ToolEntry, extra: string) => {
			const t = extra.trim();
			if (!t) return;
			e.text = e.text ? `${e.text}\n${t}`.trim() : t;
		};

		if (isUpdate) {
			if (inGroup) {
				const te = lastMsg.toolEntries!;
				let target: ToolEntry | undefined;
				if (args.toolCallId) {
					for (let i = te.length - 1; i >= 0; i--) {
						if (te[i].toolCallId === args.toolCallId) {
							target = te[i];
							break;
						}
					}
				}
				if (!target) target = te[te.length - 1];
				if (args.toolName && args.toolName !== "…") target.label = args.toolName;
				if (args.toolCallId) target.toolCallId = target.toolCallId ?? args.toolCallId;
				appendDetail(target, args.detail);
				return;
			}
			/* Orphaned update: still show the payload */
			tab.messages.push({
				role: "tool_group",
				content: "",
				toolEntries: [
					{
						label: args.toolName && args.toolName !== "…" ? args.toolName : "tool (update)",
						text: args.detail,
						toolCallId: args.toolCallId,
					},
				],
			});
			return;
		}

		const entry: ToolEntry = {
			label: args.toolName,
			text: args.detail,
			toolCallId: args.toolCallId,
		};

		if (lastMsg?.role === "tool_group" && lastMsg.toolEntries) {
			/* New `tool_call` after prior tools in the same run — keep one group */
			lastMsg.toolEntries.push(entry);
		} else {
			tab.messages.push({ role: "tool_group", content: "", toolEntries: [entry] });
		}
	}

	/** @internal */
	acpOnSessionUpdate(params: unknown): void {
		const sid = resolveAcpSessionIdFromUpdate(params);
		let tab: ChatTabState | null;
		if (sid) {
			tab = this.tabs.find((t) => t.acpSessionId === sid) ?? null;
			/* No tab bound to this session yet (should be rare; bootstrap is suppressed in the plugin). */
			if (!tab) return;
		} else {
			tab = this.activeTab() ?? null;
			if (!tab) return;
		}

		const ev = parseSessionUpdateForDisplay(params);
		if (this.pendingFirstReplySessionId) {
			const match =
				(sid && sid === this.pendingFirstReplySessionId) ||
				(!sid && this.activeTab()?.acpSessionId === this.pendingFirstReplySessionId);
			if (match && ev.type !== "skip") {
				this.setRequestPhase("none");
			}
		}
		switch (ev.type) {
			case "skip":
				return;
			case "assistant":
				this.appendAssistantChunk(tab, ev.text);
				break;
			case "thought":
				this.appendThoughtChunk(tab, ev.text);
				break;
			case "tool":
				this.applyToolEvent(tab, {
					kind: ev.sessionUpdateKind,
					toolName: ev.toolName,
					detail: ev.detail,
					toolCallId: ev.toolCallId,
				});
				break;
			case "status":
				tab.messages.push({ role: "status", content: ev.text });
				break;
		}
		this.queueRenderTranscript();
	}

	async sendMessage(): Promise<void> {
		const tab = this.activeTab();
		const el = this.composeEl;
		if (!tab || !el) return;
		const userText = el.value.trim();
		if (!userText) return;

		/* One-time tab title from the first line of the first user message. */
		if (tab.tabTitleSource === "default" && !tab.messages.some((m) => m.role === "user")) {
			tab.title = titleFromFirstUserMessage(userText);
			tab.tabTitleSource = "auto";
			this.renderTabs();
		}

		const activeFile = this.app.workspace.getActiveFile();
		const mentions = this.extractMentionPaths(userText);
		const preamble = buildVaultContextBlock(this.app, activeFile, {
			includeOpenTabs: this.plugin.settings.includeOpenTabs,
			includeLinkedNotes: this.plugin.settings.includeLinkedNotes,
			maxTabs: this.plugin.settings.maxContextTabs,
			maxLinks: this.plugin.settings.maxContextLinks,
			explicitPaths: mentions,
		});

		tab.messages.push({ role: "user", content: userText });
		el.value = "";
		this.adjustComposerHeight();
		this.renderTranscript();
		void this.flushPersist();

		try {
			await this.plugin.waitForPrewarmAndInitialBootstrap();
			this.setRequestPhase("none");
			this.plugin.agentLog.ui(
				`sendMessage userTextChars=${userText.length} mentions=${mentions.size} preambleChars=${preamble.length}`
			);
			await this.plugin.ensureAcp(this, this.mode, this.model);
			const acp = this.plugin.acp;
			if (!acp) throw new Error("ACP not initialized");

			if (!tab.acpSessionId) {
				this.setRequestPhase("session_new");
				const vaultRoot = getVaultOsPath(this.app);
				if (!vaultRoot) throw new Error("No vault OS path");
				const { sessionId } = await acp.sessionNew(vaultRoot);
				tab.acpSessionId = sessionId;
				this.plugin.agentLog.ui(`session/new ok sessionId=${sessionId}`);
			}

			/* Stays up until the first non-skip session/update (30s+ cold start is common). */
			this.setRequestPhase("awaiting_first_reply");
			this.pendingFirstReplySessionId = tab.acpSessionId!;

			const full = [{ type: "text" as const, text: preamble + userText }];
			await acp.sessionPrompt(tab.acpSessionId, full);
			this.plugin.agentLog.ui("session/prompt RPC finished (await returned)");
			/* If no stream events arrived, clear the banner. */
			if (this.requestPhase === "awaiting_first_reply") {
				this.setRequestPhase("none");
			}
			await this.flushPersist();
		} catch (e) {
			this.setRequestPhase("none");
			const msg = e instanceof Error ? e.message : String(e);
			this.plugin.agentLog.line("ui/error", msg);
			console.error("[Cursor Agent]", e);
			new Notice("Cursor Agent error: " + msg, 20000);
			tab.messages.push({ role: "system", content: "Error: " + msg });
			this.renderTranscript();
			void this.flushPersist();
		}
	}

	async onClose(): Promise<void> {
		window.clearTimeout(this.persistDebounceHandle);
		this.persistDebounceHandle = 0;
		this.setRequestPhase("none");
		this.plugin.setAcpChatView(null);
		await this.flushPersist();
	}

	async flushPersist(): Promise<void> {
		await this.plugin.persistTabs(this.buildPersistedChatTabs());
	}

	/**
	 * Synchronous snapshot of open tabs (also used on plugin unload so the last in-memory
	 * history is not lost if onClose has not run yet).
	 */
	buildPersistedChatTabs(): PersistedChatTabs {
		return {
			version: CHAT_PERSISTENCE_VERSION,
			tabs: this.tabs.map(({ localId, acpSessionId, title, tabTitleSource, messages }) => ({
				localId,
				acpSessionId,
				title,
				tabTitleSource,
				messages: messages.map((m) => cloneMessage(m)),
			})),
			activeTabId: this.activeTabId,
		};
	}
}

function cloneMessage(m: ChatMessage): ChatMessage {
	return {
		role: m.role,
		content: m.content,
		...(m.toolEntries?.length
			? { toolEntries: m.toolEntries.map((e) => ({ ...e })) }
			: {}),
	};
}

function cloneTabWithMessages(t: ChatTabState): ChatTabState {
	const src = t.tabTitleSource;
	const tabTitleSource: TabTitleSource =
		src === "default" || src === "auto" || src === "user" ? src : "user";
	return {
		localId: t.localId,
		acpSessionId: t.acpSessionId,
		title: t.title,
		tabTitleSource,
		messages: t.messages.map((m) => cloneMessage(m)),
	};
}
