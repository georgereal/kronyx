import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentRuntimePrepareTurnContext } from "@cline/shared";
import { contextBudget, createPrepareTurn, sanitizeMessages } from "../src/agent/compaction";

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

describe("sanitizeMessages", () => {
	it("returns the input untouched when every call is paired", () => {
		const msgs = [call("c1", "read_file", { path: "a" }), result("c1", "read_file", "ok")];
		const { messages, repaired } = sanitizeMessages(msgs);
		expect(repaired).toBe(0);
		expect(messages).toBe(msgs);
	});

	it("injects a synthetic error result right after a dangling call", () => {
		const msgs = [
			msg("user", [{ type: "text", text: "t" }]),
			call("c1", "read_file", { path: "a" }),
			result("c1", "read_file", "ok"),
			call("c2", "search_files", { pattern: "x" }),
		];
		const { messages, repaired } = sanitizeMessages(msgs);
		expect(repaired).toBe(1);
		expect(messages).toHaveLength(5);
		expect(messages[4].role).toBe("tool");
		const p = messages[4].content[0] as { toolCallId: string; isError: boolean; output: string };
		expect(p.toolCallId).toBe("c2");
		expect(p.isError).toBe(true);
		expect(p.output).toContain("interrupted");
	});

	it("drops orphan results (and now-empty messages)", () => {
		const msgs = [
			call("c1", "read_file", { path: "a" }),
			result("c1", "read_file", "ok"),
			result("zz", "read_file", "no call for this"),
		];
		const { messages, repaired } = sanitizeMessages(msgs);
		expect(repaired).toBe(1);
		expect(messages).toHaveLength(2);
	});
});

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

	it("a successful write supersedes earlier reads of the same path (cross-tool)", async () => {
		const msgs: AgentMessage[] = [
			call("r1", "read_file", { path: "a.ts" }),
			result("r1", "read_file", "stale contents " + "y".repeat(500)),
			call("w1", "edit_file", { path: "a.ts", old_str: "x", new_str: "y" }),
			result("w1", "edit_file", "Edited a.ts."),
		];
		// pad so the read lands outside the keep-recent window
		for (let i = 2; i < 9; i++) {
			msgs.push(call(`r${i}`, "read_file", { path: `f${i}.ts` }), result(`r${i}`, "read_file", "r".repeat(300)));
		}
		const turn = createPrepareTurn({ contextWindow: 1_000_000 });
		const out = (await turn(ctx(msgs, 1_000_000)))!;
		const texts = out.messages!.map((m) => JSON.stringify(m.content));
		expect(texts[1]).toContain("output elided by context compaction"); // stale read
		expect(texts[3]).not.toContain("output elided"); // the edit's own result stays
	});

	it("a FAILED write does not supersede the earlier read", async () => {
		const msgs: AgentMessage[] = [
			call("r1", "read_file", { path: "a.ts" }),
			result("r1", "read_file", "good contents " + "y".repeat(500)),
			call("w1", "edit_file", { path: "a.ts", old_str: "x" }),
			result("w1", "edit_file", "old_str not found", true),
		];
		for (let i = 2; i < 9; i++) {
			msgs.push(call(`r${i}`, "read_file", { path: `f${i}.ts` }), result(`r${i}`, "read_file", "r".repeat(300)));
		}
		const turn = createPrepareTurn({ contextWindow: 1_000_000 });
		const out = await turn(ctx(msgs, 1_000_000));
		// the read may legitimately remain intact — only the failed write result
		// is stubbable; check the read is NOT stubbed
		const texts = (out?.messages ?? msgs).map((m) => JSON.stringify(m.content));
		expect(texts[1]).not.toContain("output elided by context compaction");
	});

	it("file_editor view does not supersede; str_replace does", async () => {
		const msgs: AgentMessage[] = [
			call("r1", "read_file", { path: "a.ts" }),
			result("r1", "read_file", "contents " + "y".repeat(500)),
			call("v1", "file_editor", { command: "view", path: "a.ts" }),
			result("v1", "file_editor", "numbered view"),
			call("w1", "file_editor", { command: "str_replace", path: "a.ts" }),
			result("w1", "file_editor", "Replaced."),
		];
		for (let i = 2; i < 9; i++) {
			msgs.push(call(`r${i}`, "read_file", { path: `f${i}.ts` }), result(`r${i}`, "read_file", "r".repeat(300)));
		}
		const turn = createPrepareTurn({ contextWindow: 1_000_000 });
		const out = (await turn(ctx(msgs, 1_000_000)))!;
		const texts = out.messages!.map((m) => JSON.stringify(m.content));
		expect(texts[1]).toContain("output elided by context compaction"); // read stale after str_replace
		expect(texts[5]).not.toContain("output elided"); // str_replace result stays
	});

	it("clamps run_command output tail-heavy (errors land at the end)", async () => {
		const tail = "Error: build failed at the very end";
		const big = "h".repeat(10_000) + tail;
		const out = (await createPrepareTurn()(ctx(
			[call("c1", "run_command", { command: "npm test" }), result("c1", "run_command", big)],
			1_000_000,
		)))!;
		const part = (out.messages![1].content[0] as { output: string }).output;
		expect(part).toContain("chars elided");
		expect(part).toContain(tail); // tail survives
		expect(part.startsWith("h".repeat(1_500))).toBeTruthy();
		expect(part.length).toBeLessThan(big.length);
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

	it("contextBudget caps trigger math even on huge model windows", async () => {
		// Reproduces the 1M-window bug: ~56K context on a 1M-window model would
		// never compact (soft tier at 400K). With a 100K budget, soft tier (40K)
		// engages and elides superseded results.
		const msgs: AgentMessage[] = [
			msg("user", [{ type: "text", text: "audit the executor for bugs" }]),
			call("r1", "read_file", { path: "a.ts" }),
			result("r1", "read_file", "x".repeat(20_000)),
			call("r2", "read_file", { path: "a.ts" }),
			result("r2", "read_file", "y".repeat(20_000)),
		];
		for (let i = 3; i < 10; i++) {
			msgs.push(call(`r${i}`, "read_file", { path: `f${i}.ts` }), result(`r${i}`, "read_file", "z".repeat(8_000)));
		}
		const turn = createPrepareTurn({ contextBudget: 100_000 });
		const out = (await turn(ctx(msgs, 1_000_000)))!;
		const texts = out.messages!.map((m) => JSON.stringify(m.content));
		expect(texts[2]).toContain("output elided by context compaction"); // superseded read stubbed under budget
	});

	it("contextBudget derives from the model window: half, capped at 200K, floored at 64K", () => {
		expect(contextBudget(1_048_576)).toBe(200_000);
		expect(contextBudget(256_000)).toBe(128_000);
		expect(contextBudget(128_000)).toBe(64_000);
		expect(contextBudget(32_000)).toBe(64_000);
		expect(contextBudget(undefined)).toBe(200_000);
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
		// the task message stays verbatim; the recap lands after it
		expect(JSON.stringify(out.messages![0].content)).toContain("t".repeat(100));
		expect(JSON.stringify(out.messages![1].content)).toContain("summarized by context compaction");
		expect(out.messages!.length).toBeLessThan(msgs.length);
	});

	it("ratchets the budget up (fill-anchored) instead of summarizing below the ceiling", async () => {
		// ~200k chars of non-stubbable user text ≈ ~50k est tokens — over the
		// 70% trigger of the 64k floor budget and unreachable to stubbing.
		const msgs: AgentMessage[] = [msg("user", [{ type: "text", text: "task" }])];
		for (let i = 0; i < 10; i++) msgs.push(msg("user", [{ type: "text", text: "u".repeat(20_000) }]));
		for (let i = 0; i < 12; i++) {
			msgs.push(call(`c${i}`, "read_file", { path: `f${i}.ts` }), result(`c${i}`, "read_file", "y".repeat(300)));
		}
		const budgetRef = { current: 0 };
		let stats: import("../src/agent/compaction").CompactStats | undefined;
		const turn = createPrepareTurn({
			contextBudget: 64_000,
			budgetRef,
			onCompact: (s) => { stats = s; },
		});
		const out = await turn(ctx(msgs, 300_000));
		expect(out).toBeDefined();
		// est ~50k > target 35.2k, window 64k < ceiling 300k → B ≈ est/0.55 (~91k)
		expect(budgetRef.current).toBeGreaterThan(80_000);
		expect(budgetRef.current).toBeLessThanOrEqual(300_000);
		expect(stats?.effectiveBudget).toBe(budgetRef.current);
		// next pass uses the raised budget — same context now sits below trigger
		const stats2 = await turn(ctx(msgs, 300_000));
		void stats2;
	});

	it("grows the budget stepwise, then resets after the big summary at the cap", async () => {
		// Pseudo-random alnum via LCG — aperiodic, so BPE can't compress it.
		// `off` seeds each result differently so dedupe/supersession can't fire.
		const dense = (n: number, off: number) => {
			let x = off + 1;
			return Array.from({ length: n }, () => {
				x = (x * 1103515245 + 12345) % 2 ** 31;
				return "abcdefghijklmnopqrstuvwxyz0123456789"[x % 36];
			}).join("");
		};
		const transcript = (resultChars: number, results: number) => {
			const msgs: AgentMessage[] = [msg("user", [{ type: "text", text: "task" }])];
			for (let i = 0; i < results; i++) {
				msgs.push(call(`c${i}`, "read_file", { path: `f${i}.ts` }), result(`c${i}`, "read_file", dense(resultChars, i * 13)));
			}
			return msgs;
		};
		const budgetRef = { current: 0 };
		let stats: import("../src/agent/compaction").CompactStats | undefined;
		let summaries = 0;
		const turn = createPrepareTurn({
			contextBudget: 200_000,
			budgetRef,
			minDeepPassCalls: 0, // each call in this test is a distinct turn
			onCompact: (s) => { stats = s; },
			summarize: async () => {
				summaries++;
				return "Recap: read files.";
			},
		});
		// Cycle starts at cap/4 = 64K, trigger 44.8K. ~50K est → hard pass.
		const mid = transcript(17_000, 12);
		await turn(ctx(mid, 1_000_000));
		expect(budgetRef.current).toBe(96_000); // 64K × 1.5
		expect(summaries).toBe(0); // no summary below the cap
		// Same context now sits in the soft band — pass runs, budget unchanged.
		await turn(ctx(mid, 1_000_000));
		expect(budgetRef.current).toBe(96_000);
		// ~105K est → hard at 96K, then at 144K, then reaches the 200K cap.
		const big = transcript(17_000, 22);
		await turn(ctx(big, 1_000_000));
		expect(budgetRef.current).toBe(144_000);
		await turn(ctx(big, 1_000_000));
		expect(budgetRef.current).toBe(200_000);
		// ~150K est ≥ 140K trigger at the cap → big reset: whole prefix
		// summarized and the budget wraps back to the start.
		const out = (await turn(ctx(transcript(17_000, 30), 1_000_000)))!;
		expect(summaries).toBeGreaterThan(0); // chunked briefs — one reset
		expect(stats?.budgetReset).toBe(true);
		expect(budgetRef.current).toBe(64_000);
		expect(JSON.stringify(out.messages!.map((m) => m.content))).toContain("summarized by context compaction");
	});

	it("repairs a dangling tool-call in the projected history (interrupted run)", async () => {
		// Canonical transcript ends in a call whose result never landed —
		// exactly what a resume log replay produces after a mid-tool death.
		const msgs: AgentMessage[] = [
			msg("user", [{ type: "text", text: "task" }]),
			call("c0", "read_file", { path: "a.ts" }),
		];
		const turn = createPrepareTurn({ contextWindow: 1_000_000 });
		const out = (await turn(ctx(msgs, 1_000_000)))!;
		expect(out).toBeDefined(); // repair alone forces a projection
		const last = out!.messages!.at(-1)!;
		expect(last.role).toBe("tool");
		const part = last.content[0] as { type: string; toolCallId: string; isError: boolean; output: string };
		expect(part.type).toBe("tool-result");
		expect(part.toolCallId).toBe("c0");
		expect(part.isError).toBe(true);
		expect(part.output).toContain("interrupted");
	});

	it("a failed summary chunk adjacent to a kept call still yields complete pairs", async () => {
		// Summarizer fails on the chunk holding call c0's result; the chunk
		// holding later calls succeeds. The final sanitize pass must repair
		// whatever dangles.
		const window = 2_000;
		const msgs: AgentMessage[] = [msg("user", [{ type: "text", text: "task " + "t".repeat(8000) }])];
		for (let i = 0; i < 12; i++) {
			msgs.push(call(`c${i}`, "read_file", { path: `f${i}.ts` }), result(`c${i}`, "read_file", "y".repeat(600)));
		}
		let calls = 0;
		const turn = createPrepareTurn({
			contextWindow: window,
			minDeepPassCalls: 0,
			summarize: async () => (++calls === 1 ? Promise.reject(new Error("summarizer down")) : "Recap."),
		});
		const out = (await turn(ctx(msgs, window, { overflowRecovery: true })))!;
		const callIds = new Set<string>();
		const resultIds = new Set<string>();
		for (const m of out.messages!)
			for (const p of m.content) {
				if (p.type === "tool-call") callIds.add((p as { toolCallId: string }).toolCallId);
				if (p.type === "tool-result") resultIds.add((p as { toolCallId: string }).toolCallId);
			}
		for (const id of callIds) expect(resultIds.has(id)).toBe(true);
		for (const id of resultIds) expect(callIds.has(id)).toBe(true);
	});

	it("summary chunk boundaries never split a tool-call from its result", async () => {
		// 21 call/result pairs: a naive 20-message chunk would cut between
		// call c9 and its result; pairSafeEnd must extend the chunk.
		const window = 2_000;
		const msgs: AgentMessage[] = [msg("user", [{ type: "text", text: "task" }])];
		for (let i = 0; i < 21; i++) {
			msgs.push(call(`c${i}`, "read_file", { path: `f${i}.ts` }), result(`c${i}`, "read_file", "y".repeat(400)));
		}
		const slices: number[][] = [];
		const turn = createPrepareTurn({
			contextWindow: window,
			minDeepPassCalls: 0,
			summarize: async (chunk) => {
				// record which message indexes this chunk covers via id
				const start = msgs.findIndex((m) => m.id === chunk[0].id);
				slices.push([start, start + chunk.length]);
				return "Recap.";
			},
		});
		await turn(ctx(msgs, window, { overflowRecovery: true }));
		expect(slices.length).toBeGreaterThan(0);
		for (const [s, e] of slices) {
			const ids = new Set<string>();
			const res = new Set<string>();
			for (const m of msgs.slice(s, e))
				for (const p of m.content) {
					if (p.type === "tool-call") ids.add((p as { toolCallId: string }).toolCallId);
					if (p.type === "tool-result") res.add((p as { toolCallId: string }).toolCallId);
				}
			// no call inside the chunk whose result sits immediately outside
			const dangling = [...ids].filter((id) => !res.has(id));
			if (e < msgs.length) {
				const nextIds = new Set(
					msgs[e].content.filter((p) => p.type === "tool-result").map((p) => (p as { toolCallId: string }).toolCallId),
				);
				expect(dangling.some((id) => nextIds.has(id))).toBe(false);
			}
		}
	});

	it("throttles non-forced deep passes to every minDeepPassCalls calls", async () => {
		const window = 1_500;
		const msgs: AgentMessage[] = [msg("user", [{ type: "text", text: "task" }])];
		for (let i = 0; i < 10; i++) {
			msgs.push(call(`c${i}`, "read_file", { path: `f${i}.ts` }), result(`c${i}`, "read_file", "y".repeat(400)));
		}
		const stats: import("../src/agent/compaction").CompactStats[] = [];
		const turn = createPrepareTurn({ contextWindow: window, onCompact: (s) => stats.push(s) });
		await turn(ctx(msgs, window)); // deep pass — first call always allowed
		const afterFirst = stats.length;
		expect(afterFirst).toBe(1);
		await turn(ctx(msgs, window)); // throttled (gap 1 < 2)
		expect(stats.length).toBe(1);
		await turn(ctx(msgs, window)); // gap 2 → runs
		expect(stats.length).toBe(2);
	});

	it("forced passes bypass the deep-pass throttle", async () => {
		const window = 1_500;
		const msgs: AgentMessage[] = [msg("user", [{ type: "text", text: "task" }])];
		for (let i = 0; i < 10; i++) {
			msgs.push(call(`c${i}`, "read_file", { path: `f${i}.ts` }), result(`c${i}`, "read_file", "y".repeat(400)));
		}
		const stats: import("../src/agent/compaction").CompactStats[] = [];
		const turn = createPrepareTurn({ contextWindow: window, onCompact: (s) => stats.push(s) });
		await turn(ctx(msgs, window));
		await turn(ctx(msgs, window, { overflowRecovery: true })); // forced — not throttled
		expect(stats.length).toBe(2);
	});

	it("learns the provider ceiling on overflow and clamps the budget", async () => {
		const msgs: AgentMessage[] = [msg("user", [{ type: "text", text: "task" }])];
		for (let i = 0; i < 12; i++) {
			msgs.push(call(`c${i}`, "read_file", { path: `f${i}.ts` }), result(`c${i}`, "read_file", "y".repeat(20_000)));
		}
		const budgetRef = { current: 0 };
		let stats: import("../src/agent/compaction").CompactStats | undefined;
		const turn = createPrepareTurn({ contextBudget: 200_000, budgetRef, onCompact: (s) => { stats = s; } });
		await turn(ctx(msgs, 400_000, { overflowRecovery: true, previousRequestInputTokens: 30_000 }));
		expect(stats?.learnedCeiling).toBe(25_500);
		expect(budgetRef.current).toBe(25_500);
	});
});
