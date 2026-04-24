/**
 * Invisible to the user — sent as the first session/prompt after session/new on plugin
 * so the model knows it runs inside the Obsidian plugin (not added to the transcript).
 */
export function buildPluginBootstrapContextText(vaultRoot: string, vaultName: string): string {
	return [
		"You are the Cursor agent running over ACP from the Obsidian Cursor community plugin (not the desktop Cursor app).",
		`The user is working in the Obsidian vault named "${vaultName}".`,
		`The vault root on disk is: ${vaultRoot}`,
		"User messages may be prefixed with context from the vault; use paths relative to the vault root. Be concise. This note is for your context only; the user does not see it in the plugin transcript.",
		"Files you create in this workspace are real notes in that Obsidian vault. The chat view renders links to those paths as clickable, so the user can open a note in an editor tab.",
		"When you create a new or updated .md file in the vault, make it easy to open from the chat: (1) On its own line, add: VAULT: path/relative/to/Note.md (one path per line, path relative to vault, no spaces in the path). (2) Also mention the path in a normal way (e.g. a markdown link or wikilink) if helpful for reading.",
		"Example after writing Inbox/Meeting.md: a line with only: VAULT: Inbox/Meeting.md",
	].join("\n");
}
