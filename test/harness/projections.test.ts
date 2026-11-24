import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/harness/contracts";
import { MemoryEventLog } from "../../src/harness/eventLog";
import { initialState, project, reduce } from "../../src/harness/projections";
import { LedgerError } from "../../src/harness/taskLedger";

const run = "r";
const base = { at: 1, runId: run };
const created = (id: string, dependsOn: string[] = []) => ({
	type: "task.created" as const,
	task: { id, title: id, acceptance: { kind: "command" as const, command: "true" }, dependsOn, status: "pending" as const, steps: [], evidence: [] },
});

async function build(bodies: Array<Record<string, unknown>>): Promise<SessionEvent[]> {
	const log = new MemoryEventLog(() => 1);
	for (const b of bodies) await log.append({ ...(b as object), runId: run } as never);
	return log.read();
}

describe("projections", () => {
	it("replaying the same log yields identical state", async () => {
		const events = await build([
			{ type: "user.input", text: "go" },
			created("a"),
			{ type: "model.response", turn: 1, text: "", toolCalls: [], usage: { inputTokens: 5, outputTokens: 1, cachedTokens: 2 } },
			{ type: "stop.refused", openTaskIds: ["a"] },
		]);
		expect(project(events)).toEqual(project(events.map((e) => ({ ...e }))));
	});

	it("counts turns and usage from model responses", async () => {
		const events = await build([{ type: "model.response", turn: 1, text: "", toolCalls: [], usage: { inputTokens: 7, outputTokens: 3, cachedTokens: 4 } }]);
		const state = project(events);
		expect(state.counters).toMatchObject({ turns: 1, inputTokens: 7, outputTokens: 3, cachedTokens: 4 });
	});

	it("rejects an event that does not follow the last sequence number", () => {
		const state = initialState();
		expect(() => reduce(state, { ...base, seq: 2, type: "user.input", text: "x" })).toThrow(/does not follow/);
	});

	it("surfaces a refused finish to the model as a system message", () => {
		const state = reduce(initialState(), { ...base, seq: 1, type: "stop.refused", openTaskIds: ["a", "b"] });
		expect(state.messages.at(-1)).toMatchObject({ kind: "system" });
		expect(state.counters.refusals).toBe(1);
	});

	it("throws when a log contains a task rule violation", () => {
		const state = reduce(initialState(), { ...base, seq: 1, ...created("a") } as SessionEvent);
		expect(() => reduce(state, { ...base, seq: 2, type: "task.updated", id: "a", to: "done" })).toThrow(LedgerError);
	});
});
