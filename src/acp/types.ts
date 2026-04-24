/** Loose JSON-RPC envelope */
export interface JsonRpcRequest {
	jsonrpc?: string;
	id?: number;
	method?: string;
	params?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc?: string;
	id?: number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface SessionPromptPart {
	type: "text";
	text: string;
}

export interface PermissionOutcomeAllowOnce {
	outcome: "selected";
	optionId: "allow-once";
}

export interface PermissionOutcomeAllowAlways {
	outcome: "selected";
	optionId: "allow-always";
}

export interface PermissionOutcomeReject {
	outcome: "selected";
	optionId: "reject-once";
}

export type PermissionDecision =
	| PermissionOutcomeAllowOnce
	| PermissionOutcomeAllowAlways
	| PermissionOutcomeReject;
