/** Chat-completions request body for one turn (chat slice). */

import { chatBody, toChatMessages } from "../../../../agent/openaiWire";
import type { ModelRequest, ToolSpec } from "../../../core/contracts";
import type { OpenAIPortConfig } from "../types";
import { toAgentMessages } from "./messages";

export function chatRequestBody(config: OpenAIPortConfig, request: ModelRequest): Record<string, unknown> {
	return chatBody({
		model: config.modelId,
		messages: toChatMessages(request.system, toAgentMessages(request.messages)),
		tools: request.tools as ToolSpec[],
		maxTokens: config.maxOutputTokens,
		extras: config.extras?.(config.modelId),
	});
}
