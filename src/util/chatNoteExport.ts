import type { App } from "obsidian";
import type { ChatMessage, ChatTabState } from "../chatTypes";

/** Windows/macOS / reserved — map to safe vault path segment. */
export function sanitizeNoteBasename(title: string): string {
	let s = title.trim() || "Untitled";
	s = s.replace(/[<>:"/\\|?*]/g, " ");
	s = s.replace(/\s+/g, " ").trim();
	if (!s) s = "Untitled";
	/* Max length to avoid path issues */
	if (s.length > 120) s = s.slice(0, 117) + "…";
	return s;
}

/** Create `name.md` at vault root, or `name-2.md`, `name-3.md`, … if needed. */
export function nextAvailablePathAtRoot(app: App, basenameNoExt: string, ext: string): string {
	const base = sanitizeNoteBasename(basenameNoExt) + ext;
	if (!app.vault.getAbstractFileByPath(base)) return base;
	const stem = base.slice(0, -ext.length);
	for (let n = 2; n < 1000; n++) {
		const p = `${stem}-${n}${ext}`;
		if (!app.vault.getAbstractFileByPath(p)) return p;
	}
	return `${stem}-${Date.now()}${ext}`;
}

export function formatMessageAsMarkdown(m: ChatMessage): string {
	const lines: string[] = [];
	switch (m.role) {
		case "user":
			lines.push("## You", "", m.content, "");
			break;
		case "assistant":
			lines.push("## Assistant", "", m.content, "");
			break;
		case "system":
			lines.push("## System", "", "```", m.content, "```", "");
			break;
		case "thought":
			lines.push("## Thinking", "", m.content, "");
			break;
		case "tool_group": {
			lines.push("## Tools", "");
			for (const e of m.toolEntries ?? []) {
				lines.push(`- **${e.label}**`);
				if (e.text?.trim()) {
					lines.push("");
					lines.push("  ```");
					lines.push(...e.text.split("\n").map((l) => "  " + l));
					lines.push("  ```");
				}
			}
			lines.push("");
			break;
		}
		case "status":
			lines.push(`*${m.content}*`, "");
			break;
	}
	return lines.join("\n");
}

export function formatSessionAsMarkdown(tab: ChatTabState): string {
	const parts: string[] = [`# ${tab.title}`, ""];
	for (const m of tab.messages) {
		parts.push(formatMessageAsMarkdown(m));
	}
	return parts.join("\n").trim() + "\n";
}

export async function copyToClipboard(text: string): Promise<void> {
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.style.position = "fixed";
	ta.style.left = "-9999px";
	document.body.appendChild(ta);
	ta.select();
	document.execCommand("copy");
	ta.remove();
}

export async function createMarkdownNoteAtRoot(app: App, titleFromTab: string, body: string): Promise<string> {
	const path = nextAvailablePathAtRoot(app, titleFromTab, ".md");
	await app.vault.create(path, body);
	return path;
}
