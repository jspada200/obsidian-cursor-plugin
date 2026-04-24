const MAX_LEN = 48;

/** One-line label from the first user message, for the tab strip. */
export function titleFromFirstUserMessage(userText: string): string {
	const line = userText.trim().split(/\r?\n/)[0] ?? "";
	let t = line.replace(/\s+/g, " ").trim();
	t = t.replace(/[\x00-\x1f\x7f]/g, "");
	if (!t) return "Message";
	if (t.length > MAX_LEN) return t.slice(0, MAX_LEN - 1) + "…";
	return t;
}
