import { encode } from "gpt-tokenizer";
import type { TokenCounter } from "../contracts/ports";

/**
 * cl100k/o200k-style BPE counting through gpt-tokenizer. Special-token text
 * (e.g. a source file literally containing `<|endoftext|>`) is encoded as
 * plain text rather than rejected — file contents are data, never control
 * tokens. This is exact for OpenAI-family models and a close estimate for
 * others; the provider safety margin in budget allocation covers the drift.
 */
const NO_DISALLOWED = { disallowedSpecial: new Set<string>() };

export function countTokens(text: string): number {
	if (!text) return 0;
	return encode(text, NO_DISALLOWED).length;
}

export function countJsonTokens(value: unknown): number {
	return countTokens(JSON.stringify(value));
}

export function createTokenCounter(method: TokenCounter["method"] = "tokenizer"): TokenCounter {
	return {
		method,
		count: countTokens,
		countJson: countJsonTokens,
	};
}
