/** Read sessionId from a session/update (or similar) ACP JSON payload. */
export function resolveAcpSessionIdFromUpdate(params: unknown): string | undefined {
	if (!params || typeof params !== "object") return undefined;
	const o = params as Record<string, unknown>;
	if (typeof o.sessionId === "string") return o.sessionId;
	const u = o.update;
	if (u && typeof u === "object" && typeof (u as Record<string, unknown>).sessionId === "string") {
		return (u as { sessionId: string }).sessionId;
	}
	return undefined;
}
