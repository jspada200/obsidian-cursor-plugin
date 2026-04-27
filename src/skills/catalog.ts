import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";
import type { App } from "obsidian";
import { parseYaml, TFile } from "obsidian";
import type { CursorAgentSettings } from "../settings";

export type CatalogKind = "skill" | "command";

export interface CatalogEntry {
	kind: CatalogKind;
	/** Display and filter id, always starts with `/` */
	slashId: string;
	description: string;
	/** Vault-relative or absolute path to SKILL.md */
	skillPath?: string;
	skillSource?: "vault" | "user" | "custom";
}

const MAX_SKILL_INJECT = 12000;

export const CURATED_COMMANDS: Array<{ slashId: string; description: string }> = [
	{
		slashId: "/create-skill",
		description: "Guides users through creating effective Agent Skills for Cursor.",
	},
	{
		slashId: "/create-rule",
		description: "Create Cursor rules for persistent AI guidance in .cursor/rules.",
	},
	{
		slashId: "/create-hook",
		description: "Create Cursor hooks (hooks.json and hook scripts).",
	},
	{
		slashId: "/split-to-prs",
		description: "Split current work into small reviewable pull requests.",
	},
	{
		slashId: "/update-cursor-settings",
		description: "Modify Cursor or VS Code user settings in settings.json.",
	},
	{
		slashId: "/cloudflare-docs/workers-prompt-full",
		description: "Detailed prompt for generating Cloudflare Workers code from docs context.",
	},
	{
		slashId: "/apply-worktree",
		description: "Apply worktree changes to main branch.",
	},
	{
		slashId: "/best-of-n",
		description: "Compare models on the same task (pass model names and task in the message).",
	},
];

function normalizeToSlashId(raw: string): string {
	const s = raw
		.trim()
		.replace(/^\/+/, "")
		.replace(/\s+/g, "-")
		.replace(/_/g, "-");
	if (!s) return "/skill";
	const kebab = s
		.replace(/([a-z])([A-Z])/g, "$1-$2")
		.replace(/[^a-zA-Z0-9/-]/g, "-")
		.replace(/-+/g, "-")
		.toLowerCase();
	return "/" + kebab.replace(/^-+/, "");
}

function parseFrontmatter(content: string): { yaml: string; body: string } {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
		return { yaml: "", body: content };
	}
	const rest = content.slice(4);
	const end = rest.indexOf("\n---");
	if (end < 0) return { yaml: "", body: content };
	const yaml = rest.slice(0, end);
	const body = rest.slice(end + 4).replace(/^\s*/, "");
	return { yaml, body };
}

function descriptionFromSkill(content: string): string {
	const { yaml, body } = parseFrontmatter(content);
	if (yaml) {
		try {
			const meta = parseYaml(yaml) as { description?: string; name?: string };
			if (typeof meta.description === "string" && meta.description.trim()) {
				return truncateOneLine(meta.description.trim(), 140);
			}
		} catch {
			/* ignore */
		}
	}
	const para = body
		.split(/\n{2,}/)
		.map((p) => stripMdToPlain(p).trim())
		.find(Boolean);
	return truncateOneLine(para ?? "Agent skill", 140);
}

function nameFromSkillYaml(content: string, folderFallback: string): string {
	const { yaml } = parseFrontmatter(content);
	if (yaml) {
		try {
			const meta = parseYaml(yaml) as { name?: string };
			if (typeof meta.name === "string" && meta.name.trim()) return meta.name.trim();
		} catch {
			/* ignore */
		}
	}
	return folderFallback;
}

function stripMdToPlain(s: string): string {
	return s
		.replace(/`{1,3}[^`]*`{1,3}/g, "")
		.replace(/\[(.*?)\]\([^)]*\)/g, "$1")
		.replace(/#+\s*/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function truncateOneLine(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1) + "…";
}

async function walkSkillMdFiles(root: string, out: string[]): Promise<void> {
	try {
		const st = await fs.promises.stat(root);
		if (!st.isDirectory()) return;
	} catch {
		return;
	}
	const ents = await fs.promises.readdir(root, { withFileTypes: true });
	for (const e of ents) {
		const full = path.join(root, e.name);
		if (e.isDirectory()) await walkSkillMdFiles(full, out);
		else if (e.isFile() && e.name === "SKILL.md") out.push(full);
	}
}

function allocSlashId(base: string, used: Set<string>): string {
	let id = normalizeToSlashId(base);
	if (!used.has(id)) {
		used.add(id);
		return id;
	}
	let n = 2;
	while (used.has(`${id}-${n}`)) n++;
	const next = `${id}-${n}`;
	used.add(next);
	return next;
}

export function commandsToEntries(): CatalogEntry[] {
	return CURATED_COMMANDS.map((c) => ({
		kind: "command" as const,
		slashId: c.slashId.startsWith("/") ? c.slashId : "/" + c.slashId,
		description: c.description,
	}));
}

/** Fallback when scanning the filesystem fails. */
export function catalogCommandsOnly(): { skills: CatalogEntry[]; commands: CatalogEntry[] } {
	return { skills: [], commands: commandsToEntries() };
}

function isUnderVaultSkills(p: string): boolean {
	const norm = p.replace(/\\/g, "/");
	return norm.includes(".cursor/skills/") && norm.endsWith("SKILL.md");
}

/**
 * Discover vault + user-home + optional extra dirs; assign unique slashIds (vault wins on tie-break order).
 */
export async function buildSkillCatalog(
	app: App,
	settings: CursorAgentSettings
): Promise<{ skills: CatalogEntry[]; commands: CatalogEntry[] }> {
	const commands = commandsToEntries();
	const usedIds = new Set<string>();
	for (const c of commands) usedIds.add(c.slashId);

	const skillRows: CatalogEntry[] = [];

	const vaultFiles = app.vault.getMarkdownFiles().filter((f) => isUnderVaultSkills(f.path));
	vaultFiles.sort((a, b) => a.path.localeCompare(b.path));

	for (const f of vaultFiles) {
		const content = await app.vault.cachedRead(f);
		const parts = f.path.split("/");
		const ci = parts.indexOf(".cursor");
		const folderName =
			ci >= 0 && parts[ci + 1] === "skills" && parts[ci + 2]
				? parts[ci + 2]
				: path.basename(path.dirname(f.path));
		const displayName = nameFromSkillYaml(content, folderName);
		const slashBase = normalizeToSlashId(displayName).replace(/^\//, "") || folderName;
		const slashId = allocSlashId(slashBase, usedIds);
		skillRows.push({
			kind: "skill",
			slashId,
			description: descriptionFromSkill(content),
			skillPath: f.path,
			skillSource: "vault",
		});
	}

	const userRoot = path.join(homedir(), ".cursor", "skills");
	const extraRoots = parseExtraSkillRoots(settings.extraSkillScanDirs);
	const diskRoots = [userRoot, ...extraRoots];

	const absSeen = new Set<string>();
	const absPaths: string[] = [];
	for (const r of diskRoots) {
		const batch: string[] = [];
		await walkSkillMdFiles(path.normalize(r), batch);
		for (const a of batch) {
			if (!absSeen.has(a)) {
				absSeen.add(a);
				absPaths.push(a);
			}
		}
	}
	absPaths.sort((a, b) => a.localeCompare(b));

	for (const abs of absPaths) {
		let content: string;
		try {
			content = await fs.promises.readFile(abs, "utf8");
		} catch {
			continue;
		}
		const folderName = path.basename(path.dirname(abs));
		const displayName = nameFromSkillYaml(content, folderName);
		const slashBase = normalizeToSlashId(displayName).replace(/^\//, "") || folderName;
		const slashId = allocSlashId(slashBase, usedIds);
		const source: "user" | "custom" = abs.startsWith(userRoot) ? "user" : "custom";
		skillRows.push({
			kind: "skill",
			slashId,
			description: descriptionFromSkill(content),
			skillPath: abs,
			skillSource: source,
		});
	}

	skillRows.sort((a, b) => a.slashId.localeCompare(b.slashId));
	return { skills: skillRows, commands };
}

function parseExtraSkillRoots(raw: string): string[] {
	return raw
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => path.normalize(s));
}

export function filterCatalog(
	skills: CatalogEntry[],
	commands: CatalogEntry[],
	query: string
): { skills: CatalogEntry[]; commands: CatalogEntry[] } {
	const q = query.replace(/^\//, "").trim().toLowerCase();
	const match = (e: CatalogEntry) => {
		if (!q) return true;
		const id = e.slashId.toLowerCase().replace(/^\//, "");
		const hay = `${e.slashId} ${e.description} ${e.skillPath ?? ""}`.toLowerCase();
		return id.includes(q) || hay.includes(q);
	};
	return {
		skills: skills.filter(match),
		commands: commands.filter(match),
	};
}

/** Read full or truncated skill body for injection (outside vault). */
export async function readSkillFileBody(app: App, entry: CatalogEntry): Promise<string> {
	if (!entry.skillPath) return "";
	if (entry.skillSource === "vault") {
		const f = app.vault.getAbstractFileByPath(entry.skillPath);
		if (f instanceof TFile) {
			try {
				const t = await app.vault.cachedRead(f);
				return t.length > MAX_SKILL_INJECT ? t.slice(0, MAX_SKILL_INJECT) + "\n\n…(truncated)" : t;
			} catch {
				return "";
			}
		}
		return "";
	}
	try {
		const t = await fs.promises.readFile(entry.skillPath, "utf8");
		return t.length > MAX_SKILL_INJECT ? t.slice(0, MAX_SKILL_INJECT) + "\n\n…(truncated)" : t;
	} catch {
		return "";
	}
}

export interface InvocationPayload {
	userText: string;
	explicitPaths: Set<string>;
	externalPaths: string[];
}

/**
 * Build the first user message and path sets for a catalog entry (composer pick or note click).
 */
export async function buildInvocationPayload(
	app: App,
	entry: CatalogEntry
): Promise<InvocationPayload> {
	const explicitPaths = new Set<string>();
	const externalPaths: string[] = [];

	if (entry.kind === "command") {
		return {
			userText: `${entry.slashId} `,
			explicitPaths,
			externalPaths,
		};
	}

	const p = entry.skillPath ?? "";
	if (entry.skillSource === "vault" && p) {
		explicitPaths.add(p);
		return {
			userText:
				`${entry.slashId}\n\n` +
				`Follow the Agent Skill in the vault file \`@${p}\`. Read that file and apply its instructions to the current task.`,
			explicitPaths,
			externalPaths,
		};
	}

	const body = await readSkillFileBody(app, entry);
	if (p) externalPaths.push(p);
	return {
		userText:
			`${entry.slashId}\n\n` +
			`This skill lives outside the vault workspace at \`${p}\`. ` +
			`Follow the SKILL.md content below.\n\n---\n\n` +
			body,
		explicitPaths,
		externalPaths,
	};
}

/** Resolve slash id or raw command text to a catalog entry if possible. */
export function findEntryBySlashId(
	skills: CatalogEntry[],
	commands: CatalogEntry[],
	slashOrText: string
): CatalogEntry | null {
	const t = slashOrText.trim();
	const id = t.startsWith("/") ? t.split(/\s/)[0] ?? t : "/" + t.split(/\s/)[0];
	const norm = id.startsWith("/") ? id : "/" + id;
	for (const e of skills) {
		if (e.slashId === norm || e.slashId === id) return e;
	}
	for (const e of commands) {
		if (e.slashId === norm || e.slashId === id) return e;
	}
	return null;
}

export function findSkillByPath(skills: CatalogEntry[], rawPath: string): CatalogEntry | null {
	const norm = rawPath.trim().replace(/\\/g, "/");
	if (!norm) return null;
	for (const s of skills) {
		const p = s.skillPath?.replace(/\\/g, "/");
		if (!p) continue;
		if (p === norm || p.endsWith("/" + norm) || norm.endsWith(p)) return s;
	}
	return null;
}
