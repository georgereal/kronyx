/**
 * Transport choice for a harness run (vscode-free). The transport is the model
 * side only: the Cline SDK (createHandler) or the OpenAI wire (Responses or chat).
 * The loop is always the harness.
 */

export type TransportKind = "cline" | "openai";

export type TransportChoice = { ok: true; transport: TransportKind } | { ok: false; message: string };

export function chooseTransport(providerId: string, transport: TransportKind): TransportChoice {
	if (transport === "openai" && providerId === "anthropic") {
		return { ok: false, message: "The OpenAI transport can't run Anthropic profiles. Switch the transport to Cline SDK." };
	}
	return { ok: true, transport };
}
