import { encode } from "gpt-tokenizer";

const CHARS_PER_TOKEN = 4;

/**
 * Token count for context budgeting. Uses a real BPE encoding (gpt-tokenizer —
 * cl100k/o200k family; exact for OpenAI models, within ~5-10% for Claude/Gemini,
 * and far tighter than chars/4 on code-dense or non-English text either way).
 * Falls back to the chars/4 heuristic if encoding throws on malformed input.
 */
export function countTokens(text: string): number {
	if (!text) return 0;
	try {
		return encode(text).length;
	} catch {
		return Math.ceil(text.length / CHARS_PER_TOKEN);
	}
}

/** Fixed estimate for an image/media part — provider-side image tokens are
 *  resolution-based (~1–2k), never the raw byte count. Serializing a
 *  Uint8Array would score every byte as JSON text (~6 chars each). */
const IMAGE_PART_TOKEN_EST = 1_500;

/** Token estimate for a message's content array, special-casing image/media parts. */
export function countContentTokens(content: unknown): number {
	if (!Array.isArray(content)) return countTokens(JSON.stringify(content));
	let n = 0;
	for (const p of content as { type?: string }[]) {
		n += p?.type === "image" || p?.type === "media" ? IMAGE_PART_TOKEN_EST : countTokens(JSON.stringify(p));
	}
	return n;
}

/** Token estimate across a message list (same image-part handling). */
export function countMessageTokens(messages: readonly { content?: unknown }[]): number {
	let n = 0;
	for (const m of messages) n += countContentTokens(m.content);
	return n;
}
