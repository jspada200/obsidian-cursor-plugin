import { TFile, type App } from "obsidian";

/** Machine-readable: whole line, path relative to vault, no spaces (use a folder/Name.md). */
const VAULT_LINE = /^\s*VAULT:\s*(\S+)\s*$/;

/**
 * Turn `VAULT: path/Note.md` (alone on a line) into a blockquote with a vault file link
 * the chat can render and wire up for "open in tab" clicks.
 */
export function expandVaultNoteLineMarkers(markdown: string): string {
	return markdown
		.split("\n")
		.map((line) => {
			const m = line.match(VAULT_LINE);
			if (!m) return line;
			const p = m[1];
			const display = p.replace(/\.md$/i, "");
			return `> <span class="cursor-agent-vault-label">**In this vault**</span> — [${display}](${p})`;
		})
		.join("\n");
}

/**
 * If the user clicked a vault link in rendered assistant/thought HTML, open the target in a new tab.
 * External and mailto links are left to default behavior.
 */
export function tryOpenTranscriptVaultLink(
	e: MouseEvent,
	app: App,
	vaultRelativeSource: string
): void {
	if (e.defaultPrevented || e.button !== 0) return;
	const a = (e.target as HTMLElement | null)?.closest?.("a");
	if (!a) return;
	const href = a.getAttribute("href") || "";
	if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:")) {
		return;
	}
	if (href && (href.startsWith("obsidian://") || href.startsWith("app://"))) {
		return;
	}
	if (a.classList.contains("internal-link")) {
		const dataHref = a.getAttribute("data-href");
		if (dataHref) {
			e.preventDefault();
			e.stopImmediatePropagation();
			void app.workspace.openLinkText(dataHref, vaultRelativeSource, "tab");
			return;
		}
	}
	const pathPart = href.split("#")[0] ?? href;
	if (!pathPart) return;
	const noLeading = pathPart.replace(/^\//, "");
	let path = noLeading;
	try {
		path = decodeURIComponent(path);
	} catch {
		// keep as-is
	}
	const f = app.vault.getAbstractFileByPath(path);
	if (f instanceof TFile) {
		e.preventDefault();
		e.stopImmediatePropagation();
		void app.workspace.getLeaf("tab").openFile(f);
	}
}
