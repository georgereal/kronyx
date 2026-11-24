/**
 * OpenAI-compatible model port (vscode-free). Builds each request from the
 * harness projection, streams one turn through the shared wire layer, and
 * returns one normalized response. Stateless: no provider chain is kept, so any
 * engine or run can rebuild the same request from the log.
 */

import type { AgentMessage } from "@cline/shared";
import type { ModelPort, ModelRequest, ModelResponse, ToolCall, ToolSpec } from "../contracts";
import type { Message } from "../projections";
import {
	chatBody,
	endpointFor,
	postStream,
	protocolFor,
	reduceChat,
	reduceResponses,
	responsesBody,
	sseEvents,
	toChatMessages,
	toResponsesInput,
	type TurnOutcome,
} from "../../agent/openaiWire";

export interface OpenAIPortConfig {
	providerId: string;
	baseUrl: string;
	apiKey: string;
	modelId: string;
	maxOutputTokens?: number;
	signal?: AbortSignal;
}

/** Harness messages → the AgentMessage shape the shared wire layer converts. */
export function toAgentMessages(messages: readonly Message[]): AgentMessage[] {
	const out: AgentMessage[] = [];
	messages.forEach((m, i) => {
		const id = `m${i}`;
		const createdAt = i;
		if (m.kind === "user" || m.kind === "system") {
			const images = m.kind === "user" ? (m.images ?? []) : [];
			const content: AgentMessage["content"] = [
				{ type: "text", text: m.text },
				...images.map((img) => ({ type: "image" as const, image: img.base64, mediaType: img.mediaType })),
			];
			out.push({ id, role: "user", createdAt, content });
		} else if (m.kind === "assistant") {
			const content: AgentMessage["content"] = [
				...(m.text ? [{ type: "text" as const, text: m.text }] : []),
				...m.toolCalls.map((c) => ({ type: "tool-call" as const, toolCallId: c.callId, toolName: c.name, input: c.input })),
			];
			out.push({ id, role: "assistant", createdAt, content: content.length ? content : [{ type: "text", text: "" }] });
		} else {
			out.push({ id, role: "tool", createdAt, content: [{ type: "tool-result", toolCallId: m.callId, toolName: m.name, output: m.output, isError: !m.ok }] });
		}
	});
	return out;
}

/** Parses streamed tool arguments. Invalid JSON is kept as the raw string, so the ledger reports it as an input error. */
export function parseArguments(args: string): unknown {
	if (!args.trim()) return {};
	try {
		return JSON.parse(args);
	} catch {
		return args;
	}
}

export function toModelResponse(turn: TurnOutcome): ModelResponse {
	const toolCalls: ToolCall[] = turn.calls.map((c) => ({ callId: c.callId, name: c.name, input: parseArguments(c.args) }));
	return {
		text: turn.text,
		toolCalls,
		usage: { inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens, cachedTokens: turn.usage.cachedTokens },
		...(turn.reasoning ? { reasoning: turn.reasoning } : {}),
	};
}

export class OpenAIModelPort implements ModelPort {
	constructor(private readonly config: OpenAIPortConfig) {}

	async complete(request: ModelRequest): Promise<ModelResponse> {
		const protocol = protocolFor(this.config.providerId);
		const url = endpointFor(protocol, this.config.baseUrl);
		const agentMessages = toAgentMessages(request.messages);
		const hooks = { onText: () => undefined, onReasoning: (text: string) => request.onReasoningDelta?.(text) };
		const tools: readonly ToolSpec[] = request.tools;
		const body =
			protocol === "responses"
				? responsesBody({
						model: this.config.modelId,
						instructions: request.system,
						input: toResponsesInput(agentMessages),
						tools: tools as ToolSpec[],
						maxOutputTokens: this.config.maxOutputTokens,
					})
				: chatBody({
						model: this.config.modelId,
						messages: toChatMessages(request.system, agentMessages),
						tools: tools as ToolSpec[],
						maxTokens: this.config.maxOutputTokens,
					});
		const signal = request.signal ?? this.config.signal;
		const stream = await postStream(url, this.config.apiKey, body, signal);
		const turn = protocol === "responses" ? await reduceResponses(sseEvents(stream), hooks) : await reduceChat(sseEvents(stream), hooks);
		return toModelResponse(turn);
	}
}
