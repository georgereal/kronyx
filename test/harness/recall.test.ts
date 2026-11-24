import { describe, expect, it } from "vitest";
import type { ToolPort } from "../../src/harness/contracts";
import { MemoryEventLog } from "../../src/harness/eventLog";
import { RECALL_TOOL, withRecall } from "../../src/harness/recall";

const base: ToolPort = { specs: () => [], execute: async () => ({ ok: true, output: "base" }) };

async function sessionLog() {
	const log = new MemoryEventLog(() => 1);
	await log.append({ type: "user.input", text: "earlier task about the parser", runId: "run-1" });
	await log.append({ type: "tool.finished", callId: "big", name: "read_file", ok: true, output: "line one\nFULL OUTPUT TEXT", runId: "run-1" });
	await log.append({ type: "user.input", text: "unrelated later task", runId: "run-2" });
	return log;
}

describe("recall_context on the harness (step 4)", () => {
	it("offers the recall tool", () => {
		expect(withRecall(base, new MemoryEventLog()).specs().map((s) => s.name)).toContain(RECALL_TOOL);
	});

	it("returns a full earlier tool result by toolCallId", async () => {
		const port = withRecall(base, await sessionLog());
		expect(await port.execute(RECALL_TOOL, { toolCallId: "big" })).toEqual({ ok: true, output: "line one\nFULL OUTPUT TEXT" });
	});

	it("finds earlier tasks across runs by keyword, with seq", async () => {
		const port = withRecall(base, await sessionLog());
		const result = await port.execute(RECALL_TOOL, { query: "parser" });
		expect(result.ok).toBe(true);
		expect(result.output).toMatch(/seq 1 \(user\.input\)/);
		expect(result.output).not.toMatch(/unrelated/);
	});

	it("requires every query term to appear", async () => {
		const port = withRecall(base, await sessionLog());
		expect((await port.execute(RECALL_TOOL, { query: "parser unrelated" })).output).toBe("No matches.");
	});

	it("reports an unknown toolCallId and a missing argument plainly", async () => {
		const port = withRecall(base, await sessionLog());
		expect(await port.execute(RECALL_TOOL, { toolCallId: "nope" })).toMatchObject({ ok: false });
		expect(await port.execute(RECALL_TOOL, {})).toMatchObject({ ok: false });
	});

	it("passes other tool calls through to the base port", async () => {
		const port = withRecall(base, await sessionLog());
		expect(await port.execute("anything", {})).toEqual({ ok: true, output: "base" });
	});

	it("ranks hits semantically when a scorer is wired, and falls back to keyword search", async () => {
		const scorer = async (_q: string, chunks: { idx: number; role: string; text: string }[]) =>
			chunks.filter((c) => c.text.includes("FULL OUTPUT")).map((c) => ({ idx: c.idx, score: 0.9 }));
		const port = withRecall(base, await sessionLog(), scorer);
		const result = await port.execute(RECALL_TOOL, { query: "semantic query with no literal match" });
		expect(result.ok).toBe(true);
		expect(result.output).toMatch(/score 0\.90/);
		expect(result.output).toContain("FULL OUTPUT TEXT");
		// Scorer returning nothing → keyword path still applies.
		const empty = withRecall(base, await sessionLog(), async () => []);
		expect((await empty.execute(RECALL_TOOL, { query: "parser" })).output).toMatch(/seq 1 \(user\.input\)/);
		// Scorer throwing → same fallback.
		const broken = withRecall(base, await sessionLog(), async () => {
			throw new Error("no embeddings");
		});
		expect((await broken.execute(RECALL_TOOL, { query: "parser" })).output).toMatch(/seq 1 \(user\.input\)/);
	});

	it("scope 'runs' queries the run-memory store and honors runId/task filters", async () => {
		const seen: { runId?: string; task?: string }[] = [];
		const searchRuns = async (_q: string, filter: { runId?: string; task?: string }) => {
			seen.push(filter);
			return [{ label: "Session-8 · abc12345", text: "Run abc12345 of session \"Session-8\" — final report: tool surface audit", score: 0.87 }];
		};
		const port = withRecall(base, await sessionLog(), undefined, searchRuns);
		const result = await port.execute(RECALL_TOOL, { query: "tool surface audit", scope: "runs" });
		expect(result.ok).toBe(true);
		expect(result.output).toMatch(/Session-8 · abc12345 \(score 0\.87\)/);
		expect(result.output).toContain("tool surface audit");
		// runId/task args imply runs scope without an explicit scope.
		await port.execute(RECALL_TOOL, { query: "x", runId: "abc123", task: "t2" });
		expect(seen.at(-1)).toEqual({ runId: "abc123", task: "t2" });
		// Missing dep → clear refusal; empty hits → plain message.
		const none = withRecall(base, await sessionLog());
		expect((await none.execute(RECALL_TOOL, { query: "x", scope: "runs" })).output).toMatch(/not indexed/);
		const empty = withRecall(base, await sessionLog(), undefined, async () => []);
		expect((await empty.execute(RECALL_TOOL, { query: "x", scope: "runs" })).output).toBe("No run-memory matches.");
	});
});
