/**
 * Wire layer for the OpenAI-compatible engine (vscode-free, no SDK dependency).
 *
 * - Message conversion: canonical AgentMessage[] → Responses `input` items or
 *   chat-completions `messages`.
 * - Request bodies for both protocols, plus a fetch helper with bounded retry.
 * - SSE parsing and stream reducers that fold events into one TurnOutcome.
 */

import type { AgentImagePart, AgentMessage, AgentToolCallPart, AgentToolDefinition, AgentToolResultPart } from "@cline/shared";

export type WireProtocol = "responses" | "chat";

/** The OpenAI provider speaks Responses (chaining + server compaction); other compatible endpoints use chat completions. */
export const protocolFor = (providerId: string): WireProtocol => (providerId === "openai" ? "responses" : "chat");

export const endpointFor = (protocol: WireProtocol, baseUrl: string): string =>
	`${baseUrl.replace(/\/+$/, "")}/${protocol === "responses" ? "responses" : "chat/completions"}`;

export interface TurnUsage {
	inputTokens: number;
	outputTokens: number;
	cachedTokens: number;
	reasoningTokens: number;
}

export interface ToolCallOut {
	callId: string;
	name: string;
	args: string;
}

export interface TurnOutcome {
	responseId?: string;
	text: string;
	reasoning: string;
	calls: ToolCallOut[];
	usage: TurnUsage;
	/** Set when the provider stopped early (length limit, incomplete response). */
	incomplete?: string;
}

export const zeroUsage = (): TurnUsage => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 });

const textOf = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value ?? ""));

const imageUrl = (p: AgentImagePart): string => {
	const mime = p.mediaType ?? "image/png";
	const img = p.image;
	if (img instanceof URL) return img.toString();
	if (typeof img === "string") return img.startsWith("data:") || /^https?:/.test(img) ? img : `data:${mime};base64,${img}`;
	const bytes = img instanceof ArrayBuffer ? new Uint8Array(img) : img;
	return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
};

const textParts = (m: AgentMessage): string => m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

/** Canonical history → Responses API `input` items. Reasoning parts are not replayed. */
export function toResponsesInput(messages: readonly AgentMessage[]): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (const m of messages) {
		if (m.role === "tool") {
			for (const p of m.content)
				if (p.type === "tool-result") out.push({ type: "function_call_output", call_id: p.toolCallId, output: textOf((p as AgentToolResultPart).output) });
			continue;
		}
		if (m.role === "assistant") {
			const text = textParts(m);
			if (text) out.push({ role: "assistant", content: [{ type: "output_text", text }] });
			for (const p of m.content)
				if (p.type === "tool-call") {
					const c = p as AgentToolCallPart;
					out.push({ type: "function_call", call_id: c.toolCallId, name: c.toolName, arguments: JSON.stringify(c.input ?? {}) });
				}
			continue;
		}
		const content = m.content.flatMap((p): Record<string, unknown>[] =>
			p.type === "text" ? [{ type: "input_text", text: p.text }] : p.type === "image" ? [{ type: "input_image", image_url: imageUrl(p), detail: "auto" }] : [],
		);
		if (content.length) out.push({ role: "user", content });
	}
	return out;
}

/** Canonical history → chat-completions `messages`, with the system prompt first. */
export function toChatMessages(system: string, messages: readonly AgentMessage[]): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [{ role: "system", content: system }];
	for (const m of messages) {
		if (m.role === "tool") {
			for (const p of m.content)
				if (p.type === "tool-result") out.push({ role: "tool", tool_call_id: p.toolCallId, content: textOf((p as AgentToolResultPart).output) });
			continue;
		}
		if (m.role === "assistant") {
			const calls = m.content.filter((p): p is AgentToolCallPart => p.type === "tool-call");
			out.push({
				role: "assistant",
				content: textParts(m) || null,
				...(calls.length
					? { tool_calls: calls.map((c) => ({ id: c.toolCallId, type: "function", function: { name: c.toolName, arguments: JSON.stringify(c.input ?? {}) } })) }
					: {}),
			});
			continue;
		}
		const images = m.content.filter((p): p is AgentImagePart => p.type === "image");
		if (!images.length) {
			const text = textParts(m);
			if (text) out.push({ role: "user", content: text });
			continue;
		}
		const parts = m.content.flatMap((p): Record<string, unknown>[] =>
			p.type === "text" ? [{ type: "text", text: p.text }] : p.type === "image" ? [{ type: "image_url", image_url: { url: imageUrl(p) } }] : [],
		);
		out.push({ role: "user", content: parts });
	}
	return out;
}

export function responsesBody(args: {
	model: string;
	instructions: string;
	input: Record<string, unknown>[];
	tools: readonly AgentToolDefinition[];
	previousResponseId?: string;
	maxOutputTokens?: number;
	compactThreshold?: number;
}): Record<string, unknown> {
	return {
		model: args.model,
		instructions: args.instructions,
		input: args.input,
		tools: args.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema, strict: false })),
		parallel_tool_calls: true,
		store: true,
		stream: true,
		...(args.previousResponseId ? { previous_response_id: args.previousResponseId } : {}),
		...(args.maxOutputTokens ? { max_output_tokens: args.maxOutputTokens } : {}),
		...(args.compactThreshold ? { context_management: [{ type: "compaction", compact_threshold: args.compactThreshold }] } : {}),
	};
}

export function chatBody(args: {
	model: string;
	messages: Record<string, unknown>[];
	tools: readonly AgentToolDefinition[];
	maxTokens?: number;
}): Record<string, unknown> {
	return {
		model: args.model,
		messages: args.messages,
		tools: args.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
		stream: true,
		stream_options: { include_usage: true },
		...(args.maxTokens ? { max_tokens: args.maxTokens } : {}),
	};
}

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => (clearTimeout(t), reject(new Error("Stopped by user"))), { once: true });
	});

/** POST a streaming request; retries rate limits and transient 5xx before the stream starts. */
export async function postStream(url: string, apiKey: string, body: unknown, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${apiKey}` },
			body: JSON.stringify(body),
			signal,
		});
		if (res.ok && res.body) return res.body;
		const detail = (await res.text().catch(() => "")).slice(0, 500);
		const delay = RETRY_DELAYS_MS[attempt];
		if (!RETRY_STATUS.has(res.status) || delay === undefined) throw new Error(`HTTP ${res.status}: ${detail || res.statusText}`);
		await sleep(delay, signal);
	}
}

export interface SseEvent {
	event: string;
	data: string;
}

/** Minimal Server-Sent Events parser over a fetch body. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	let event = "";
	let data: string[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		buf += value ? decoder.decode(value, { stream: true }) : decoder.decode();
		if (done) buf += "\n";
		let idx: number;
		while ((idx = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, idx).replace(/\r$/, "");
			buf = buf.slice(idx + 1);
			if (line === "") {
				if (data.length) yield { event, data: data.join("\n") };
				event = "";
				data = [];
			} else if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
		}
		if (done) return;
	}
}

export interface StreamHooks {
	onText: (delta: string) => void;
	onReasoning: (delta: string) => void;
}

const responsesUsage = (u: Record<string, any> | undefined): TurnUsage => ({
	inputTokens: u?.input_tokens ?? 0,
	outputTokens: u?.output_tokens ?? 0,
	cachedTokens: u?.input_tokens_details?.cached_tokens ?? 0,
	reasoningTokens: u?.output_tokens_details?.reasoning_tokens ?? 0,
});

const chatUsage = (u: Record<string, any> | undefined): TurnUsage => ({
	inputTokens: u?.prompt_tokens ?? 0,
	outputTokens: u?.completion_tokens ?? 0,
	cachedTokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
	reasoningTokens: u?.completion_tokens_details?.reasoning_tokens ?? 0,
});

/** Fold Responses API stream events into one turn. Throws on failed/truncated streams. */
export async function reduceResponses(events: AsyncIterable<SseEvent>, hooks: StreamHooks): Promise<TurnOutcome> {
	const out: TurnOutcome = { text: "", reasoning: "", calls: [], usage: zeroUsage() };
	let finished = false;
	for await (const ev of events) {
		if (ev.data === "[DONE]") continue;
		const j = JSON.parse(ev.data);
		switch (j.type) {
			case "response.created":
				out.responseId = j.response?.id ?? out.responseId;
				break;
			case "response.output_text.delta":
				out.text += j.delta;
				hooks.onText(j.delta);
				break;
			case "response.reasoning_summary_text.delta":
			case "response.reasoning_text.delta":
				out.reasoning += j.delta;
				hooks.onReasoning(j.delta);
				break;
			case "response.output_item.done": {
				const item = j.item;
				if (item?.type === "function_call") out.calls.push({ callId: item.call_id, name: item.name, args: item.arguments ?? "" });
				else if (item?.type === "message" && !out.text) {
					const t = (item.content ?? []).flatMap((c: any) => (c.type === "output_text" ? [c.text] : [])).join("");
					if (t) {
						out.text = t;
						hooks.onText(t);
					}
				}
				break;
			}
			case "response.completed":
			case "response.incomplete": {
				const r = j.response ?? {};
				out.responseId = r.id ?? out.responseId;
				out.usage = responsesUsage(r.usage);
				if (j.type === "response.incomplete") out.incomplete = r.incomplete_details?.reason ?? "incomplete";
				finished = true;
				break;
			}
			case "response.failed":
				throw new Error(j.response?.error?.message ?? "Response failed");
			case "error":
				throw new Error(j.message ?? j.error?.message ?? "Stream error");
		}
	}
	if (!finished) throw new Error("Stream ended before the response completed");
	return out;
}

/** Fold chat-completions stream chunks into one turn. Tool-call fragments are merged by index. */
export async function reduceChat(events: AsyncIterable<SseEvent>, hooks: StreamHooks): Promise<TurnOutcome> {
	const out: TurnOutcome = { text: "", reasoning: "", calls: [], usage: zeroUsage() };
	const calls = new Map<number, { id: string; name: string; args: string }>();
	let finishReason: string | undefined;
	let sawDone = false;
	for await (const ev of events) {
		if (ev.data === "[DONE]") {
			sawDone = true;
			continue;
		}
		const j = JSON.parse(ev.data);
		if (j.error) throw new Error(j.error.message ?? "Stream error");
		out.responseId ??= j.id;
		if (j.usage) out.usage = chatUsage(j.usage);
		const choice = j.choices?.[0];
		if (choice?.finish_reason) finishReason = choice.finish_reason;
		const d = choice?.delta;
		if (!d) continue;
		if (d.content) {
			out.text += d.content;
			hooks.onText(d.content);
		}
		const reasoning = d.reasoning_content ?? d.reasoning;
		if (typeof reasoning === "string" && reasoning) {
			out.reasoning += reasoning;
			hooks.onReasoning(reasoning);
		}
		for (const tc of d.tool_calls ?? []) {
			const c = calls.get(tc.index) ?? { id: "", name: "", args: "" };
			if (tc.id) c.id = tc.id;
			if (tc.function?.name) c.name = tc.function.name;
			if (tc.function?.arguments) c.args += tc.function.arguments;
			calls.set(tc.index, c);
		}
	}
	if (!sawDone && !finishReason) throw new Error("Stream ended before the response completed");
	out.calls = [...calls.values()].map((c) => ({ callId: c.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: c.name, args: c.args }));
	if (finishReason === "length") out.incomplete = "length";
	return out;
}
