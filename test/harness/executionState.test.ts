import { describe, expect, it } from "vitest";
import { MemoryEventLog } from "../../src/harness/core/eventLog";
import { projectHarnessExecutionState } from "../../src/context/state/projectHarness";
import { snapshotHarnessExecutionState } from "../../src/context/adapters/harnessStateSnapshot";

async function eventsFor() {
	const log = new MemoryEventLog(() => 1_700_000_000_000);
	const bodies = [
		{ type: "user.input", text: "implement x" },
		{ type: "task.created", task: { id: "t1", title: "Implement x", acceptance: { kind: "none" }, dependsOn: [], status: "pending", steps: [{ id: "s1", text: "write", status: "pending", callIds: [] }], evidence: [] } },
		{ type: "task.updated", id: "t1", to: "in_progress" },
		{ type: "tool.requested", callId: "c1", name: "write_file", input: { path: "src/x.ts" } },
		{ type: "tool.finished", callId: "c1", name: "write_file", ok: true, output: "Created src/x.ts" },
		{ type: "step.updated", taskId: "t1", stepId: "s1", to: "done", callIds: ["c1"] },
		{ type: "task.updated", id: "t1", to: "done" },
		{ type: "run.status", status: "completed" },
	];
	for (const body of bodies) await log.append({ ...(body as object), runId: "r1" } as never);
	return log.read();
}

describe("canonical execution state projection", () => {
	it("projects objective, plan, file changes, tool results, and terminal status", async () => {
		const events = await eventsFor();
		const state = projectHarnessExecutionState(events, "session-1", "r1");
		expect(state.objective).toBe("implement x");
		expect(state.status).toBe("completed");
		expect(state.plan.completed).toEqual(["t1"]);
		expect(state.plan.tasks[0]?.steps[0]?.status).toBe("done");
		expect(state.changes.filesModified.map((f) => f.path)).toEqual(["src/x.ts"]);
		expect(state.componentVersions.toolResultVersion).toBe(1);
		expect(state.eventCursor).toBe(events.at(-1)?.seq);
	});

	it("snapshot hashes are stable for the same ledger and change when the ledger changes", async () => {
		const events = await eventsFor();
		const a = snapshotHarnessExecutionState(events, "session-1", "r1");
		const b = snapshotHarnessExecutionState(events.map((e) => ({ ...e })), "session-1", "r1");
		expect(a.stateHash).toBe(b.stateHash);
		const changed = [...events.slice(0, -1), { ...events.at(-1)!, type: "run.status" as const, status: "failed" as const }];
		const c = snapshotHarnessExecutionState(changed, "session-1", "r1");
		expect(c.stateHash).not.toBe(a.stateHash);
	});
});
