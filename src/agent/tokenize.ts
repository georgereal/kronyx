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
