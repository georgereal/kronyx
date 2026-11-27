/**
 * Conversations API port (vscode-free): Responses-shaped requests bound to a
 * server-side conversation. The only port that owns a RequestStrategy — the
 * loop binds, sends deltas and syncs through it, staying unaware of the
 * OpenAI-specific synchronization rules.
 */

import { endpointFor, postStream, reduceResponses, sseEvents } from "../../../../agent/openaiWire";
import type { AdapterCapabilities, ConversationPort, ModelPort, ModelRequest, ModelResponse } from "../../../core/contracts";
import type { RequestStrategy } from "../../../core/policies/requestStrategy";
import type { OpenAIPortConfig } from "../types";
import { conversationsRequestBody } from "./body";
import { conversationPort } from "./conversation";
import { toModelResponse } from "./response";
import { ConversationStrategy } from "./strategy";

export { ConversationStrategy } from "./strategy";

export class ConversationsApiPort implements ModelPort {
	readonly capabilities: AdapterCapabilities = { wire: "conversations", serverConversations: true, reasoningItems: true, store: true };
	readonly conversations: ConversationPort;
	readonly strategy: RequestStrategy;

	constructor(private readonly config: OpenAIPortConfig) {
		this.conversations = conversationPort(config);
		this.strategy = new ConversationStrategy(this.conversations);
	}

	async complete(request: ModelRequest): Promise<ModelResponse> {
		const target = { providerId: this.config.providerId, modelId: this.config.modelId };
		const hooks = { onText: (text: string) => request.onTextDelta?.(text), onReasoning: (text: string) => request.onReasoningDelta?.(text) };
		const body = conversationsRequestBody(this.config, request);
		const stream = await postStream(endpointFor("responses", this.config.baseUrl), this.config.apiKey, body, request.signal ?? this.config.signal);
		const turn = await reduceResponses(sseEvents(stream), hooks);
		return toModelResponse(turn, target);
	}
}
