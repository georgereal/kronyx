/** Server-side conversation creation + compaction settings (conversations slice). */

import { createConversation } from "../../../../agent/openaiWire";
import type { ConversationPort } from "../../../core/contracts";
import type { OpenAIPortConfig } from "../types";

/** Server compaction runs at 70% of the context window; the API minimum is 1000 tokens. */
export function compactThreshold(config: OpenAIPortConfig): number {
	return Math.max(1000, Math.floor((config.contextWindow ?? 128_000) * 0.7));
}

export function conversationPort(config: OpenAIPortConfig): ConversationPort {
	return { provider: config.providerId, model: config.modelId, create: () => createConversation(config.baseUrl, config.apiKey) };
}
