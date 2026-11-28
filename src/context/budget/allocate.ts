/**
 * Shared budget math (vscode-free): the single home of window→budget
 * conversion, pressure classification, and output-reserve accounting. Both the
 * harness projection enforcement and the observability manifests derive their
 * numbers from here, so enforcement and reporting can never drift apart.
 */

import { DEFAULT_OUTPUT_RESERVE } from "../contracts/model";

/** Provider/API overhead + tokenizer drift margin factored into budget allocation. */
export const SAFETY_MARGIN_SHARE = 0.03;
export const SAFETY_MARGIN_MIN_TOKENS = 1024;
/** Conservative window assumption when the model catalog does not know the window — overestimating would overflow small models. */
export const FALLBACK_WINDOW_TOKENS = 32_000;
/** Pressure share of the usable input budget: pre-compaction starts here, hard enforcement at 100%. */
export const PRESSURE_SHARE = 0.7;

export interface ProjectionBudget {
	/** Hard cap on total input (system + tool schemas + messages), in real tokens. */
	inputTokens: number;
	/** Reserved output capacity, surfaced for manifest honesty. */
	outputReserveTokens: number;
}

/** Input budget math shared by behavior resolution and tests: window minus output reserve minus provider/tokenizer margin. */
export function inputBudgetForWindow(contextWindowTokens: number | undefined, outputReserveTokens?: number): ProjectionBudget {
	const window = Math.max(1, contextWindowTokens ?? FALLBACK_WINDOW_TOKENS);
	const reserve = Math.max(1, outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE);
	const margin = Math.max(SAFETY_MARGIN_MIN_TOKENS, Math.floor(window * SAFETY_MARGIN_SHARE));
	return { inputTokens: Math.max(1, window - reserve - margin), outputReserveTokens: reserve };
}

export const DEFAULT_PROJECTION_BUDGET: ProjectionBudget = inputBudgetForWindow(undefined);

export function pressureLevel(usedInputTokens: number, usableInputBudget: number): "none" | "warm" | "pressure" | "critical" {
	if (usableInputBudget <= 0) return "critical";
	const ratio = usedInputTokens / usableInputBudget;
	if (ratio >= 0.95) return "critical";
	if (ratio >= PRESSURE_SHARE) return "pressure";
	if (ratio >= 0.6) return "warm";
	return "none";
}
