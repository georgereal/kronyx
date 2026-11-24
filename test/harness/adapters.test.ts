import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiStreamChunk } from "@cline/llms";
import { collectTurn, toClineMessages } from "../../src/harness/adapters/cline";
import { OpenAIModelPort, parseArguments, toAgentMessages, toModelResponse } from "../../src/harness/adapters/openai";
import type { ModelRequest } from "../../src/harness/contracts";
import { initialState } from "../../src/harness/projections";

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
		const port = new OpenAIModelPort({ providerId: "openai", baseUrl: "https://api.example.test/v1", apiKey: "k", modelId: "m" });
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
		const port = new OpenAIModelPort({ providerId: "openrouter", baseUrl: "https://gw.example.test/v1", apiKey: "k", modelId: "m" });
		const response = await port.complete(request());
		expect(String(fetchMock.mock.calls[0]![0])).toMatch(/chat\/completions$/);
		expect(response.text).toBe("hi");
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

	it("fails the turn when the stream reports failure", async () => {
		async function* stream(): AsyncGenerator<ApiStreamChunk> {
			yield { type: "done", success: false, error: "rate limited", id: "1" };
		}
		await expect(collectTurn(stream())).rejects.toThrow(/rate limited/);
	});
});
