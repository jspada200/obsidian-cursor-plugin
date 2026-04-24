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
	].join("\n");
}
