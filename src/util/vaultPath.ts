import { FileSystemAdapter, type App } from "obsidian";

/** OS path to vault folder (desktop); empty string if unavailable. */
export function getVaultOsPath(app: App): string {
	const a = app.vault.adapter;
	if (a instanceof FileSystemAdapter) return a.getBasePath();
	return "";
}
