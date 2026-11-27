import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiStreamChunk } from "@cline/llms";
import { collectTurn, toClineMessages } from "../../src/harness/adapters/cline";
import { openaiAdapter } from "../../src/harness/adapters/openai";
import { parseArguments, toAgentMessages, toModelResponse, toResponsesItems } from "../../src/harness/adapters/openai/responses";
import type { ModelRequest } from "../../src/harness/core/contracts";
import { initialState, type Message } from "../../src/harness/core/projections";

const sse = (events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const sseResponse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

afterEach(() => vi.unstubAllGlobals());

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
	turn: 1,
	system: "SYS",
	messages: [{ kind: "user", text: "go", seq: 1 }],
	ledger: initialState().ledger,
	tools: [{ name: "read", description: "read a file", inputSchema: { type: "object" } }],
	...over,
});

describe("harness messages to provider messages", () => {
	it("maps user, assistant with tool calls, and tool results", () => {
		const msgs = toAgentMessages([
			{ kind: "user", text: "hi", seq: 1 },
			{ kind: "assistant", text: "", toolCalls: [{ callId: "c1", name: "read", input: { path: "a" } }], seq: 2 },
			{ kind: "tool", callId: "c1", name: "read", ok: false, output: "missing", seq: 3 },
		]);
		expect(msgs[0]).toMatchObject({ role: "user" });
		expect(msgs[1]?.content).toEqual([{ type: "tool-call", toolCallId: "c1", toolName: "read", input: { path: "a" } }]);
		expect(msgs[2]?.content).toEqual([{ type: "tool-result", toolCallId: "c1", toolName: "read", output: "missing", isError: true }]);
	});

	it("maps the same history to Cline blocks with tool_use and tool_result", () => {
		const msgs = toClineMessages([
			{ kind: "assistant", text: "", toolCalls: [{ callId: "c1", name: "read", input: {} }], seq: 1 },
			{ kind: "tool", callId: "c1", name: "read", ok: true, output: "ok", seq: 2 },
		]);
		expect(msgs[0]?.content).toEqual([{ type: "tool_use", id: "c1", name: "read", input: {} }]);
		expect(msgs[1]?.content).toEqual([expect.objectContaining({ type: "tool_result", tool_use_id: "c1", content: "ok" })]);
	});
});

describe("tool arguments", () => {
	it("parses valid JSON and keeps invalid JSON as the raw string for the ledger to report", () => {
		expect(parseArguments('{"a":1}')).toEqual({ a: 1 });
		expect(parseArguments("")).toEqual({});
		expect(parseArguments("{not json")).toBe("{not json");
	});

	it("turns a turn outcome into a model response", () => {
		const response = toModelResponse({
			text: "ok",
			reasoning: "",
			calls: [{ callId: "c", name: "read", args: '{"x":2}' }],
			usage: { inputTokens: 5, outputTokens: 2, cachedTokens: 1, reasoningTokens: 0 },
		});
		expect(response).toEqual({ text: "ok", toolCalls: [{ callId: "c", name: "read", input: { x: 2 } }], usage: { inputTokens: 5, outputTokens: 2, cachedTokens: 1 } });
	});
});

describe("OpenAI model port", () => {
	it("sends the projection and reads back one turn with a tool call", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			sseResponse(
				sse([
					{ type: "response.created", response: { id: "r1" } },
					{ type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "read", arguments: '{"path":"a"}' } },
					{ type: "response.completed", response: { id: "r1", usage: { input_tokens: 9, output_tokens: 3 } } },
				]),
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const port = openaiAdapter({ providerId: "openai", baseUrl: "https://api.example.test/v1", apiKey: "k", modelId: "m" });
		const response = await port.complete(request());
		const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
		expect(body.instructions).toBe("SYS");
		expect(body.store).toBe(true);
		expect(body.previous_response_id).toBeUndefined();
		expect(response.toolCalls).toEqual([{ callId: "c1", name: "read", input: { path: "a" } }]);
		expect(response.usage?.inputTokens).toBe(9);
	});

	it("uses chat completions for non-OpenAI providers", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			sseResponse(sse([{ choices: [{ delta: { content: "hi" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]) + "data: [DONE]\n\n"),
		);
		vi.stubGlobal("fetch", fetchMock);
		const port = openaiAdapter({ providerId: "openrouter", baseUrl: "https://gw.example.test/v1", apiKey: "k", modelId: "m" });
		const response = await port.complete(request());
		expect(String(fetchMock.mock.calls[0]![0])).toMatch(/chat\/completions$/);
		expect(response.text).toBe("hi");
	});
});

describe("OpenAI model port: conversations and output items", () => {
	const direct = { providerId: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k", modelId: "m" };
	const completed = () => sseResponse(sse([{ type: "response.created", response: { id: "r1" } }, { type: "response.completed", response: { id: "r1", output: [] } }]));

	it("offers conversations only for direct OpenAI Responses with store on", () => {
		expect(openaiAdapter(direct).conversations).toBeDefined();
		expect(openaiAdapter({ ...direct, store: false }).conversations).toBeUndefined();
		expect(openaiAdapter({ ...direct, conversations: false }).conversations).toBeUndefined();
		expect(openaiAdapter({ ...direct, baseUrl: "https://ai-gateway.vercel.sh/v1" }).conversations).toBeUndefined();
		expect(openaiAdapter({ ...direct, providerId: "openai-compatible" }).conversations).toBeUndefined();
	});

	it("sends only the delta to a conversation, with server compaction at 70% of the window", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(completed());
		vi.stubGlobal("fetch", fetchMock);
		const port = openaiAdapter({ ...direct, contextWindow: 128_000 });
		await port.complete(request({ messages: [{ kind: "tool", callId: "c1", name: "read", ok: true, output: "ok", seq: 2 }], conversation: { id: "conv_1" } }));
		const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
		expect(body.conversation).toBe("conv_1");
		expect(body.store).toBe(true);
		expect(body.previous_response_id).toBeUndefined();
		expect(body.context_management).toEqual([{ type: "compaction", compact_threshold: 89_600 }]);
		expect(body.input).toEqual([{ type: "function_call_output", call_id: "c1", output: "ok" }]);
	});

	it("keeps the full history stateless with store off and encrypted reasoning included", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(completed());
		vi.stubGlobal("fetch", fetchMock);
		await openaiAdapter({ ...direct, store: false }).complete(request());
		const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
		expect(body.store).toBe(false);
		expect(body.include).toEqual(["reasoning.encrypted_content"]);
		expect(body.conversation).toBeUndefined();
		expect(body.context_management).toBeUndefined();
	});

	it("replays stored output items verbatim only to the model that produced them", () => {
		const items = [
			{ type: "reasoning", id: "rs_1", encrypted_content: "enc" },
			{ type: "web_search_call", id: "ws_1", status: "completed" },
			{ type: "function_call", id: "fc_1", call_id: "c1", name: "read", arguments: "{}" },
			{ type: "custom_tool_call", id: "ct_1", call_id: "cx1", name: "other", input: "x" },
		];
		const messages: Message[] = [
			{ kind: "user", text: "go", seq: 1 },
			{
				kind: "assistant",
				text: "",
				toolCalls: [{ callId: "c1", name: "read", input: {} }],
				seq: 2,
				providerItems: { providerId: "openai", modelId: "m", items },
			},
			{ kind: "tool", callId: "c1", name: "read", ok: true, output: "ok", seq: 3 },
		];
		const same = toResponsesItems(messages, { providerId: "openai", modelId: "m" });
		// verbatim: ids, encrypted content and unknown item types survive; the non-canonical custom_tool_call is dropped
		expect(same.slice(1)).toEqual([...items.slice(0, 3), { type: "function_call_output", call_id: "c1", output: "ok" }]);
		const other = toResponsesItems(messages, { providerId: "openai", modelId: "other" });
		expect(other.map((i) => i.type ?? i.role)).toEqual(["user", "function_call", "function_call_output"]);
	});

	it("rebuilds instead of replaying when stored items are empty", () => {
		const messages: Message[] = [
			{ kind: "assistant", text: "hi", toolCalls: [], seq: 1, providerItems: { providerId: "openai", modelId: "m", items: [] } },
		];
		expect(toResponsesItems(messages, { providerId: "openai", modelId: "m" })).toEqual([{ role: "assistant", content: [{ type: "output_text", text: "hi" }] }]);
	});

	it("returns the response id and the full ordered output items", async () => {
		const items = [
			{ type: "reasoning", id: "rs_1", encrypted_content: "enc" },
			{ type: "function_call", call_id: "c9", name: "read", arguments: "{}" },
		];
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce(
				sseResponse(sse([{ type: "response.created", response: { id: "r7" } }, { type: "response.output_item.done", item: items[1] }, { type: "response.completed", response: { id: "r7", output: items } }])),
			),
		);
		const response = await openaiAdapter(direct).complete(request());
		expect(response.responseId).toBe("r7");
		expect(response.providerItems).toEqual({ providerId: "openai", modelId: "m", items });
	});

	it("creates a conversation through the Conversations API", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: "conv_9" }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		expect(await openaiAdapter(direct).conversations!.create()).toBe("conv_9");
		expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.openai.com/v1/conversations");
		expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("POST");
	});

	it("attaches the HTTP status to failures so a missing conversation can be told apart", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("no such conversation", { status: 404 })));
		const error = await openaiAdapter(direct).complete(request({ conversation: { id: "conv_x" } })).catch((e: unknown) => e);
		expect((error as { status?: number }).status).toBe(404);
	});
});

describe("Cline model port: stream folding", () => {
	it("folds text, tool calls and usage from one turn", async () => {
		const chunks: ApiStreamChunk[] = [
			{ type: "text", text: "Let me ", id: "1" },
			{ type: "text", text: "check.", id: "1" },
			{ type: "tool_calls", tool_call: { call_id: "t1", function: { name: "read", arguments: { path: "b" } } }, id: "1" },
			{ type: "usage", inputTokens: 40, outputTokens: 7, cacheReadTokens: 30, id: "1" },
			{ type: "done", success: true, id: "1" },
		];
		async function* stream() {
			for (const c of chunks) yield c;
		}
		const turn = await collectTurn(stream());
		expect(turn).toEqual({
			text: "Let me check.",
			toolCalls: [{ callId: "t1", name: "read", input: { path: "b" } }],
			usage: { inputTokens: 40, outputTokens: 7, cachedTokens: 30 },
		});
	});

	it("calls the provider omits ids for stay unique across turns", async () => {
		const turnChunks = (): ApiStreamChunk[] => [
			{ type: "tool_calls", tool_call: { function: { name: "read", arguments: { path: "b" } } }, id: "1" } as ApiStreamChunk,
			{ type: "done", success: true, id: "1" },
		];
		async function* stream() {
			for (const c of turnChunks()) yield c;
		}
		const first = await collectTurn(stream());
		const second = await collectTurn(stream());
		expect(first.toolCalls[0]!.callId).not.toBe(second.toolCalls[0]!.callId);
	});

	it("fails the turn when the stream reports failure", async () => {
		async function* stream(): AsyncGenerator<ApiStreamChunk> {
			yield { type: "done", success: false, error: "rate limited", id: "1" };
		}
		await expect(collectTurn(stream())).rejects.toThrow(/rate limited/);
	});
});
