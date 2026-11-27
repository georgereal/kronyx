/**
 * Model adapters (vscode-free). The transport is the model side only — the Cline
 * SDK or the OpenAI-compatible wire. The loop is always the harness; adapters
 * translate normalized requests/responses to one API shape each.
 */

import type { ModelPort } from "../core/contracts";
import { ClineModelPort } from "./cline";
import { openaiAdapter, type OpenAIPortConfig } from "./openai";
import { protocolFor } from "../../agent/openaiWire";
import { hostOf } from "./openai/types";

export type TransportKind = "cline" | "openai" | "conversations" | "responses";

export type TransportChoice = { ok: true; transport: TransportKind } | { ok: false; message: string };

export function chooseTransport(providerId: string, transport: TransportKind): TransportChoice {
	if (transport !== "cline" && providerId === "anthropic") {
		return { ok: false, message: "The OpenAI transports can't run Anthropic profiles. Switch the transport to Cline SDK." };
	}
	return { ok: true, transport };
}

/**
 * The model side for a run: transport picks the adapter family and, for the
 * OpenAI wire, the API shape. Explicit selections are strict — picking
 * `conversations` or `responses` on an endpoint that can't serve them fails
 * instead of silently running a different protocol. Only `openai` (auto)
 * falls back to the stateless shapes.
 */
export function createModelAdapter(transport: TransportKind, config: OpenAIPortConfig): ModelPort {
	if (transport === "cline") return new ClineModelPort(config);
	if (transport === "conversations" || transport === "responses") {
		const responsesCapable = protocolFor(config.providerId, config.modelId) === "responses";
		if (transport === "responses") {
			if (!responsesCapable)
				throw new Error(
					`The OpenAI Responses transport needs a Responses-capable provider and model — ${config.providerId}/${config.modelId || "?"} serves chat completions. Pick the OpenAI transport or switch provider.`,
				);
			return openaiAdapter({ ...config, conversations: false });
		}
		const direct = responsesCapable && hostOf(config.baseUrl) === "api.openai.com";
		if (!direct || !(config.store ?? true) || !(config.conversations ?? true))
			throw new Error(
				`OpenAI Conversations needs a direct api.openai.com provider on the Responses protocol with store and conversations enabled — got ${config.providerId} at ${hostOf(config.baseUrl) || config.baseUrl}.`,
			);
		return openaiAdapter({ ...config, conversations: true });
	}
	return openaiAdapter(config);
}
