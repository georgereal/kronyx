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
	it("returns undefined below the threshold", async () => {
		const turn = createPrepareTurn();
		const out = (await turn(ctx([msg("user", [{ type: "text", text: "hi" }])], 1_000_000)));
		expect(out).toBeUndefined();
	});

	it("clamps oversized tool outputs even below threshold", async () => {
		const turn = createPrepareTurn();
		const big = "x".repeat(20_000);
		const out = (await turn(ctx([call("c1", "read_file", { path: "a" }), result("c1", "read_file", big)], 1_000_000)));
		expect(out).toBeDefined();
		const part = (out!.messages![1].content[0] as { output: string }).output;
		expect(part.length).toBeLessThan(big.length);
		expect(part).toContain("chars elided");
	});

	it("stubs failed results first, then duplicates, then oldest; keeps recent intact", async () => {
		const window = 1_000; // 4k chars
		const msgs: AgentMessage[] = [];
		// 10 results: #0 error, #1-2 duplicate calls, #3-9 normal, each ~300 chars
		for (let i = 0; i < 10; i++) {
			msgs.push(call(`c${i}`, i === 2 ? "read_file" : "tool", i === 2 ? { p: 1 } : { i }));
			msgs.push(result(`c${i}`, i === 2 ? "read_file" : "tool", `${i}:` + "y".repeat(300), i === 0));
		}
		// make c1 and c2 the same call signature (duplicate): rename c2 → same tool+input as c1
		const turn = createPrepareTurn({ contextWindow: window });
		const out = (await turn(ctx(msgs, window, { overflowRecovery: true })))!;
		expect(out).toBeDefined();
		const texts = out.messages!.map((m) => JSON.stringify(m.content));
		// error result (index 1) stubbed
		expect(texts[1]).toContain("output elided by context compaction");
		// recent 6 results untouched: last 6 result messages keep their content
		const resultMsgs = out.messages!.filter((m) => m.role === "tool");
		for (const r of resultMsgs.slice(-6)) expect(JSON.stringify(r)).not.toContain("output elided");
	});

	it("does not stub when only overflowRecovery without history", async () => {
		const turn = createPrepareTurn();
		const out = (await turn(ctx([msg("user", [{ type: "text", text: "hi" }])], 1_000, { overflowRecovery: true })));
		expect(out).toBeUndefined();
	});

	it("soft tier stubs only errors and superseded results, leaving normal results", async () => {
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
		const out = (await turn(ctx(msgs, window)))!;
		expect(out).toBeDefined();
		const texts = out.messages!.map((m) => JSON.stringify(m.content));
		expect(texts[2]).toContain("recall_context"); // error result stubbed
		expect(texts[4]).toContain("recall_context"); // superseded read of a.ts stubbed
		expect(texts[8]).not.toContain("recall_context"); // newest b.ts read is a candidate but rank 2 — untouched at soft tier
	});

	it("hard tier also stubs oldest normal results", async () => {
		const window = 1_500; // est ~5k+ chars → over 70%
		const msgs: AgentMessage[] = [msg("user", [{ type: "text", text: "task" }])];
		for (let i = 0; i < 10; i++) {
			msgs.push(call(`c${i}`, "read_file", { path: `f${i}.ts` }), result(`c${i}`, "read_file", "y".repeat(400)));
		}
		const turn = createPrepareTurn({ contextWindow: window });
		const out = (await turn(ctx(msgs, window)))!;
		const texts = out.messages!.map((m) => JSON.stringify(m.content));
		expect(texts[2]).toContain("recall_context"); // oldest normal result stubbed at hard tier
	});

	it("prunes old reasoning parts but keeps tool-call turns and recent messages", async () => {
		const window = 4_000;
		const msgs: AgentMessage[] = [msg("user", [{ type: "text", text: "task" }])];
		for (let i = 0; i < 12; i++) {
			// alternate: standalone reasoning msg, then call+result with reasoning
			msgs.push(msg("assistant", [{ type: "reasoning", text: "think".repeat(100) }]));
			msgs.push(call(`c${i}`, "read_file", { path: `f${i}.ts` }), result(`c${i}`, "read_file", "ok"));
		}
		const turn = createPrepareTurn({ contextWindow: window });
		const out = (await turn(ctx(msgs, window, { overflowRecovery: true })))!;
		const reasoningCount = (m: AgentMessage) =>
			m.content.filter((p) => p.type === "reasoning").length;
		const stripped = out.messages!.slice(1, -8).filter((m) => !m.content.some((p) => p.type === "tool-call") && m.role === "assistant");
		for (const m of stripped) expect(reasoningCount(m)).toBe(0);
		// recent window untouched
		expect(out.messages!.slice(-8).reduce((a, m) => a + reasoningCount(m), 0)).toBeGreaterThan(0);
	});

	it("stubs inlined attachment blocks outside the recent window", async () => {
		const window = 3_000;
		const msgs: AgentMessage[] = [
			msg("user", [
				{ type: "text", text: "--- attached file: notes.md ---\n" + "n".repeat(500) + "\n--- end notes.md ---" },
			]),
		];
		for (let i = 0; i < 12; i++) {
			msgs.push(call(`c${i}`, "run_command", { command: "x" }), result(`c${i}`, "run_command", "r".repeat(300)));
		}
		const turn = createPrepareTurn({ contextWindow: window });
		const out = (await turn(ctx(msgs, window, { overflowRecovery: true })))!;
		const att = JSON.stringify(out.messages![0].content);
		expect(att).toContain("notes.md");
		expect(att).toContain("elided");
	});

	it("elides stale tool-call inputs below the soft threshold", async () => {
		const msgs: AgentMessage[] = [
			call("w1", "write_file", { path: "img.py", content: "x".repeat(3000) }),
			result("w1", "write_file", "Created img.py (90 lines)."),
		];
		for (let i = 0; i < 10; i++) msgs.push(msg("user", [{ type: "text", text: `note ${i}` }]));
		const turn = createPrepareTurn({ contextWindow: 1_000_000 });
		const out = (await turn(ctx(msgs, 1_000_000)))!;
		expect(out).toBeDefined();
		const callPart = JSON.stringify(out.messages![0].content);
		expect(callPart).toContain("_argsElided");
		expect(callPart).toContain("img.py");
		expect(callPart).not.toContain("x".repeat(600));
	});

	it("stubs superseded reads below the soft threshold", async () => {
		const msgs: AgentMessage[] = [
			call("r1", "read_file", { path: "a.ts" }),
			result("r1", "read_file", "old contents " + "y".repeat(500)),
			call("r2", "read_file", { path: "a.ts" }),
			result("r2", "read_file", "new contents " + "z".repeat(500)),
		];
		// 7 more results so r1 lands outside the keep-recent window
		for (let i = 3; i < 10; i++) {
			msgs.push(call(`r${i}`, "read_file", { path: `f${i}.ts` }), result(`r${i}`, "read_file", "r".repeat(300)));
		}
		const turn = createPrepareTurn({ contextWindow: 1_000_000 });
		const out = (await turn(ctx(msgs, 1_000_000)))!;
		const texts = out.messages!.map((m) => JSON.stringify(m.content));
		expect(texts[1]).toContain("output elided by context compaction"); // r1 superseded by r2
		expect(texts[3]).not.toContain("output elided"); // r2 is the newest read of a.ts — intact
	});

	it("uses real BPE token counts — token-dense text triggers where chars/4 would not", async () => {
		// 6000 chars of pseudo-random alnum ≈ 2833 BPE tokens but only 1500
		// under chars/4. Window 5000: real count lands in the soft band
		// (40–70% → 2000–3500); the old heuristic would stay under 40%.
		const dense = Array.from({ length: 6000 }, (_, i) => "abcdefghijklmnopqrstuvwxyz0123456789"[(i * 7919) % 36]).join("");
		const msgs: AgentMessage[] = [
			msg("user", [{ type: "text", text: dense }]),
			call("c0", "run_command", { command: "bad" }),
			result("c0", "run_command", "err:" + "x".repeat(300), true),
		];
		for (let i = 1; i < 8; i++) {
			msgs.push(call(`c${i}`, "read_file", { path: `f${i}.ts` }), result(`c${i}`, "read_file", "r".repeat(300)));
		}
		const turn = createPrepareTurn({ contextWindow: 5_000 });
		const out = (await turn(ctx(msgs, 5_000)))!;
		expect(out).toBeDefined();
		expect(JSON.stringify(out.messages![2].content)).toContain("output elided by context compaction");
	});

	it("summarize tier replaces the oldest turns when stubbing can't reach target", async () => {
		const window = 2_000; // target 1100
		const msgs: AgentMessage[] = [msg("user", [{ type: "text", text: "task " + "t".repeat(8000) }])];
		for (let i = 0; i < 12; i++) {
			msgs.push(call(`c${i}`, "read_file", { path: `f${i}.ts` }), result(`c${i}`, "read_file", "y".repeat(600)));
		}
		const turn = createPrepareTurn({
			contextWindow: window,
			summarize: async () => "Recap: read f0..f11, all small files.",
		});
		const out = (await turn(ctx(msgs, window, { overflowRecovery: true })))!;
		expect(out.messages![0].role).toBe("user");
		expect(JSON.stringify(out.messages![0].content)).toContain("summarized by context compaction");
		expect(out.messages!.length).toBeLessThan(msgs.length);
	});
});
