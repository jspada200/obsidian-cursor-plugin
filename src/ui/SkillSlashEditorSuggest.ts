import {
	App,
	Editor,
	EditorPosition,
	EditorSuggest,
	type EditorSuggestContext,
	type EditorSuggestTriggerInfo,
	TFile,
} from "obsidian";
import type { CursorAgentPlugin } from "../plugin";
import { filterCatalog, type CatalogEntry } from "../skills/catalog";

/**
 * In markdown notes, typing `/` opens the same skills + commands list as the chat composer.
 * Choosing an item inserts a markdown link `obsidian://cursoragent?…` so it stays clickable in
 * Live Preview and Reading (raw custom HTML often renders as a code block).
 */
export class SkillSlashEditorSuggest extends EditorSuggest<CatalogEntry> {
	constructor(
		app: App,
		private readonly plugin: CursorAgentPlugin
	) {
		super(app);
		this.limit = 100;
	}

	onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
		if (!file || file.extension !== "md") return null;
		const line = editor.getLine(cursor.line);
		const before = line.slice(0, cursor.ch);
		const slash = before.lastIndexOf("/");
		if (slash < 0) return null;
		if (slash > 0 && !/\s/.test(before[slash - 1]!)) return null;
		const query = before.slice(slash + 1);
		if (/\s/.test(query)) return null;
		return {
			start: { line: cursor.line, ch: slash },
			end: { line: cursor.line, ch: cursor.ch },
			query,
		};
	}

	async getSuggestions(context: EditorSuggestContext): Promise<CatalogEntry[]> {
		const cat = await this.plugin.getSkillCatalog();
		const { skills, commands } = filterCatalog(cat.skills, cat.commands, context.query);
		return [...skills, ...commands];
	}

	renderSuggestion(entry: CatalogEntry, el: HTMLElement): void {
		const wrap = el.createDiv({ cls: "cursor-agent-editor-suggest-row" });
		wrap.createDiv({ cls: "cursor-agent-editor-suggest-id", text: entry.slashId });
		wrap.createDiv({ cls: "cursor-agent-editor-suggest-desc", text: entry.description });
	}

	selectSuggestion(entry: CatalogEntry, _evt: MouseEvent | KeyboardEvent): void {
		if (!this.context) return;
		const { editor, start, end, file } = this.context;
		const uri = this.plugin.buildCursorAgentInvokeUri(file, entry);
		const label = `▶ ${entry.slashId}`;
		const safeLabel = label.replace(/]/g, "›");
		editor.replaceRange(`[${safeLabel}](${uri})`, start, end);
	}
}
