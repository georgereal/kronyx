import { describe, expect, it } from "vitest";
import { parseSessionEvent, type EventBody, type ModelPort, type ModelRequest, type ModelResponse, type SessionEvent, type ToolCall, type ToolPort, type ToolSpec } from "../../src/harness/core/contracts";
import { MemoryEventLog } from "../../src/harness/core/eventLog";
import { HarnessLoop } from "../../src/harness/core/loop";
import { project } from "../../src/harness/core/projections";
import { ConversationStrategy } from "../../src/harness/adapters/openai/conversations";

type Step = Partial<ModelResponse> & { calls?: ToolCall[]; error?: { status: number; message: string } };

/** A model with a Conversations port. Each request is recorded; a step with `error` throws that HTTP status. */
function conversationalModel(script: Step[], model = "gpt-test") {
	const requests: ModelRequest[] = [];
	const created: string[] = [];
	const queue = [...script];
	const conversations = {
		provider: "openai",
		model,
		create: async () => {
			const id = `conv_${created.length + 1}`;
			created.push(id);
			return id;
		},
	};
	const port: ModelPort = {
		conversations,
		strategy: new ConversationStrategy(conversations),
		async complete(request) {
			requests.push(request);
			const next = queue.shift();
			if (!next) throw new Error("model called more times than scripted");
			if (next.error) throw Object.assign(new Error(next.error.message), { status: next.error.status });
			return { text: next.text ?? "", toolCalls: next.calls ?? [], usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 0 }, responseId: `resp_${requests.length}` };
		},
	};
	return { port, requests, created };
}

const noop: ToolSpec = { name: "noop", description: "", inputSchema: {} };
const tools = (): ToolPort => ({ specs: () => [noop], execute: async () => ({ ok: true, output: "ok" }) });
const finish = (text = "done"): Step => ({ text, calls: [] });
const act = (...calls: ToolCall[]): Step => ({ text: "", calls });
const textOf = (messages: ModelRequest["messages"]) => messages.filter((m) => m.kind !== "system").map((m) => (m.kind === "tool" ? "tool" : m.text));
const conversationEvents = (events: SessionEvent[]) => events.filter((e) => e.type.startsWith("conversation.")).map((e) => e.type);
const resetReasons = (events: SessionEvent[]) => events.flatMap((e) => (e.type === "conversation.reset" ? [e.reason] : []));

/** A log that already holds a finished turn synced to a conversation, as a previous run would leave it. */
async function seededLog(tail: EventBody[]) {
	const log = new MemoryEventLog(() => 1);
	await log.append({ type: "user.input", text: "first task", runId: "run-0" });
	await log.append({ type: "model.response", turn: 1, text: "first answer", toolCalls: [], runId: "run-0" });
	for (const body of tail) await log.append({ ...body, runId: "run-0" });
	return log;
}
const boundTail = (sent: boolean, synced: boolean, model = "gpt-test"): EventBody[] => [
	{ type: "conversation.bound", conversationId: "conv_old", provider: "openai", model },
	...(sent ? [{ type: "conversation.sent" as const, throughSeq: 2 }] : []),
	...(synced ? [{ type: "conversation.synced" as const, throughSeq: 2 }] : []),
];

describe("HarnessLoop: conversation mode", () => {
	it("binds once, sends the full history first, then only the delta", async () => {
		const { port, requests, created } = conversationalModel([act({ callId: "c1", name: "noop", input: {} }), finish()]);
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "run-1", log, model: port, tools: tools() });
		expect((await loop.run("go")).status).toBe("completed");
		expect(created).toEqual(["conv_1"]);
		expect(requests.map((r) => r.conversation?.id)).toEqual(["conv_1", "conv_1"]);
		expect(textOf(requests[0]!.messages)).toEqual(["go"]);
		expect(textOf(requests[1]!.messages)).toEqual(["tool"]);
		expect(conversationEvents(await log.read())).toEqual(["conversation.bound", "conversation.sent", "conversation.synced", "conversation.sent", "conversation.synced"]);
	});

	it("sends the task board in the delta once it changes", async () => {
		const createTask: ToolCall = { callId: "c-a", name: "task_create", input: { id: "a", title: "Parse", acceptance: { kind: "none" }, steps: [{ id: "s1", text: "write parser" }] } };
		const { port, requests } = conversationalModel([act(createTask), finish(), finish()]);
		const loop = new HarnessLoop({ runId: "run-1", log: new MemoryEventLog(() => 1), model: port, tools: tools() });
		await loop.run("go");
		const boards = (r: ModelRequest) => r.messages.filter((m) => m.kind === "system" && m.text.startsWith("Task board"));
		expect(boards(requests[1]!)).toHaveLength(1);
	});

	it("rebinds when the model changes, replaying the log into the new conversation", async () => {
		const log = await seededLog(boundTail(true, true, "gpt-old"));
		const { port, requests, created } = conversationalModel([finish()]);
		const loop = new HarnessLoop({ runId: "run-1", log, model: port, tools: tools() });
		await loop.recover();
		expect((await loop.run("second task")).status).toBe("completed");
		expect(created).toEqual(["conv_1"]);
		expect(textOf(requests[0]!.messages)).toEqual(["first task", "first answer", "second task"]);
		expect(resetReasons(await log.read())).toEqual(["model changed"]);
	});

	it("treats a request that never synced as stale after a crash", async () => {
		const log = await seededLog(boundTail(true, false));
		const { port, requests, created } = conversationalModel([finish()]);
		const loop = new HarnessLoop({ runId: "run-1", log, model: port, tools: tools() });
		await loop.recover();
		expect((await loop.run("second task")).status).toBe("completed");
		expect(created).toEqual(["conv_1"]);
		expect(textOf(requests[0]!.messages)).toEqual(["first task", "first answer", "second task"]);
		expect(resetReasons(await log.read())).toEqual(["unfinished request"]);
	});

	it("rebinds and replays when the server no longer has the conversation", async () => {
		const { port, requests, created } = conversationalModel([{ error: { status: 404, message: "No conversation found" } }, finish("ok")]);
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "run-1", log, model: port, tools: tools() });
		expect((await loop.run("go")).status).toBe("completed");
		expect(created).toEqual(["conv_1", "conv_2"]);
		expect(requests.map((r) => r.conversation?.id)).toEqual(["conv_1", "conv_2"]);
		expect(textOf(requests[1]!.messages)).toEqual(["go"]);
		expect(resetReasons(await log.read())).toEqual(["missing"]);
	});

	it("resets the conversation when a call fails, so the next run replays from the log", async () => {
		const { port, requests, created } = conversationalModel([{ error: { status: 500, message: "boom" } }, finish("ok")]);
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "run-1", log, model: port, tools: tools() });
		expect((await loop.run("go")).status).toBe("failed");
		expect(resetReasons(await log.read())).toEqual(["call failed"]);
		expect((await loop.run("again")).status).toBe("completed");
		expect(created).toEqual(["conv_1", "conv_2"]);
		expect(textOf(requests[1]!.messages)).toEqual(["go", "again"]);
	});

	it("stateless models never log conversation events", async () => {
		const requests: ModelRequest[] = [];
		const model: ModelPort = {
			async complete(request) {
				requests.push(request);
				return { text: "done", toolCalls: [] };
			},
		};
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "run-1", log, model, tools: tools() });
		expect((await loop.run("go")).status).toBe("completed");
		expect(requests[0]!.conversation).toBeUndefined();
		expect(conversationEvents(await log.read())).toEqual([]);
	});
});

describe("harness projection: conversation state", () => {
	const ev = (seq: number, body: EventBody) => ({ ...body, seq, at: seq, runId: "r" }) as SessionEvent;

	it("tracks bound, in-flight and synced, and drops the conversation on clear and reset", () => {
		const bound = ev(1, { type: "conversation.bound", conversationId: "c", provider: "openai", model: "m" });
		const sent = project([bound, ev(2, { type: "conversation.sent", throughSeq: 1 })]);
		expect(sent.conversation).toMatchObject({ id: "c", inFlight: true });
		const synced = project([bound, ev(2, { type: "conversation.sent", throughSeq: 1 }), ev(3, { type: "conversation.synced", throughSeq: 3 })]);
		expect(synced.conversation).toMatchObject({ syncedSeq: 3, inFlight: false });
		expect(project([bound, ev(2, { type: "context.cleared" })]).conversation).toBeUndefined();
		expect(project([bound, ev(2, { type: "conversation.reset", reason: "missing" })]).conversation).toBeUndefined();
	});
});

describe("session event parsing: conversation and output items", () => {
	const base = { seq: 1, at: 1, runId: "r" };

	it("accepts the conversation events and validated provider items", () => {
		expect(parseSessionEvent({ ...base, type: "conversation.bound", conversationId: "c", provider: "openai", model: "m" })).toMatchObject({ type: "conversation.bound" });
		expect(parseSessionEvent({ ...base, type: "conversation.sent", throughSeq: 1 })).toMatchObject({ type: "conversation.sent" });
		expect(parseSessionEvent({ ...base, type: "conversation.synced", throughSeq: 2, responseId: "resp_1", boardHash: "h" })).toMatchObject({ type: "conversation.synced" });
		expect(parseSessionEvent({ ...base, type: "conversation.reset", reason: "missing" })).toMatchObject({ type: "conversation.reset" });
		const response = { ...base, type: "model.response", turn: 1, text: "", toolCalls: [], providerItems: { providerId: "openai", modelId: "m", items: [] } };
		expect(parseSessionEvent(response)).toMatchObject({ providerItems: { providerId: "openai", modelId: "m", items: [] } });
		expect(() => parseSessionEvent({ ...response, providerItems: { providerId: "openai", modelId: "m", items: "x" } })).toThrow(/items/);
	});
});
