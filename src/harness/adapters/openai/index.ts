/**
 * OpenAI-compatible adapter factory (vscode-free). Picks the API shape for the
 * endpoint: Conversations on direct api.openai.com with store + conversations
 * on, Responses for the Responses protocol, chat completions otherwise. Each
 * shape is its own port — no protocol branch inside a single complete().
 */

import { protocolFor } from "../../../agent/openaiWire";
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
	const responsesCapable = protocolFor(config.providerId, config.modelId) === "responses";
	const direct = responsesCapable && hostOf(config.baseUrl) === "api.openai.com";
	if (direct && (config.store ?? true) && (config.conversations ?? true)) return new ConversationsApiPort(config);
	return responsesCapable ? new ResponsesApiPort(config) : new ChatCompletionsPort(config);
}
