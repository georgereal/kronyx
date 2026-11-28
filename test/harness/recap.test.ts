import { describe, expect, it } from "vitest";
import type { ModelPort, ModelRequest, ToolPort } from "../../src/harness/core/contracts";
import { MemoryEventLog } from "../../src/harness/core/eventLog";
import { HarnessLoop } from "../../src/harness/core/loop";
import { buildContext, COMPACT_CHUNK, KEEP_RECENT_MESSAGES } from "../../src/harness/defaults/context";
import { makeRecap } from "../../src/harness/defaults/recap";
import { initialState } from "../../src/harness/core/projections";

const tools: ToolPort = { specs: () => [], execute: async () => ({ ok: true, output: "" }) };

/** Model that answers recap requests (no tools, system = RECAP) with a brief, and everything else with text. */
function recapModel(opts: { failRecap?: boolean } = {}) {
	const recapCalls: number[] = [];
	const model: ModelPort = {
		complete: async (req) => {
			if (req.tools.length === 0 && req.system.startsWith("You write a brief")) {
				recapCalls.push(1);
				if (opts.failRecap) throw new Error("recap call failed");
				return { text: "RECAP TEXT", toolCalls: [], usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 0 } };
			}
			return { text: "step", toolCalls: [] };
		},
	};
	return { model, recapCalls };
}

async function longHistory(loop: HarnessLoop, n: number) {
	for (let i = 0; i < n; i++) await loop.run(`task ${i}`);
}

/**
 * Recap is manual-only: requestCompact during a run makes the next model call
 * write a recap of everything older than the recent window.
 */
async function historyThenCompact(opts: { failRecap?: boolean } = {}) {
	const { model, recapCalls } = recapModel(opts);
	const log = new MemoryEventLog(() => 1);
	const holder: { loop?: HarnessLoop } = {};
	// The wrapper requests compaction on the Nth main-loop call, mid-run.
	const compactAt = KEEP_RECENT_MESSAGES + COMPACT_CHUNK + 2;
	let calls = 0;
	const wrapped: ModelPort = {
		complete: async (req: ModelRequest) => {
			if (req.tools.length) {
				calls++;
				if (calls === compactAt) holder.loop?.requestCompact();
			}
			return model.complete(req);
		},
	};
	const loop = new HarnessLoop({ runId: "r", log, model: wrapped, tools });
	holder.loop = loop;
	await longHistory(loop, compactAt + 2);
	return { loop, log, recapCalls };
}

describe("recap compaction (step 6, manual only)", () => {
	it("writes one recap on manual compact and the projection then uses it", async () => {
		const { loop, log, recapCalls } = await historyThenCompact();
		const recaps = (await log.read()).filter((e) => e.type === "context.recap");
		expect(recaps.length).toBeGreaterThanOrEqual(1);
		expect(recaps.length).toBe(recapCalls.length);
		const compactions = (await log.read()).filter((e) => e.type === "context.compaction");
		expect(compactions).toHaveLength(recaps.length);
		expect(compactions[0]).toMatchObject({ record: { scope: "interaction_history", modelGenerated: true, version: 1 } });
		const ctx = buildContext(loop.projection, tools.specs());
		expect(ctx.messages[0]).toMatchObject({ kind: "system", text: expect.stringContaining("RECAP TEXT") });
	});

	it("a failed recap writes no event and leaves the older messages digested", async () => {
		const { loop, log } = await historyThenCompact({ failRecap: true });
		expect((await log.read()).some((e) => e.type === "context.recap")).toBe(false);
		expect(loop.projection.recap).toBeUndefined();
	});

	it("the recap's tokens count against the session counters", async () => {
		const { loop } = await historyThenCompact();
		expect(loop.projection.counters.inputTokens).toBeGreaterThanOrEqual(10);
	});

	it("does not recap automatically as the history grows", async () => {
		const { model } = recapModel();
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "r", log, model, tools });
		await longHistory(loop, KEEP_RECENT_MESSAGES + COMPACT_CHUNK + 8);
		expect((await log.read()).some((e) => e.type === "context.recap")).toBe(false);
	});

	it("makeRecap returns undefined for an empty model answer", async () => {
		const model: ModelPort = { complete: async () => ({ text: "   ", toolCalls: [] }) };
		expect(await makeRecap(model, undefined, [])).toBeUndefined();
	});

	it("the recap replaces covered messages in the request and keeps the rest", () => {
		const filler = (i: number) => ({ kind: "assistant" as const, text: `a${i}`, toolCalls: [], seq: i + 1 });
		const state = { ...initialState(), messages: Array.from({ length: 30 }, (_, i) => filler(i)), recap: { covers: 16, text: "R" } };
		const ctx = buildContext(state, []);
		expect(ctx.messages[0]).toMatchObject({ kind: "system", text: expect.stringContaining("R") });
		expect(ctx.messages[1]).toMatchObject({ kind: "assistant", text: "a16" });
	});

	it("an interaction recap never drops covered user inputs — the active objective and constraints are always retained", () => {
		const messages = [
			{ kind: "user" as const, text: "build the feature", seq: 1 },
			...Array.from({ length: 28 }, (_, i) => ({ kind: "assistant" as const, text: `a${i}`, toolCalls: [], seq: i + 2 })),
		];
		const state = { ...initialState(), messages, recap: { covers: 16, text: "R", scope: "interaction_history" as const } };
		const ctx = buildContext(state, []);
		expect(ctx.messages[0]).toMatchObject({ kind: "system", text: expect.stringContaining("R") });
		// The verbatim user input is re-injected right after the recap, before the uncovered tail.
		expect(ctx.messages[1]).toMatchObject({ kind: "user", text: "build the feature" });
		expect(ctx.messages[2]).toMatchObject({ kind: "assistant", text: "a15" });
	});

	it("a task-closeout recap supersedes prior user inputs — cross-task context stays compact", () => {
		const messages = [
			{ kind: "user" as const, text: "finished task objective", seq: 1 },
			...Array.from({ length: 28 }, (_, i) => ({ kind: "assistant" as const, text: `a${i}`, toolCalls: [], seq: i + 2 })),
			{ kind: "user" as const, text: "new objective", seq: 31 },
		];
		const state = {
			...initialState(),
			messages,
			recap: { covers: 29, text: "R", scope: "task_closeout" as const },
			closeoutCovers: 29,
		};
		const ctx = buildContext(state, []);
		expect(ctx.messages[0]).toMatchObject({ kind: "system", text: expect.stringContaining("R") });
		// The finished task's objective stays compacted; the uncovered tail begins with the new objective.
		expect(ctx.messages.some((m) => m.kind === "user" && m.text === "finished task objective")).toBe(false);
		expect(ctx.messages[1]).toMatchObject({ kind: "user", text: "new objective" });
	});
});
