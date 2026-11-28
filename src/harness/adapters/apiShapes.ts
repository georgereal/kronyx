/**
 * API-shape capability matrix (vscode-free). One table answers "which wire
 * shapes can this provider serve, under what constraints" — replacing the
 * hardcoded protocol detection. Strict by design: an explicit pick the matrix
 * does not support is a hard failure naming what IS supported, never a silent
 * fallback. "Auto" is deterministic resolution to the best supported shape.
 *
 * Constraints are the home of provider-specific overrides: OpenRouter's
 * Responses API is stateless-only (store:true 400s), reasoning opt-ins differ
 * per provider and shape — both live here, keyed on (provider, shape), not on
 * model-id heuristics scattered through the wire layer.
 */

import { hostOf } from "./openai/types";

export type ApiShape = "cline" | "responses" | "conversations" | "chat";

export interface ShapeConstraints {
	/** The endpoint keeps nothing: store must be false and no id chaining (OpenRouter Responses rejects both with 400). */
	stateless?: boolean;
	/** Provider-specific request-body extras for this shape (reasoning opt-ins etc.), keyed off the model id. */
	extras?: (modelId: string) => Record<string, unknown>;
}

export type ShapeTable = Partial<Record<ApiShape, ShapeConstraints>>;

/** Qwen3 hybrid-thinking variants (the -instruct line is non-thinking): the chat-completions opt-in is enable_thinking. */
const qwenChatExtras = (modelId: string): Record<string, unknown> => {
	const m = modelId.toLowerCase();
	return /qwen-?3/.test(m) && !m.includes("instruct") ? { enable_thinking: true } : {};
};

/** OpenAI reasoning families stream summary text only when asked. */
const openaiResponsesExtras = (modelId: string): Record<string, unknown> => {
	const m = modelId.toLowerCase();
	return /\b(o1|o3|o4)(-|\b)/.test(m) || m.includes("gpt-5") ? { reasoning: { summary: "auto" } } : {};
};

/** OpenRouter normalizes the OpenAI-convention reasoning param upstream; effort enables reasoning for reasoning-capable models. */
const openrouterResponsesExtras = (modelId: string): Record<string, unknown> => {
	void modelId;
	return { reasoning: { effort: "medium" } };
};

const CHAT_AND_CLINE: ShapeTable = { chat: { extras: qwenChatExtras }, cline: {} };

/**
 * The matrix. Provider ids come from the settings presets; unknown/custom
 * endpoints get chat+cline only — a Responses-capable custom endpoint is what
 * the per-profile apiShape override is for.
 */
export function providerShapes(providerId: string, baseUrl = ""): ShapeTable {
	switch (providerId) {
		case "openai": {
			const direct = hostOf(baseUrl) === "api.openai.com";
			return {
				cline: {},
				chat: { extras: qwenChatExtras },
				responses: { extras: openaiResponsesExtras },
				...(direct ? { conversations: {} } : {}),
			};
		}
		case "vercel-ai-gateway":
			return { cline: {}, chat: { extras: qwenChatExtras }, responses: { extras: openaiResponsesExtras } };
		case "openrouter":
			return { cline: {}, chat: { extras: qwenChatExtras }, responses: { stateless: true, extras: openrouterResponsesExtras } };
		case "anthropic":
			return { cline: {} };
		case "azure":
			return { cline: {}, chat: {}, responses: { stateless: true } };
		default:
			return CHAT_AND_CLINE;
	}
}

export type ShapeResolution = { ok: true; shape: ApiShape; constraints: ShapeConstraints } | { ok: false; message: string };

const supportedList = (table: ShapeTable): string => (Object.keys(table) as ApiShape[]).join(", ");

/**
 * Resolve the wire shape for a run. "auto" is deterministic: conversations on
 * direct OpenAI, then responses, then chat — cline only when it is the sole
 * shape (Anthropic) or explicitly picked. An explicit pick the provider can't
 * serve is a hard failure naming the supported shapes — never a fallback.
 */
export function resolveShape(providerId: string, baseUrl: string, preference: ApiShape | "auto"): ShapeResolution {
	const table = providerShapes(providerId, baseUrl);
	if (preference !== "auto") {
		const constraints = table[preference];
		if (!constraints) {
			return {
				ok: false,
				message: `${providerId} does not serve the ${preference} API — supported: ${supportedList(table)}. Pick one of those or leave it on auto.`,
			};
		}
		return { ok: true, shape: preference, constraints };
	}
	for (const shape of ["conversations", "responses", "chat"] as const) {
		const constraints = table[shape];
		if (constraints) return { ok: true, shape, constraints };
	}
	if (table.cline) return { ok: true, shape: "cline", constraints: table.cline };
	return { ok: false, message: `${providerId} has no usable API shape.` };
}
