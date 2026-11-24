/**
 * Task ledger (vscode-free): what must be done, and the rules for changing it.
 * The model proposes changes through built-in tools; the harness decides.
 *
 * Rules enforced here:
 * - Tasks move pending → in_progress → done (blocked/pending as side paths).
 * - A task starts only once its dependencies are done.
 * - A task is done only when every step is done and its acceptance check passed.
 * - A step is done only when the tool calls it cites all finished ok.
 * - Completed tasks and steps are final; a done task can't be removed.
 * - A task another task depends on can't be removed.
 */

import {
	expectObject,
	expectOneOf,
	expectOptionalString,
	expectString,
	expectStringArray,
	parseAcceptance,
	parseStep,
	SchemaError,
	STEP_STATUSES,
	TASK_STATUSES,
	type Acceptance,
	type EventBody,
	type Step,
	type StepStatus,
	type Task,
	type TaskStatus,
	type ToolSpec,
} from "./contracts";

export interface Ledger {
	order: string[];
	tasks: Record<string, Task>;
	/** Task ids whose acceptance check has passed. */
	verified: string[];
}

export const emptyLedger = (): Ledger => ({ order: [], tasks: {}, verified: [] });

/** Ids of tasks owned by a run (task.runId === runId). */
export const tasksOfRun = (ledger: Ledger, runId: string): string[] => ledger.order.filter((id) => ledger.tasks[id]?.runId === runId);

/** Tasks still owed work: blocked is terminal — it records work that cannot run, it doesn't keep a run open. With runId, only that run's tasks count. */
export const openTasks = (ledger: Ledger, runId?: string): string[] =>
	ledger.order.filter((id) => {
		const t = ledger.tasks[id];
		return (runId === undefined || t?.runId === runId) && t?.status !== "done" && t?.status !== "blocked";
	});

/** Task ids marked blocked — surfaced at finish so the report shows what was skipped and why. */
export const blockedTasks = (ledger: Ledger): string[] => ledger.order.filter((id) => ledger.tasks[id]?.status === "blocked");

/** Step ids still open across all tasks, as `taskId/stepId`. Blocked steps are terminal like blocked tasks. With runId, only that run's steps count. */
export const openSteps = (ledger: Ledger, runId?: string): string[] =>
	ledger.order
		.filter((id) => runId === undefined || ledger.tasks[id]?.runId === runId)
		.flatMap((id) => (ledger.tasks[id]?.steps ?? []).filter((s) => s.status !== "done" && s.status !== "blocked").map((s) => `${id}/${s.id}`));

export type Check =
	| { ok: true }
	| { ok: false; code: "invalid"; message: string }
	| { ok: false; code: "needs_verification"; message: string };

/** Which tool-call ids have finished, and whether they succeeded. Supplied by the projection. */
export type ToolOutcomes = Readonly<Record<string, boolean>>;

const invalid = (message: string): Check => ({ ok: false, code: "invalid", message });

const TASK_NEXT: Record<TaskStatus, readonly TaskStatus[]> = {
	pending: ["in_progress", "blocked"],
	in_progress: ["blocked", "pending", "done"],
	blocked: ["in_progress", "pending"],
	done: [],
};

const STEP_NEXT: Record<StepStatus, readonly StepStatus[]> = {
	pending: ["in_progress", "blocked"],
	in_progress: ["done", "blocked", "pending"],
	blocked: ["in_progress", "pending"],
	done: [],
};

export function checkCreate(ledger: Ledger, task: Pick<Task, "id" | "dependsOn" | "status" | "steps">): Check {
	if (ledger.tasks[task.id]) return invalid(`task ${task.id} already exists`);
	if (task.status !== "pending") return invalid(`new task ${task.id} must start as pending`);
	const missing = task.dependsOn.filter((dep) => !ledger.tasks[dep]);
	if (missing.length) return invalid(`task ${task.id} depends on unknown task(s): ${missing.join(", ")}`);
	const ids = new Set(task.steps.map((s) => s.id));
	if (ids.size !== task.steps.length) return invalid(`task ${task.id} has duplicate step ids`);
	if (task.steps.some((s) => s.status !== "pending" || s.callIds.length)) return invalid(`new steps of ${task.id} must start pending with no evidence`);
	return { ok: true };
}

export function checkTransition(ledger: Ledger, id: string, to: TaskStatus): Check {
	const task = ledger.tasks[id];
	if (!task) return invalid(`unknown task ${id}`);
	if (task.status === to) return invalid(`task ${id} is already ${to}`);
	if (task.status === "done") return invalid(`task ${id} is done; completed tasks are final`);
	if (!TASK_NEXT[task.status].includes(to)) return invalid(`task ${id} cannot move from ${task.status} to ${to}`);
	if (to === "in_progress" || to === "done") {
		const pending = task.dependsOn.filter((dep) => ledger.tasks[dep]?.status !== "done");
		if (pending.length) return invalid(`task ${id} waits for ${pending.join(", ")} to be done`);
	}
	if (to === "done") {
		const open = task.steps.filter((s) => s.status !== "done").map((s) => s.id);
		if (open.length) return invalid(`task ${id} has open steps: ${open.join(", ")}`);
		if (!ledger.verified.includes(id)) {
			return { ok: false, code: "needs_verification", message: `task ${id} needs a passing acceptance check before it can be done` };
		}
	}
	return { ok: true };
}

export function checkStepAdd(ledger: Ledger, taskId: string, step: Step): Check {
	const task = ledger.tasks[taskId];
	if (!task) return invalid(`unknown task ${taskId}`);
	if (task.status === "done") return invalid(`task ${taskId} is done; its steps are final`);
	if (task.steps.some((s) => s.id === step.id)) return invalid(`step ${step.id} already exists in ${taskId}`);
	if (step.status !== "pending" || step.callIds.length) return invalid(`new step ${step.id} must start pending with no evidence`);
	return { ok: true };
}

export function checkStepUpdate(ledger: Ledger, taskId: string, stepId: string, to: StepStatus, callIds: readonly string[], outcomes: ToolOutcomes): Check {
	const task = ledger.tasks[taskId];
	if (!task) return invalid(`unknown task ${taskId}`);
	if (task.status === "done") return invalid(`task ${taskId} is done; its steps are final`);
	const step = task.steps.find((s) => s.id === stepId);
	if (!step) return invalid(`unknown step ${stepId} in ${taskId}`);
	if (step.status === to) return invalid(`step ${stepId} is already ${to}`);
	if (!STEP_NEXT[step.status].includes(to)) return invalid(`step ${stepId} cannot move from ${step.status} to ${to}`);
	if (to === "done") {
		// Once the task's acceptance has passed, remaining open steps are covered by it
		// and may close without their own callIds (the harness close-out path).
		if (callIds.length === 0 && !ledger.verified.includes(taskId)) return invalid(`step ${stepId} needs the tool-call ids that prove it`);
		const unknown = callIds.filter((c) => outcomes[c] === undefined);
		if (unknown.length) return invalid(`step ${stepId} cites unknown tool call(s): ${unknown.join(", ")}`);
		const failed = callIds.filter((c) => outcomes[c] !== true);
		if (failed.length) return invalid(`step ${stepId} cites tool call(s) that did not succeed: ${failed.join(", ")}`);
	}
	return { ok: true };
}

/** A run may adopt a task it doesn't own only if the task still has work left. */
export function checkAdopt(ledger: Ledger, id: string): Check {
	const task = ledger.tasks[id];
	if (!task) return invalid(`unknown task ${id}`);
	if (task.status === "done" || task.status === "blocked") return invalid(`task ${id} is ${task.status} — nothing to adopt`);
	return { ok: true };
}

export function checkRemove(ledger: Ledger, id: string): Check {
	const task = ledger.tasks[id];
	if (!task) return invalid(`unknown task ${id}`);
	if (task.status === "done") return invalid(`task ${id} is done; completed tasks are protected`);
	const dependents = ledger.order.filter((other) => ledger.tasks[other]?.dependsOn.includes(id));
	if (dependents.length) return invalid(`task ${id} is required by ${dependents.join(", ")}`);
	return { ok: true };
}

/** Pure reducer over ledger-affecting events. Throws if the event breaks a rule (the loop checks first). */
export function applyLedgerEvent(ledger: Ledger, body: EventBody & { runId?: string }, outcomes: ToolOutcomes = {}): Ledger {
	switch (body.type) {
		case "task.created": {
			const check = checkCreate(ledger, body.task);
			if (!check.ok) throw new LedgerError(check.message);
			const task = body.runId && body.task.runId !== body.runId ? { ...body.task, runId: body.runId } : body.task;
			return { ...ledger, order: [...ledger.order, task.id], tasks: { ...ledger.tasks, [task.id]: task } };
		}
		case "task.adopted": {
			const check = checkAdopt(ledger, body.id);
			if (!check.ok) throw new LedgerError(check.message);
			const task = ledger.tasks[body.id]!;
			return { ...ledger, tasks: { ...ledger.tasks, [body.id]: { ...task, adoptedFrom: task.runId ?? task.adoptedFrom, runId: body.runId ?? task.runId } } };
		}
		case "task.updated": {
			const check = checkTransition(ledger, body.id, body.to);
			if (!check.ok) throw new LedgerError(check.message);
			const prev = ledger.tasks[body.id]!;
			const task = { ...prev, status: body.to, ...(body.reason ? { evidence: [...prev.evidence, body.reason] } : {}) };
			return { ...ledger, tasks: { ...ledger.tasks, [body.id]: task } };
		}
		case "task.removed": {
			const check = checkRemove(ledger, body.id);
			if (!check.ok) throw new LedgerError(check.message);
			const { [body.id]: _removed, ...tasks } = ledger.tasks;
			return { ...ledger, order: ledger.order.filter((id) => id !== body.id), tasks };
		}
		case "step.added": {
			const check = checkStepAdd(ledger, body.taskId, body.step);
			if (!check.ok) throw new LedgerError(check.message);
			const task = ledger.tasks[body.taskId]!;
			return { ...ledger, tasks: { ...ledger.tasks, [body.taskId]: { ...task, steps: [...task.steps, body.step] } } };
		}
		case "step.updated": {
			const check = checkStepUpdate(ledger, body.taskId, body.stepId, body.to, body.callIds, outcomes);
			if (!check.ok) throw new LedgerError(check.message);
			const task = ledger.tasks[body.taskId]!;
			const steps = task.steps.map((s) => (s.id === body.stepId ? { ...s, status: body.to, callIds: body.to === "done" ? [...body.callIds] : s.callIds } : s));
			return { ...ledger, tasks: { ...ledger.tasks, [body.taskId]: { ...task, steps } } };
		}
		case "verifier.result": {
			const task = ledger.tasks[body.taskId];
			if (!task) throw new LedgerError(`verifier result for unknown task ${body.taskId}`);
			const tasks = { ...ledger.tasks, [body.taskId]: { ...task, evidence: [...task.evidence, body.detail] } };
			const verified = body.ok && !ledger.verified.includes(body.taskId) ? [...ledger.verified, body.taskId] : ledger.verified;
			return { ...ledger, tasks, verified };
		}
		default:
			return ledger;
	}
}

export class LedgerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LedgerError";
	}
}

export const TASK_TOOL_NAMES = {
	create: "task_create",
	update: "task_update",
	remove: "task_remove",
	stepAdd: "task_step_add",
	stepUpdate: "task_step_update",
} as const;
export const TASK_TOOL_SET: ReadonlySet<string> = new Set(Object.values(TASK_TOOL_NAMES));

const ACCEPTANCE_SCHEMA = {
	type: "object",
	description: "How to tell the task is complete. Use kind command with a shell command that exits 0 when done.",
	properties: {
		kind: { type: "string", enum: ["command"] },
		command: { type: "string" },
	},
	required: ["kind", "command"],
};

export const TASK_TOOLS: readonly ToolSpec[] = [
	{
		name: TASK_TOOL_NAMES.create,
		description: "Add a task with ordered steps. Each step is something you will do and then prove with a tool-call id.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				title: { type: "string" },
				acceptance: ACCEPTANCE_SCHEMA,
				dependsOn: { type: "array", items: { type: "string" } },
				steps: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"] } },
			},
			required: ["id", "title", "acceptance", "steps"],
		},
	},
	{
		name: TASK_TOOL_NAMES.stepAdd,
		description: "Add a step to an open task.",
		inputSchema: {
			type: "object",
			properties: { taskId: { type: "string" }, id: { type: "string" }, text: { type: "string" } },
			required: ["taskId", "id", "text"],
		},
	},
	{
		name: TASK_TOOL_NAMES.stepUpdate,
		description: "Move a step to a new status. Mark it done only with callIds of the successful tool calls that prove it.",
		inputSchema: {
			type: "object",
			properties: {
				taskId: { type: "string" },
				stepId: { type: "string" },
				status: { type: "string", enum: [...STEP_STATUSES] },
				callIds: { type: "array", items: { type: "string" } },
			},
			required: ["taskId", "stepId", "status"],
		},
	},
	{
		name: TASK_TOOL_NAMES.update,
		description: "Move a task to a new status. Use done only after every step is done; the harness then runs the acceptance check.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" }, status: { type: "string", enum: [...TASK_STATUSES] }, reason: { type: "string" } },
			required: ["id", "status"],
		},
	},
	{
		name: TASK_TOOL_NAMES.remove,
		description: "Remove a task that is no longer needed. Completed tasks cannot be removed.",
		inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
	},
];

export interface TaskCreateInput {
	id: string;
	title: string;
	acceptance: Acceptance;
	dependsOn: string[];
	steps: Step[];
}

export function parseTaskCreateInput(value: unknown): TaskCreateInput {
	const o = expectObject(value, "input");
	if (!Array.isArray(o.steps)) throw new SchemaError("input.steps: expected an array");
	return {
		id: expectString(o.id, "input.id"),
		title: expectString(o.title, "input.title"),
		acceptance: parseAcceptance(o.acceptance, "input.acceptance"),
		dependsOn: o.dependsOn === undefined ? [] : expectStringArray(o.dependsOn, "input.dependsOn"),
		steps: o.steps.map((s, i) => {
			const step = expectObject(s, `input.steps[${i}]`);
			return parseStep(
				{ id: step.id, text: step.text, status: "pending", callIds: [], ...(step.signal === undefined ? {} : { signal: step.signal }) },
				`input.steps[${i}]`,
			);
		}),
	};
}

export function parseTaskStepAddInput(value: unknown): { taskId: string; step: Step } {
	const o = expectObject(value, "input");
	return {
		taskId: expectString(o.taskId, "input.taskId"),
		step: parseStep({ id: o.id, text: o.text, status: "pending", callIds: [] }, "input"),
	};
}

export function parseTaskStepUpdateInput(value: unknown): { taskId: string; stepId: string; status: StepStatus; callIds: string[] } {
	const o = expectObject(value, "input");
	return {
		taskId: expectString(o.taskId, "input.taskId"),
		stepId: expectString(o.stepId, "input.stepId"),
		status: expectOneOf(o.status, STEP_STATUSES, "input.status"),
		callIds: o.callIds === undefined ? [] : expectStringArray(o.callIds, "input.callIds"),
	};
}

export interface TaskUpdateInput {
	id: string;
	status: TaskStatus;
	reason?: string;
}

export function parseTaskUpdateInput(value: unknown): TaskUpdateInput {
	const o = expectObject(value, "input");
	const reason = expectOptionalString(o.reason, "input.reason");
	return {
		id: expectString(o.id, "input.id"),
		status: expectOneOf(o.status, TASK_STATUSES, "input.status"),
		...(reason === undefined ? {} : { reason }),
	};
}

export function parseTaskRemoveInput(value: unknown): { id: string } {
	return { id: expectString(expectObject(value, "input").id, "input.id") };
}
