import { TFile, type App, type CachedMetadata } from "obsidian";
import { getVaultOsPath } from "../util/vaultPath";

export interface ContextOptions {
	includeOpenTabs: boolean;
	includeLinkedNotes: boolean;
	maxTabs: number;
	maxLinks: number;
	explicitPaths: Set<string>;
}

function listOpenMarkdownPaths(app: App, max: number): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view as { file?: TFile };
		const f = view.file;
		if (f && !seen.has(f.path)) {
			seen.add(f.path);
			out.push(f.path);
			if (out.length >= max) break;
		}
	}
	return out;
}

function collectLinksFromFile(app: App, path: string, max: number): string[] {
	const meta = app.metadataCache.getCache(path) as CachedMetadata | null;
	const out: string[] = [];
	const seen = new Set<string>();
	if (!meta?.links) return out;
	for (const link of meta.links) {
		const rf = app.metadataCache.getFirstLinkpathDest(link.link, path);
		if (rf instanceof TFile) {
			const p = rf.path;
			if (!seen.has(p)) {
				seen.add(p);
				out.push(p);
				if (out.length >= max) break;
			}
		}
	}
	return out;
}

/**
 * Build a markdown context block prepended to the user message for the agent.
 */
export function buildVaultContextBlock(app: App, activeFile: TFile | null, opts: ContextOptions): string {
	const sections: string[] = [];
	sections.push("## Obsidian context (auto-generated)");
	const root = getVaultOsPath(app);
	sections.push(`Vault root: ${root || "(unknown — ensure desktop vault)"}`);

	if (opts.includeOpenTabs) {
		const tabs = listOpenMarkdownPaths(app, opts.maxTabs);
		if (tabs.length) {
			sections.push("### Open tabs");
			for (const p of tabs) sections.push(`- ${p}`);
		}
	}

	if (opts.includeLinkedNotes && activeFile) {
		const links = collectLinksFromFile(app, activeFile.path, opts.maxLinks);
		if (links.length) {
			sections.push("### Links from active note");
			for (const p of links) sections.push(`- ${p}`);
		}
	}

	if (opts.explicitPaths.size > 0) {
		sections.push("### @mentioned notes");
		for (const p of opts.explicitPaths) sections.push(`- ${p}`);
	}

	sections.push("---");
	return sections.join("\n") + "\n\n";
}

/**
 * Search vault markdown files by path substring; filter by `#tag` query for tags.
 */
export function searchNotesByNameOrTag(
	app: App,
	query: string,
	maxResults: number
): TFile[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const tagQuery = q.startsWith("#") ? q.slice(1) : null;
	const md = app.vault.getMarkdownFiles();
	const hits: TFile[] = [];
	for (const f of md) {
		if (tagQuery !== null) {
			const cache = app.metadataCache.getCache(f.path) as CachedMetadata | null;
			const tagStrs =
				cache?.tags?.map((x) => x.tag.replace(/^#/, "").toLowerCase()) ?? [];
			const matchesTag = tagStrs.some((t) => t.includes(tagQuery));
			if (!matchesTag) continue;
		} else {
			if (!f.path.toLowerCase().includes(q) && !f.basename.toLowerCase().includes(q)) continue;
		}
		hits.push(f);
		if (hits.length >= maxResults) break;
	}
	return hits;
}
