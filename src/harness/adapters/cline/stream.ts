/** Folds one turn's chunks into text, tool calls and usage (vscode-free). Throws on a failed stream. */

import { randomUUID } from "node:crypto";
import type { ApiStreamChunk } from "@cline/llms";
import type { ModelResponse, ToolCall } from "../../core/contracts";
import { parseArguments } from "./args";

export async function collectTurn(stream: AsyncIterable<ApiStreamChunk>, onReasoningDelta?: (text: string) => void, onTextDelta?: (text: string) => void): Promise<ModelResponse> {
	let text = "";
	let reasoning = "";
	const toolCalls: ToolCall[] = [];
	let usage: ModelResponse["usage"];
	for await (const chunk of stream) {
		if (chunk.type === "text") {
			text += chunk.text;
			onTextDelta?.(chunk.text);
		}
		else if (chunk.type === "reasoning") {
			reasoning += chunk.reasoning;
			onReasoningDelta?.(chunk.reasoning);
		} else if (chunk.type === "tool_calls") {
			const fn = chunk.tool_call.function;
			// Provider ids are per-call; the generated fallback must be unique across
			// turns too, because outcomes are keyed by callId for the whole session.
			const callId = chunk.tool_call.call_id || fn.id || `call_${randomUUID()}`;
			const args = fn.arguments;
			toolCalls.push({ callId, name: fn.name ?? "", input: typeof args === "string" ? parseArguments(args) : (args ?? {}) });
		} else if (chunk.type === "usage") {
			usage = { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens, cachedTokens: chunk.cacheReadTokens ?? 0 };
		} else if (chunk.type === "done" && !chunk.success) {
			throw new Error(chunk.error ?? "model stream failed");
		}
	}
	return { text, toolCalls, ...(usage ? { usage } : {}), ...(reasoning ? { reasoning } : {}) };
}
