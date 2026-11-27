/**
 * Stateless Responses API port (vscode-free). Every request carries the full
 * projection; the server keeps nothing. Chosen for Responses-protocol providers
 * that are not direct api.openai.com Conversations.
 */

import { endpointFor, postStream, reduceResponses, sseEvents } from "../../../../agent/openaiWire";
import type { AdapterCapabilities, ModelPort, ModelRequest, ModelResponse } from "../../../core/contracts";
import type { OpenAIPortConfig } from "../types";
import { responsesRequestBody } from "./body";
import { toModelResponse } from "./response";

export { toAgentMessages } from "./messages";
export { toResponsesItems } from "./input";
export { toModelResponse } from "./response";
export { parseArguments } from "./args";

export class ResponsesApiPort implements ModelPort {
	readonly capabilities: AdapterCapabilities;

	constructor(private readonly config: OpenAIPortConfig) {
		this.capabilities = { wire: "responses", serverConversations: false, reasoningItems: true, store: config.store ?? true };
	}

	async complete(request: ModelRequest): Promise<ModelResponse> {
		const target = { providerId: this.config.providerId, modelId: this.config.modelId };
		const hooks = { onText: (text: string) => request.onTextDelta?.(text), onReasoning: (text: string) => request.onReasoningDelta?.(text) };
		const body = responsesRequestBody(this.config, request);
		const stream = await postStream(endpointFor("responses", this.config.baseUrl), this.config.apiKey, body, request.signal ?? this.config.signal);
		const turn = await reduceResponses(sseEvents(stream), hooks);
		return toModelResponse(turn, target);
	}
}
