import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, AgentTool } from "@cline/shared";
import { OpenAIEngine } from "../src/agent/openaiEngine";
import { chatBody, reduceChat, reduceResponses, sseEvents, toChatMessages, toResponsesInput } from "../src/agent/openaiWire";
import type { ProviderSettings, RunViewEvent, RunnerHost } from "../src/agent/runner";
import { Semaphore } from "../src/agent/concurrency";

const sse = (events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const sseResponse = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/event-stream" } });

const textTurn = (id: string, text: string) =>
	sse([
		{ type: "response.created", response: { id } },
		{ type: "response.output_text.delta", delta: text },
		{ type: "response.completed", response: { id, usage: { input_tokens: 50, output_tokens: 5, input_tokens_details: { cached_tokens: 20 } } } },
	]);

const callTurn = (id: string, calls: { callId: string; name: string; args: object }[]) =>
	sse([
		{ type: "response.created", response: { id } },
		...calls.map((c) => ({ type: "response.output_item.done", item: { type: "function_call", call_id: c.callId, name: c.name, arguments: JSON.stringify(c.args) } })),
		{ type: "response.completed", response: { id, usage: { input_tokens: 100, output_tokens: 10 } } },
	]);

const reader: AgentTool<{ path: string }, string> = {
	name: "read_thing",
	description: "Read a thing.",
	inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	executionMode: "parallel",
	execute: async (input) => `contents of ${input.path}`,
};

const openaiSettings: ProviderSettings = {
	providerId: "openai",
	baseUrl: "https://api.example.test/v1",
	modelId: "gpt-test",
	apiKey: "sk-test",
	maxIterations: 6,
};

function makeHost(tools: AgentTool<any, string>[] = [reader]) {
	const events: RunViewEvent[] = [];
	const host: RunnerHost = {
		workspaceRoot: "/tmp/ws",
		isDirty: () => false,
		relativePath: (p) => p,
		currentMode: () => "code",
		emit: (e) => events.push(e),
		tools: async () => tools,
	};
	return { host, events };
}

const bodies = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("wire conversion", () => {
	it("maps history to Responses input: function_call + function_call_output, images as data URLs", () => {
		const history: AgentMessage[] = [
			{ id: "u1", role: "user", createdAt: 0, content: [{ type: "text", text: "look" }, { type: "image", image: new Uint8Array([1, 2]), mediaType: "image/png" }] },
			{ id: "a1", role: "assistant", createdAt: 0, content: [{ type: "text", text: "reading" }, { type: "tool-call", toolCallId: "c1", toolName: "read_thing", input: { path: "a" } }] },
			{ id: "t1", role: "tool", createdAt: 0, content: [{ type: "tool-result", toolCallId: "c1", toolName: "read_thing", output: "body" }] },
		];
		const input = toResponsesInput(history);
		expect(input[0]).toMatchObject({ role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image" }] });
		expect((input[0].content as { image_url: string }[])[1].image_url).toBe(`data:image/png;base64,${Buffer.from([1, 2]).toString("base64")}`);
		expect(input[1]).toEqual({ role: "assistant", content: [{ type: "output_text", text: "reading" }] });
		expect(input[2]).toEqual({ type: "function_call", call_id: "c1", name: "read_thing", arguments: '{"path":"a"}' });
		expect(input[3]).toEqual({ type: "function_call_output", call_id: "c1", output: "body" });
	});

	it("maps history to chat messages with the system prompt first and tool results as role=tool", () => {
		const msgs = toChatMessages("SYS", [
			{ id: "a1", role: "assistant", createdAt: 0, content: [{ type: "tool-call", toolCallId: "c1", toolName: "read_thing", input: { path: "a" } }] },
			{ id: "t1", role: "tool", createdAt: 0, content: [{ type: "tool-result", toolCallId: "c1", toolName: "read_thing", output: "body" }] },
		]);
		expect(msgs[0]).toEqual({ role: "system", content: "SYS" });
		expect(msgs[1]).toMatchObject({ role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "read_thing" } }] });
		expect(msgs[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "body" });
	});

	it("parses SSE frames split across chunk boundaries", async () => {
		const text = sse([{ type: "a" }, { type: "b" }]);
		const chunks = [text.slice(0, 7), text.slice(7, 30), text.slice(30)].map((c) => new TextEncoder().encode(c));
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const c of chunks) controller.enqueue(c);
				controller.close();
			},
		});
		const out: string[] = [];
		for await (const ev of sseEvents(body)) out.push(JSON.parse(ev.data).type);
		expect(out).toEqual(["a", "b"]);
	});

	it("rejects a Responses stream that ends before response.completed", async () => {
		const events = (async function* () {
			yield { event: "", data: JSON.stringify({ type: "response.output_text.delta", delta: "partial" }) };
		})();
		await expect(reduceResponses(events, { onText: () => {}, onReasoning: () => {} })).rejects.toThrow(/ended before/);
	});

	it("merges chat tool-call fragments by index and reads usage from the final chunk", async () => {
		const frames = [
			{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_thing", arguments: '{"pa' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] }, finish_reason: "tool_calls" }] },
			{ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } },
		];
		const events = (async function* () {
			for (const f of frames) yield { event: "", data: JSON.stringify(f) };
			yield { event: "", data: "[DONE]" };
		})();
		const out = await reduceChat(events, { onText: () => {}, onReasoning: () => {} });
		expect(out.calls).toEqual([{ callId: "c1", name: "read_thing", args: '{"path":"x"}' }]);
		expect(out.usage.inputTokens).toBe(9);
		expect(chatBody({ model: "m", messages: [], tools: [reader] })).toMatchObject({ stream: true, stream_options: { include_usage: true } });
	});
});

describe("OpenAIEngine", () => {
	it("chains the OpenAI Responses turns with previous_response_id and sends only the delta", async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(sseResponse(callTurn("resp_1", [{ callId: "c1", name: "read_thing", args: { path: "a.ts" } }])))
			.mockResolvedValueOnce(sseResponse(textTurn("resp_2", "Done.")));
		vi.stubGlobal("fetch", fetchMock);
		const { host, events } = makeHost();
		const engine = new OpenAIEngine(host);

		await engine.run("read a.ts", openaiSettings);

		const [first, second] = bodies(fetchMock);
		expect(first.previous_response_id).toBeUndefined();
		expect(first.store).toBe(true);
		expect(first.context_management).toBeDefined();
		expect(second.previous_response_id).toBe("resp_1");
		expect(second.input).toEqual([{ type: "function_call_output", call_id: "c1", output: "contents of a.ts" }]);
		expect(events.find((e) => e.type === "tool-finished")).toMatchObject({ ok: true, name: "read_thing" });
		expect(events.at(-1)).toMatchObject({ type: "run-finished", status: "completed", text: "Done." });
	});

	it("uses stateless chat completions for non-OpenAI providers and resends the full history", async () => {
		const chatStream = sse([
			{ choices: [{ delta: { content: "Hi" } }] },
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
			{ choices: [], usage: { prompt_tokens: 4, completion_tokens: 1 } },
		]) + "data: [DONE]\n\n";
		const fetchMock = vi.fn().mockResolvedValueOnce(sseResponse(chatStream));
		vi.stubGlobal("fetch", fetchMock);
		const { host, events } = makeHost();
		const engine = new OpenAIEngine(host);

		await engine.run("hello", { ...openaiSettings, providerId: "openrouter" });

		const [url] = fetchMock.mock.calls[0] as [string];
		expect(url).toBe("https://api.example.test/v1/chat/completions");
		const body = bodies(fetchMock)[0];
		expect(body.previous_response_id).toBeUndefined();
		expect(body.messages[0].role).toBe("system");
		expect(body.messages.at(-1)).toEqual({ role: "user", content: "hello" });
		expect(events.at(-1)).toMatchObject({ type: "run-finished", status: "completed" });
	});

	it("runs adjacent parallel reads concurrently in one batch", async () => {
		let active = 0;
		let peak = 0;
		const slow: AgentTool<{ path: string }, string> = {
			...reader,
			execute: async (input) => {
				active++;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 20));
				active--;
				return `ok ${input.path}`;
			},
		};
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(sseResponse(callTurn("resp_1", [{ callId: "c1", name: "read_thing", args: { path: "a" } }, { callId: "c2", name: "read_thing", args: { path: "b" } }])))
			.mockResolvedValueOnce(sseResponse(textTurn("resp_2", "ok")));
		vi.stubGlobal("fetch", fetchMock);
		const { host, events } = makeHost([slow]);

		await new OpenAIEngine(host).run("read both", openaiSettings);

		expect(peak).toBe(2);
		const second = bodies(fetchMock)[1];
		expect(second.input.map((i: { call_id: string }) => i.call_id)).toEqual(["c1", "c2"]);
		expect(events.filter((e) => e.type === "tool-finished")).toHaveLength(2);
	});

	it("retries a rate-limited request before the stream starts", async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response("slow down", { status: 429 }))
			.mockResolvedValueOnce(sseResponse(textTurn("resp_1", "ok")));
		vi.stubGlobal("fetch", fetchMock);
		const { host, events } = makeHost();

		await new OpenAIEngine(host).run("hi", openaiSettings);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(events.at(-1)).toMatchObject({ type: "run-finished", status: "completed" });
	}, 10_000);

	it("reports response.failed as run-failed with the provider message", async () => {
		const failed = sse([{ type: "response.created", response: { id: "resp_x" } }, { type: "response.failed", response: { error: { message: "model overloaded" } } }]);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(sseResponse(failed)));
		const { host, events } = makeHost();

		await new OpenAIEngine(host).run("hi", openaiSettings);

		expect(events.at(-1)).toMatchObject({ type: "run-failed", error: "model overloaded" });
	});

	it("stop() aborts an in-flight stream and finishes the run as stopped", async () => {
		let release: (() => void) | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(sse([{ type: "response.created", response: { id: "resp_1" } }])));
				release = () => controller.error(new DOMException("aborted", "AbortError"));
			},
		});
		vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
			init.signal?.addEventListener("abort", () => release?.());
			return new Response(body, { status: 200 });
		}));
		const { host, events } = makeHost();
		const engine = new OpenAIEngine(host);

		const run = engine.run("long task", openaiSettings);
		await vi.waitFor(() => expect(events.some((e) => e.type === "run-started")).toBe(true));
		engine.stop();
		await run;

		expect(events.at(-1)).toMatchObject({ type: "run-finished", status: "stopped" });
	});
});

describe("Semaphore", () => {
	it("never runs more than its limit at once", async () => {
		const gate = new Semaphore(2);
		let active = 0;
		let peak = 0;
		await Promise.all(
			Array.from({ length: 6 }, () =>
				gate.run(async () => {
					active++;
					peak = Math.max(peak, active);
					await new Promise((r) => setTimeout(r, 5));
					active--;
				}),
			),
		);
		expect(peak).toBe(2);
	});
});
