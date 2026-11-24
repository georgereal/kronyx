/**
 * Cline transport model port (vscode-free). Uses @cline/llms `createHandler` for
 * a single streamed turn. The handler owns no conversation state; every request
 * is rebuilt from the harness projection, so no SDK loop runs.
 */

import { createHandler, type ApiHandler, type ApiStreamChunk } from "@cline/llms";
import type { Message as ClineMessage, ToolDefinition } from "@cline/shared";
import type { ModelPort, ModelRequest, ModelResponse, ToolCall } from "../contracts";
import type { Message } from "../projections";
import { parseArguments } from "./openai";

export interface ClinePortConfig {
	providerId: string;
	baseUrl?: string;
	apiKey: string;
	modelId: string;
	maxOutputTokens?: number;
	signal?: AbortSignal;
}

/** Harness messages → Cline messages. Tool results travel as user tool_result blocks. */
export function toClineMessages(messages: readonly Message[]): ClineMessage[] {
	return messages.map((m): ClineMessage => {
		if (m.kind === "user" || m.kind === "system") {
			const images = m.kind === "user" ? (m.images ?? []) : [];
			if (images.length === 0) return { role: "user", content: m.text };
			return {
				role: "user",
				content: [
					{ type: "text", text: m.text },
					...images.map((img) => ({ type: "image" as const, data: img.base64, mediaType: img.mediaType })),
				],
			};
		}
		if (m.kind === "assistant") {
			const blocks: NonNullable<Extract<ClineMessage["content"], unknown[]>> = [];
			if (m.text) blocks.push({ type: "text", text: m.text });
			for (const c of m.toolCalls) blocks.push({ type: "tool_use", id: c.callId, name: c.name, input: c.input as Record<string, unknown> });
			return { role: "assistant", content: blocks.length ? blocks : "" };
		}
		return { role: "user", content: [{ type: "tool_result", tool_use_id: m.callId, name: m.name, content: m.output, is_error: !m.ok } as never] };
	});
}

export function toClineTools(tools: ModelRequest["tools"]): ToolDefinition[] {
	return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

/** Folds one turn's chunks into text, tool calls and usage. Throws on a failed stream. */
export async function collectTurn(stream: AsyncIterable<ApiStreamChunk>, onReasoningDelta?: (text: string) => void): Promise<ModelResponse> {
	let text = "";
	let reasoning = "";
	const toolCalls: ToolCall[] = [];
	let usage: ModelResponse["usage"];
	for await (const chunk of stream) {
		if (chunk.type === "text") text += chunk.text;
		else if (chunk.type === "reasoning") {
			reasoning += chunk.reasoning;
			onReasoningDelta?.(chunk.reasoning);
		} else if (chunk.type === "tool_calls") {
			const fn = chunk.tool_call.function;
			const callId = chunk.tool_call.call_id ?? fn.id ?? `call_${toolCalls.length + 1}`;
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

export class ClineModelPort implements ModelPort {
	private readonly handler: ApiHandler;

	constructor(private readonly config: ClinePortConfig) {
		this.handler = createHandler({
			providerId: (config.providerId === "azure" ? "openai-compatible" : config.providerId) as never,
			modelId: config.modelId,
			apiKey: config.apiKey,
			baseUrl: config.baseUrl,
			maxOutputTokens: config.maxOutputTokens,
			abortSignal: config.signal,
		});
	}

	async complete(request: ModelRequest): Promise<ModelResponse> {
		this.handler.setAbortSignal?.(request.signal ?? this.config.signal);
		const stream = this.handler.createMessage(request.system, toClineMessages(request.messages), toClineTools(request.tools));
		return collectTurn(stream, request.onReasoningDelta);
	}
}
