/**
 * Model adapters (vscode-free). The transport is the model side only — the Cline
 * SDK or the OpenAI-compatible wire. The loop is always the harness; adapters
 * translate normalized requests/responses to one API shape each.
 *
 * Shape support comes from the matrix (apiShapes.ts): an explicit pick the
 * provider can't serve is a hard failure, never a silent fallback.
 */

import type { ModelPort } from "../core/contracts";
import { ClineModelPort } from "./cline";
import { openaiAdapter, type OpenAIPortConfig } from "./openai";
import { resolveShape, type ApiShape } from "./apiShapes";

export type { ApiShape } from "./apiShapes";
export { providerShapes, resolveShape } from "./apiShapes";

/** Legacy transport ids: "openai" meant the auto wire pick. New code uses ApiShape | "auto". */
export type TransportKind = ApiShape | "openai" | "auto";

export type TransportChoice = { ok: true; transport: TransportKind; shape: ApiShape } | { ok: false; message: string };

/** Validate and resolve a transport pick against the matrix. Legacy "openai"/"auto" resolve deterministically; explicit shapes hard-fail when unsupported. */
export function chooseTransport(providerId: string, transport: TransportKind, baseUrl = ""): TransportChoice {
	const preference: ApiShape | "auto" = transport === "openai" || transport === "auto" ? "auto" : transport;
	const resolved = resolveShape(providerId, baseUrl, preference);
	if (!resolved.ok) return { ok: false, message: resolved.message };
	return { ok: true, transport, shape: resolved.shape };
}

/**
 * The model side for a run: the resolved shape picks the adapter. Strict —
 * a shape the matrix does not support for this provider throws instead of
 * silently running a different protocol.
 */
export function createModelAdapter(transport: TransportKind, config: OpenAIPortConfig): ModelPort {
	const preference: ApiShape | "auto" = transport === "openai" || transport === "auto" ? "auto" : transport;
	const resolved = resolveShape(config.providerId, config.baseUrl, preference);
	if (!resolved.ok) throw new Error(resolved.message);
	const { shape, constraints } = resolved;
	if (shape === "cline") return new ClineModelPort(config);
	const shaped: OpenAIPortConfig = {
		...config,
		shape,
		...(constraints.stateless ? { stateless: true } : {}),
		...(constraints.extras ? { extras: constraints.extras } : {}),
		explicit: preference !== "auto",
	};
	return openaiAdapter(shaped);
}
