/** TurnOutcome → normalized ModelResponse (Responses API slice). */

import type { TurnOutcome } from "../../../../agent/openaiWire";
import type { ModelResponse, ProviderItems, ToolCall } from "../../../core/contracts";
import { parseArguments } from "./args";

export function toModelResponse(turn: TurnOutcome, target?: { providerId: string; modelId: string }): ModelResponse {
	const toolCalls: ToolCall[] = turn.calls.map((c) => ({ callId: c.callId, name: c.name, input: parseArguments(c.args) }));
	const providerItems: ProviderItems | undefined = target && turn.providerItems ? { ...target, items: turn.providerItems } : undefined;
	return {
		text: turn.text,
		toolCalls,
		usage: { inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens, cachedTokens: turn.usage.cachedTokens },
		...(turn.reasoning ? { reasoning: turn.reasoning } : {}),
		...(turn.responseId ? { responseId: turn.responseId } : {}),
		...(providerItems ? { providerItems } : {}),
	};
}
