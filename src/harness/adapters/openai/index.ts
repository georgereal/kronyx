/**
 * OpenAI-compatible adapter factory (vscode-free). The shape comes resolved
 * from the matrix (config.shape); each shape is its own port — no protocol
 * branch inside a single complete(). Conversations needs direct api.openai.com
 * with store + conversations on: an auto pick degrades to Responses (the
 * deterministic resolution), an explicit pick hard-fails.
 */

import type { ModelPort } from "../../core/contracts";
import { ChatCompletionsPort } from "./chat";
import { ConversationsApiPort } from "./conversations";
import { ResponsesApiPort } from "./responses";
import { hostOf, type OpenAIPortConfig } from "./types";

export type { OpenAIPortConfig } from "./types";
export { ChatCompletionsPort } from "./chat";
export { ConversationsApiPort } from "./conversations";
export { ResponsesApiPort } from "./responses";

export function openaiAdapter(config: OpenAIPortConfig): ModelPort {
	const shape = config.shape ?? "chat";
	if (shape === "conversations") {
		const direct = hostOf(config.baseUrl) === "api.openai.com";
		const eligible = direct && (config.store ?? true) && (config.conversations ?? true);
		if (eligible) return new ConversationsApiPort(config);
		if (config.explicit) {
			throw new Error(
				`OpenAI Conversations needs a direct api.openai.com provider with store and conversations enabled — got ${config.providerId} at ${hostOf(config.baseUrl) || config.baseUrl}.`,
			);
		}
		return new ResponsesApiPort(config);
	}
	if (shape === "responses") return new ResponsesApiPort(config);
	return new ChatCompletionsPort(config);
}
