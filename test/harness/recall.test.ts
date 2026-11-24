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
});
