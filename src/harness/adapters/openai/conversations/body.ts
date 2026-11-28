/** Responses request body bound to a server-side conversation (conversations slice). */

import { responsesBody } from "../../../../agent/openaiWire";
import type { ModelRequest, ToolSpec } from "../../../core/contracts";
import type { OpenAIPortConfig } from "../types";
import { compactThreshold } from "./conversation";
import { toResponsesItems } from "./input";

export function conversationsRequestBody(config: OpenAIPortConfig, request: ModelRequest): Record<string, unknown> {
	const target = { providerId: config.providerId, modelId: config.modelId };
	return responsesBody({
		model: config.modelId,
		instructions: request.system,
		input: toResponsesItems(request.messages, target),
		tools: request.tools as ToolSpec[],
		store: config.store,
		conversationId: request.conversation?.id,
		maxOutputTokens: config.maxOutputTokens,
		compactThreshold: request.conversation ? compactThreshold(config) : undefined,
		extras: config.extras?.(config.modelId),
	});
}
