/**
 * Chat-completions port (vscode-free). Used for every OpenAI-compatible provider
 * that does not speak the Responses protocol. Fully stateless.
 */

import { endpointFor, postStream, reduceChat, sseEvents } from "../../../../agent/openaiWire";
import type { AdapterCapabilities, ModelPort, ModelRequest, ModelResponse } from "../../../core/contracts";
import type { OpenAIPortConfig } from "../types";
import { chatRequestBody } from "./body";
import { toModelResponse } from "./response";

export { toAgentMessages } from "./messages";
export { toModelResponse } from "./response";
export { parseArguments } from "./args";

export class ChatCompletionsPort implements ModelPort {
	readonly capabilities: AdapterCapabilities = { wire: "chat", serverConversations: false, reasoningItems: false, store: false };

	readonly identity: { providerId: string; modelId: string; contextWindow?: number };

	constructor(private readonly config: OpenAIPortConfig) {
		this.identity = { providerId: config.providerId, modelId: config.modelId, ...(config.contextWindow !== undefined ? { contextWindow: config.contextWindow } : {}) };
	}

	async complete(request: ModelRequest): Promise<ModelResponse> {
		const hooks = { onText: (text: string) => request.onTextDelta?.(text), onReasoning: (text: string) => request.onReasoningDelta?.(text) };
		const body = chatRequestBody(this.config, request);
		const stream = await postStream(endpointFor("chat", this.config.baseUrl), this.config.apiKey, body, request.signal ?? this.config.signal);
		const turn = await reduceChat(sseEvents(stream), hooks);
		return toModelResponse(turn, { providerId: this.config.providerId, modelId: this.config.modelId });
	}
}
