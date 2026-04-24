import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import { AcpClient } from "../acp/client";
import { buildVaultContextBlock, searchNotesByNameOrTag } from "../context/buildContext";
import type { CursorAgentPlugin } from "../plugin";
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

export const VIEW_TYPE_CURSOR_AGENT = "cursor-agent-chat-view";

export type ChatRole = "user" | "assistant" | "system" | "thought" | "tool_group" | "status";

export interface ToolEntry {
	label: string;
	text: string;
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

export class CursorChatView extends ItemView {
	acp: AcpClient | null = null;
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
		this.mode = this.plugin.settings.defaultMode;
		this.model = sanitizeModelId(this.plugin.settings.defaultModel);

		const snap = this.plugin.persistedSnapshot;
		if (snap?.tabs?.length && this.tabs.length === 0) {
			this.tabs = snap.tabs.map((t) => ({
				localId: t.localId,
				acpSessionId: t.acpSessionId,
				title: t.title,
				messages: [],
			}));
			this.activeTabId = snap.activeTabId ?? this.tabs[0]?.localId ?? null;
		}

		const root = this.containerEl.children[1];
		root.empty();
		root.addClass("cursor-agent-root");

		const topbar = root.createDiv({ cls: "cursor-agent-topbar" });
		this.tabsRowEl = topbar.createDiv({ cls: "cursor-agent-tabs-row" });
		topbar.createEl("button", { cls: "cursor-agent-topbar-btn", attr: { "aria-label": "New chat" } }, (b) => {
			setIcon(b, "plus");
			b.addEventListener("click", () => this.addTab());
		});

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
		if (this.acp) {
			await this.acp.dispose();
			this.acp = null;
		}
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
		this.tabs = this.tabs.filter((t) => t.localId !== localId);
		if (this.activeTabId === localId) this.activeTabId = this.tabs[0]?.localId ?? null;
		this.renderTabs();
		this.renderTranscript();
		void this.flushPersist();
	}

	private activeTab(): ChatTabState | null {
		return this.tabs.find((t) => t.localId === this.activeTabId) ?? null;
	}

	private renderTabs(): void {
		if (!this.tabsRowEl) return;
		this.tabsRowEl.empty();
		for (const t of this.tabs) {
			const tab = this.tabsRowEl.createEl("button", {
				cls: "cursor-agent-tab-pill" + (t.localId === this.activeTabId ? " is-active" : ""),
				text: t.title,
			});
			tab.addEventListener("click", (e) => {
				if (e.shiftKey) {
					this.closeTab(t.localId);
					return;
				}
				this.activeTabId = t.localId;
				this.renderTabs();
				this.renderTranscript();
			});
		}
	}

	private queueRenderTranscript(): void {
		if (this.transcriptRenderPending) return;
		this.transcriptRenderPending = true;
		window.requestAnimationFrame(() => {
			this.transcriptRenderPending = false;
			void this.renderTranscriptImpl();
		});
	}

	private renderTranscript(): void {
		void this.renderTranscriptImpl();
	}

	private markdownSourcePath(): string {
		return this.app.workspace.getActiveFile()?.path ?? "";
	}

	private async renderTranscriptImpl(): Promise<void> {
		if (!this.transcriptEl) return;
		this.transcriptEl.empty();
		const tab = this.activeTab();
		if (!tab) return;
		const sourcePath = this.markdownSourcePath();

		for (const m of tab.messages) {
			const turn = this.transcriptEl.createDiv({
				cls: "cursor-agent-turn cursor-agent-turn-" + m.role,
			});
			const bubble = turn.createDiv({ cls: "cursor-agent-bubble" });

			if (m.role === "assistant") {
				const md = bubble.createDiv({ cls: "cursor-agent-md markdown-rendered" });
				await MarkdownRenderer.render(this.app, m.content, md, sourcePath, this);
				continue;
			}

			if (m.role === "thought") {
				const details = bubble.createEl("details", { cls: "cursor-agent-thought-details" });
				details.createEl("summary", { cls: "cursor-agent-thought-summary", text: "Thinking" });
				const body = details.createDiv({ cls: "cursor-agent-thought-body markdown-rendered" });
				await MarkdownRenderer.render(this.app, m.content, body, sourcePath, this);
				continue;
			}

			if (m.role === "tool_group" && m.toolEntries && m.toolEntries.length > 0) {
				bubble.createEl("div", { cls: "cursor-agent-tool-group-title", text: "Tools" });
				const list = bubble.createDiv({ cls: "cursor-agent-tool-group-list" });
				for (const e of m.toolEntries) {
					const row = list.createDiv({ cls: "cursor-agent-tool-row" });
					row.createEl("div", { cls: "cursor-agent-tool-row-label", text: e.label });
					row.createEl("div", { cls: "cursor-agent-tool-row-body", text: e.text });
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

	private createAcpClient(): AcpClient {
		return new AcpClient(
			{
				onSessionUpdate: (params) => this.handleSessionUpdate(params),
				onPermissionRequest: (params, respond) => this.handlePermission(params, respond),
				onCursorCreatePlan: (params, respond) => this.handleCreatePlan(params, respond),
				onCursorAskQuestion: (params, respond) => this.handleAskQuestion(params, respond),
				onStderrLine: (line) => console.warn("[cursor-agent stderr]", line),
			},
			this.plugin.agentLog
		);
	}

	private handlePermission(params: unknown, respond: (r: unknown) => void): void {
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

	private handleCreatePlan(params: unknown, respond: (r: unknown) => void): void {
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

	private handleAskQuestion(params: unknown, respond: (r: unknown) => void): void {
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

	private resolveSessionIdFromParams(params: unknown): string | undefined {
		if (!params || typeof params !== "object") return undefined;
		const o = params as Record<string, unknown>;
		if (typeof o.sessionId === "string") return o.sessionId;
		const u = o.update;
		if (u && typeof u === "object" && typeof (u as Record<string, unknown>).sessionId === "string") {
			return (u as Record<string, unknown>).sessionId as string;
		}
		return undefined;
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

	private appendToolEntry(tab: ChatTabState, label: string, text: string): void {
		const entry: ToolEntry = { label, text };
		const last = tab.messages[tab.messages.length - 1];
		if (last?.role === "tool_group" && last.toolEntries) {
			last.toolEntries.push(entry);
		} else {
			tab.messages.push({ role: "tool_group", content: "", toolEntries: [entry] });
		}
	}

	private handleSessionUpdate(params: unknown): void {
		const sid = this.resolveSessionIdFromParams(params);
		const tab =
			(sid ? this.tabs.find((t) => t.acpSessionId === sid) : null) ?? this.activeTab();
		if (!tab) return;

		const ev = parseSessionUpdateForDisplay(params);
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
				this.appendToolEntry(tab, ev.label, ev.text);
				break;
			case "status":
				tab.messages.push({ role: "status", content: ev.text });
				break;
		}
		this.queueRenderTranscript();
	}

	async ensureAcp(): Promise<void> {
		const vaultRoot = getVaultOsPath(this.app);
		if (!vaultRoot) {
			new Notice("Vault path unavailable — desktop vault required.");
			throw new Error("No vault OS path");
		}
		if (this.acp?.isRunning()) return;

		this.plugin.agentLog.ui(
			`ensureAcp spawn mode=${this.mode} model=${this.model || "(default)"} vault=${vaultRoot}`
		);

		const agentPath = expandAgentPath(this.plugin.settings.agentBinaryPath);

		const extra = this.plugin.settings.extraAgentArgs
			.split(/\s+/)
			.map((s) => s.trim())
			.filter(Boolean);

		if (!this.acp) this.acp = this.createAcpClient();
		await this.acp.spawn({
			agentPath,
			workspaceRoot: vaultRoot,
			mode: this.mode,
			model: this.model,
			trustWorkspace: this.plugin.settings.trustWorkspace,
			extraArgs: extra,
		});

		/* New `agent acp` process has no memory of prior sessions — drop stale IDs from UI & disk. */
		for (const t of this.tabs) {
			t.acpSessionId = null;
		}
		void this.flushPersist();
		this.plugin.agentLog.ui("ensureAcp: cleared tab session IDs after spawn (new agent process)");
	}

	async sendMessage(): Promise<void> {
		const tab = this.activeTab();
		const el = this.composeEl;
		if (!tab || !el) return;
		const userText = el.value.trim();
		if (!userText) return;

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

		try {
			this.plugin.agentLog.ui(
				`sendMessage userTextChars=${userText.length} mentions=${mentions.size} preambleChars=${preamble.length}`
			);
			await this.ensureAcp();
			if (!this.acp) throw new Error("ACP not initialized");

			if (!tab.acpSessionId) {
				const vaultRoot = getVaultOsPath(this.app);
				const { sessionId } = await this.acp.sessionNew(vaultRoot);
				tab.acpSessionId = sessionId;
				this.plugin.agentLog.ui(`session/new ok sessionId=${sessionId}`);
			}

			const full = [{ type: "text" as const, text: preamble + userText }];
			await this.acp.sessionPrompt(tab.acpSessionId, full);
			this.plugin.agentLog.ui("session/prompt RPC finished (await returned)");
			await this.flushPersist();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.plugin.agentLog.line("ui/error", msg);
			console.error("[Cursor Agent]", e);
			new Notice("Cursor Agent error: " + msg, 20000);
			tab.messages.push({ role: "system", content: "Error: " + msg });
			this.renderTranscript();
		}
	}

	async onClose(): Promise<void> {
		await this.flushPersist();
	}

	async flushPersist(): Promise<void> {
		await this.plugin.persistTabs({
			tabs: this.tabs.map(({ localId, acpSessionId, title }) => ({ localId, acpSessionId, title })),
			activeTabId: this.activeTabId,
		});
	}

	async onunload(): Promise<void> {
		if (this.acp) await this.acp.dispose();
		this.acp = null;
	}
}
