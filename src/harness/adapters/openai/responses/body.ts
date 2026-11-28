/** Responses request body for one turn (Responses API slice). */

import { responsesBody } from "../../../../agent/openaiWire";
import type { ModelRequest, ToolSpec } from "../../../core/contracts";
import type { OpenAIPortConfig } from "../types";
import { toResponsesItems } from "./input";

export function responsesRequestBody(config: OpenAIPortConfig, request: ModelRequest): Record<string, unknown> {
	const target = { providerId: config.providerId, modelId: config.modelId };
	return responsesBody({
		model: config.modelId,
		instructions: request.system,
		input: toResponsesItems(request.messages, target),
		tools: request.tools as ToolSpec[],
		// Stateless endpoints (OpenRouter) reject store:true outright — the matrix
		// constraint forces it off here regardless of the global setting.
		store: config.stateless ? false : config.store,
		maxOutputTokens: config.maxOutputTokens,
		extras: config.extras?.(config.modelId),
	});
}
