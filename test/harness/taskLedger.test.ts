import { describe, expect, it } from "vitest";
import { applyLedgerEvent, blockedTasks, checkRemove, checkTransition, emptyLedger, LedgerError, openTasks, type Ledger } from "../../src/harness/taskLedger";
import type { EventBody, Task } from "../../src/harness/contracts";

const task = (id: string, dependsOn: string[] = []): Task => ({ id, title: id, acceptance: { kind: "command", command: "true" }, dependsOn, status: "pending", steps: [], evidence: [] });
const apply = (ledger: Ledger, body: EventBody & { runId?: string }) => applyLedgerEvent(ledger, body);
const withTasks = (...tasks: Task[]): Ledger => tasks.reduce((l, t) => apply(l, { type: "task.created", task: t }), emptyLedger());
const verified = (ledger: Ledger, id: string): Ledger => apply(ledger, { type: "verifier.result", taskId: id, ok: true, detail: "passed" });

describe("task ledger rules", () => {
	it("refuses a dependency on a task that does not exist", () => {
		const ledger = emptyLedger();
		expect(() => apply(ledger, { type: "task.created", task: task("b", ["missing"]) })).toThrow(LedgerError);
	});

	it("blocks a task from starting until its dependencies are done", () => {
		const ledger = withTasks(task("a"), task("b", ["a"]));
		const check = checkTransition(ledger, "b", "in_progress");
		expect(check).toMatchObject({ ok: false, code: "invalid" });
		expect(check.ok === false && check.message).toMatch(/waits for a/);
	});

	it("requires a passing acceptance check before a task can be done", () => {
		const ledger = apply(withTasks(task("a")), { type: "task.updated", id: "a", to: "in_progress" });
		expect(checkTransition(ledger, "a", "done")).toMatchObject({ ok: false, code: "needs_verification" });
		expect(checkTransition(verified(ledger, "a"), "a", "done")).toEqual({ ok: true });
	});

	it("keeps completed tasks final", () => {
		let ledger = apply(withTasks(task("a")), { type: "task.updated", id: "a", to: "in_progress" });
		ledger = apply(verified(ledger, "a"), { type: "task.updated", id: "a", to: "done" });
		const reopen = checkTransition(ledger, "a", "in_progress");
		expect(reopen).toMatchObject({ ok: false, code: "invalid" });
		expect(reopen.ok === false && reopen.message).toMatch(/final/);
	});

	it("protects a completed task from removal", () => {
		let ledger = apply(withTasks(task("a")), { type: "task.updated", id: "a", to: "in_progress" });
		ledger = apply(verified(ledger, "a"), { type: "task.updated", id: "a", to: "done" });
		expect(() => apply(ledger, { type: "task.removed", id: "a" })).toThrow(/protected/);
		expect(ledger.order).toEqual(["a"]);
	});

	it("refuses to remove a task that another task depends on", () => {
		const ledger = withTasks(task("a"), task("b", ["a"]));
		expect(checkRemove(ledger, "a")).toMatchObject({ ok: false, code: "invalid" });
	});

	it("reports open tasks, treating blocked as terminal", () => {
		let ledger = withTasks(task("a"), task("b"));
		ledger = apply(ledger, { type: "task.updated", id: "b", to: "in_progress" });
		ledger = apply(ledger, { type: "task.updated", id: "b", to: "blocked" });
		expect(openTasks(ledger)).toEqual(["a"]);
		expect(blockedTasks(ledger)).toEqual(["b"]);
	});

	it("refuses a task that does not start as pending", () => {
		expect(() => apply(emptyLedger(), { type: "task.created", task: { ...task("a"), status: "done" } })).toThrow(/pending/);
	});

	it("stamps tasks with their run's id and scopes open tasks to a run", () => {
		let ledger = apply(emptyLedger(), { type: "task.created", task: task("a"), runId: "run-1" });
		ledger = apply(ledger, { type: "task.created", task: task("b"), runId: "run-2" });
		expect(ledger.tasks["a"]?.runId).toBe("run-1");
		expect(ledger.tasks["b"]?.runId).toBe("run-2");
		expect(openTasks(ledger, "run-1")).toEqual(["a"]);
		expect(openTasks(ledger, "run-2")).toEqual(["b"]);
		expect(openTasks(ledger)).toEqual(["a", "b"]);
	});

	it("adopts a prior run's task into the current run, keeping its progress", () => {
		let ledger = apply(emptyLedger(), { type: "task.created", task: task("a"), runId: "run-1" });
		ledger = apply(ledger, { type: "task.updated", id: "a", to: "in_progress" });
		ledger = apply(ledger, { type: "task.adopted", id: "a", runId: "run-2" });
		expect(ledger.tasks["a"]?.runId).toBe("run-2");
		expect(ledger.tasks["a"]?.adoptedFrom).toBe("run-1");
		expect(ledger.tasks["a"]?.status).toBe("in_progress");
		expect(openTasks(ledger, "run-1")).toEqual([]);
		expect(openTasks(ledger, "run-2")).toEqual(["a"]);
		// A finished or blocked task can't be adopted.
		let done = apply(emptyLedger(), { type: "task.created", task: task("a"), runId: "run-1" });
		done = apply(done, { type: "task.updated", id: "a", to: "in_progress" });
		done = apply(verified(done, "a"), { type: "task.updated", id: "a", to: "done" });
		expect(() => apply(done, { type: "task.adopted", id: "a", runId: "run-2" })).toThrow(LedgerError);
	});
});
