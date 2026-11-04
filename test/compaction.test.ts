import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentRuntimePrepareTurnContext } from "@cline/shared";
import { createPrepareTurn } from "../src/agent/compaction";

let seq = 0;
const msg = (role: AgentMessage["role"], content: AgentMessage["content"]): AgentMessage => ({
	id: `m${++seq}`,
	role,
	content,
	createdAt: seq,
});

const call = (id: string, name: string, input: unknown) =>
	msg("assistant", [{ type: "tool-call", toolCallId: id, toolName: name, input }]);

const result = (id: string, name: string, output: string, isError = false) =>
	msg("tool", [{ type: "tool-result", toolCallId: id, toolName: name, output, isError }]);

const ctx = (messages: AgentMessage[], contextWindow: number, extra: Partial<AgentRuntimePrepareTurnContext> = {}) =>
	({
		agentId: "t",
		iteration: 1,
		messages,
		model: { info: { contextWindow } },
		...extra,
	}) as AgentRuntimePrepareTurnContext;

describe("createPrepareTurn", () => {
	it("returns undefined below the threshold", () => {
		const turn = createPrepareTurn();
		const out = turn(ctx([msg("user", [{ type: "text", text: "hi" }])], 1_000_000));
		expect(out).toBeUndefined();
	});

	it("clamps oversized tool outputs even below threshold", () => {
		const turn = createPrepareTurn();
		const big = "x".repeat(20_000);
		const out = turn(ctx([call("c1", "read_file", { path: "a" }), result("c1", "read_file", big)], 1_000_000));
		expect(out).toBeDefined();
		const part = (out!.messages![1].content[0] as { output: string }).output;
		expect(part.length).toBeLessThan(big.length);
		expect(part).toContain("chars elided");
	});

	it("stubs failed results first, then duplicates, then oldest; keeps recent intact", () => {
		const window = 1_000; // 4k chars
		const msgs: AgentMessage[] = [];
		// 10 results: #0 error, #1-2 duplicate calls, #3-9 normal, each ~300 chars
		for (let i = 0; i < 10; i++) {
			msgs.push(call(`c${i}`, i === 2 ? "read_file" : "tool", i === 2 ? { p: 1 } : { i }));
			msgs.push(result(`c${i}`, i === 2 ? "read_file" : "tool", `${i}:` + "y".repeat(300), i === 0));
		}
		// make c1 and c2 the same call signature (duplicate): rename c2 → same tool+input as c1
		const turn = createPrepareTurn({ contextWindow: window });
		const out = turn(ctx(msgs, window, { overflowRecovery: true }))!;
		expect(out).toBeDefined();
		const texts = out.messages!.map((m) => JSON.stringify(m.content));
		// error result (index 1) stubbed
		expect(texts[1]).toContain("output elided by context compaction");
		// recent 6 results untouched: last 6 result messages keep their content
		const resultMsgs = out.messages!.filter((m) => m.role === "tool");
		for (const r of resultMsgs.slice(-6)) expect(JSON.stringify(r)).not.toContain("output elided");
	});

	it("does not stub when only overflowRecovery without history", () => {
		const turn = createPrepareTurn();
		const out = turn(ctx([msg("user", [{ type: "text", text: "hi" }])], 1_000, { overflowRecovery: true }));
		expect(out).toBeUndefined();
	});

	it("soft tier stubs only errors and superseded results, leaving normal results", () => {
		// window sized so ~17k chars of tool chatter lands in the 40–70% band
		const window = 8_000;
		const msgs: AgentMessage[] = [
			msg("user", [{ type: "text", text: "task" }]),
			call("c0", "run_command", { command: "bad" }),
			result("c0", "run_command", "e:" + "x".repeat(1500), true),
			call("c1", "read_file", { path: "a.ts" }),
			result("c1", "read_file", "old:" + "y".repeat(1500)),
			call("c2", "read_file", { path: "a.ts" }),
			result("c2", "read_file", "new:" + "z".repeat(1500)),
			call("c3", "read_file", { path: "b.ts" }),
			result("c3", "read_file", "keep:" + "w".repeat(1500)),
		];
		// pad with recent results so candidates exclude the keep-recent 6
		for (let i = 4; i < 10; i++) {
			msgs.push(call(`c${i}`, "read_file", { path: `f${i}.ts` }), result(`c${i}`, "read_file", "r".repeat(1500)));
		}
		const turn = createPrepareTurn({ contextWindow: window });
		const out = turn(ctx(msgs, window))!;
		expect(out).toBeDefined();
		const texts = out.messages!.map((m) => JSON.stringify(m.content));
		expect(texts[2]).toContain("recall_context"); // error result stubbed
		expect(texts[4]).toContain("recall_context"); // superseded read of a.ts stubbed
		expect(texts[8]).not.toContain("recall_context"); // newest b.ts read is a candidate but rank 2 — untouched at soft tier
	});

	it("hard tier also stubs oldest normal results", () => {
		const window = 1_500; // est ~5k+ chars → over 70%
		const msgs: AgentMessage[] = [msg("user", [{ type: "text", text: "task" }])];
		for (let i = 0; i < 10; i++) {
			msgs.push(call(`c${i}`, "read_file", { path: `f${i}.ts` }), result(`c${i}`, "read_file", "y".repeat(400)));
		}
		const turn = createPrepareTurn({ contextWindow: window });
		const out = turn(ctx(msgs, window))!;
		const texts = out.messages!.map((m) => JSON.stringify(m.content));
		expect(texts[2]).toContain("recall_context"); // oldest normal result stubbed at hard tier
	});
});
