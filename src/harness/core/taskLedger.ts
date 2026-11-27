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

import { expandBraces, ownsMatch } from "../../agent/decompose";
import { READ_FILES } from "../tools/batchReads";
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

/** True when a finished call satisfies a step's predicted signal — the tool
 * name plus an optional repo-relative path glob. List/explore signals match on
 * name — their inputs (a directory or area) can't prove what the result
 * contained, so a fabricated signal path would just stall the step.
 */
export const signalHits = (signal: { tool: string; path?: string }, call: { name: string; input?: unknown }): boolean => {
	// A read_files batch satisfies read_file signals for any file it covered.
	const names = call.name === READ_FILES ? [READ_FILES, "read_file"] : [call.name];
	if (!names.includes(signal.tool)) return false;
	if (signal.tool === "explore_codebase" || signal.tool === "list_files") return true;
	if (!signal.path) return true;
	const input = (call.input ?? {}) as { path?: unknown; files?: unknown; pattern?: unknown; file_glob?: unknown };
	const paths: string[] = [];
	if (typeof input.path === "string") paths.push(input.path);
	if (call.name === READ_FILES && Array.isArray(input.files)) {
		for (const f of input.files as { path?: unknown }[]) if (typeof f?.path === "string") paths.push(f.path);
	}
	if (typeof input.file_glob === "string") paths.push(input.file_glob);
	if (paths.some((p) => ownsMatch([signal.path!], p))) return true;
	// Filename-style signal globs (**/{a,b}) also hit when the file's literal
	// basename appears in the call's search pattern or file glob.
	const literals = expandBraces(signal.path).map((g) => g.split("/").pop() ?? "").filter((b) => b && !/[*?{}]/.test(b));
	// `pattern` is regex — the model often escapes dots (Cargo\.toml), so compare unescaped.
	const pattern = typeof input.pattern === "string" ? input.pattern.replace(/\\/g, "") : "";
	return literals.some((b) => pattern.includes(b) || (typeof input.file_glob === "string" && input.file_glob.includes(b)));
};

/** Ids of tasks owned by a run (task.runId === runId). */
export const tasksOfRun = (ledger: Ledger, runId: string): string[] => ledger.order.filter((id) => ledger.tasks[id]?.runId === runId);

/** Tasks still owed work: blocked is terminal — it records work that cannot run, it doesn't keep a run open. With runId, only that run's tasks count. */
export const openTasks = (ledger: Ledger, runId?: string): string[] =>
	ledger.order.filter((id) => {
		const t = ledger.tasks[id];
		return (runId === undefined || t?.runId === runId) && t?.status !== "done" && t?.status !== "blocked" && t?.status !== "stale";
	});

/** Task ids marked blocked — surfaced at finish so the report shows what was skipped and why. */
export const blockedTasks = (ledger: Ledger): string[] => ledger.order.filter((id) => ledger.tasks[id]?.status === "blocked");

/** Step ids still open across all tasks, as `taskId/stepId`. Blocked steps are terminal like blocked tasks. With runId, only that run's steps count. */
export const openSteps = (ledger: Ledger, runId?: string): string[] =>
	ledger.order
		.filter((id) => (runId === undefined || ledger.tasks[id]?.runId === runId) && ledger.tasks[id]?.status !== "stale" && ledger.tasks[id]?.status !== "done")
		.flatMap((id) => (ledger.tasks[id]?.steps ?? []).filter((s) => !stepSettled(s) && s.status !== "blocked").map((s) => `${id}/${s.id}`));

/** Plan ids per run are minted monotonically — p1, p2, … — so the newest plan
 * is always the max. Old events without planId belong to "no plan". */
export const nextPlanId = (ledger: Ledger): string => {
	let max = 0;
	for (const id of ledger.order) {
		const m = /^p(\d+)$/.exec(ledger.tasks[id]?.planId ?? "");
		if (m) max = Math.max(max, Number(m[1]));
	}
	return `p${max + 1}`;
};

/** The run's active plan: the newest planId among its tasks. Superseded plans
 * sit below it, marked stale; the invariant is one active plan per run. */
export const activePlanId = (ledger: Ledger, runId: string): string | undefined => {
	let best: string | undefined;
	let max = 0;
	for (const id of tasksOfRun(ledger, runId)) {
		const m = /^p(\d+)$/.exec(ledger.tasks[id]?.planId ?? "");
		if (m && Number(m[1]) > max) {
			max = Number(m[1]);
			best = `p${max}`;
		}
	}
	return best;
};

export type Check =
	| { ok: true }
	| { ok: false; code: "invalid"; message: string }
	| { ok: false; code: "needs_verification"; message: string };

/** Which tool-call ids have finished, and whether they succeeded. Supplied by the projection. */
export type ToolOutcomes = Readonly<Record<string, boolean>>;

const invalid = (message: string): Check => ({ ok: false, code: "invalid", message });

/** Board snapshot for "unknown" errors — a model that guessed an id can self-correct from the list. */
const boardDigest = (ledger: Ledger): string =>
	ledger.order.map((id) => {
		const t = ledger.tasks[id]!;
		const title = t.title.length > 48 ? `${t.title.slice(0, 48)}…` : t.title;
		const steps = t.steps.map((s) => `${s.id}:${s.status}`).join(",");
		return `${id} "${title}" [${t.status}] steps(${steps})`;
	}).join("; ") || "empty board";
const unknownTask = (ledger: Ledger, id: string): Check => invalid(`unknown task "${id}" — the board holds: ${boardDigest(ledger)}`);

const TASK_NEXT: Record<TaskStatus, readonly TaskStatus[]> = {
	pending: ["in_progress", "blocked", "stale"],
	in_progress: ["blocked", "pending", "done", "stale"],
	blocked: ["in_progress", "pending"],
	done: [],
	// A stale task's plan was replaced — the record stays as history; terminal like done.
	stale: [],
};

const STEP_NEXT: Record<StepStatus, readonly StepStatus[]> = {
	pending: ["in_progress", "blocked", "failed"],
	in_progress: ["done", "blocked", "pending", "failed"],
	blocked: ["in_progress", "pending", "failed"],
	// A done step can be reopened only as failed: the record stays, and a replacement step carries the work.
	done: ["failed"],
	failed: [],
};

/** A step that no longer needs work: done, or failed and replaced. */
export const stepSettled = (s: { status: StepStatus }): boolean => s.status === "done" || s.status === "failed";

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
	if (!task) return unknownTask(ledger, id);
	if (task.status === to) return invalid(`task ${id} is already ${to}`);
	if (task.status === "done" || task.status === "stale") return invalid(`task ${id} is ${task.status}; completed or superseded tasks are final`);
	if (!TASK_NEXT[task.status].includes(to)) return invalid(`task ${id} cannot move from ${task.status} to ${to}`);
	if (to === "in_progress" || to === "done") {
		const pending = task.dependsOn.filter((dep) => ledger.tasks[dep]?.status !== "done");
		if (pending.length) return invalid(`task ${id} waits for ${pending.join(", ")} to be done`);
	}
	if (to === "done") {
		const open = task.steps.filter((s) => !stepSettled(s)).map((s) => s.id);
		if (open.length) return invalid(`task ${id} has open steps: ${open.join(", ")}`);
		if (!ledger.verified.includes(id)) {
			return { ok: false, code: "needs_verification", message: `task ${id} needs a passing acceptance check before it can be done` };
		}
	}
	return { ok: true };
}

export function checkStepAdd(ledger: Ledger, taskId: string, step: Step): Check {
	const task = ledger.tasks[taskId];
	if (!task) return unknownTask(ledger, taskId);
	if (task.status === "done" || task.status === "stale") return invalid(`task ${taskId} is ${task.status}; its steps are final`);
	if (task.steps.some((s) => s.id === step.id)) return invalid(`step ${step.id} already exists in ${taskId}`);
	if (step.status !== "pending" || step.callIds.length) return invalid(`new step ${step.id} must start pending with no evidence`);
	return { ok: true };
}

export function checkStepUpdate(ledger: Ledger, taskId: string, stepId: string, to: StepStatus, callIds: readonly string[], outcomes: ToolOutcomes, reason?: string): Check {
	const task = ledger.tasks[taskId];
	if (!task) return unknownTask(ledger, taskId);
	if (task.status === "done" || task.status === "stale") return invalid(`task ${taskId} is ${task.status}; its steps are final`);
	const step = task.steps.find((s) => s.id === stepId);
	if (!step) return invalid(`unknown step "${stepId}" in ${taskId} — its steps are: ${task.steps.map((s) => `${s.id}:${s.status}`).join(", ") || "none"}`);
	if (step.status === to) return invalid(`step ${stepId} is already ${to}`);
	if (!STEP_NEXT[step.status].includes(to)) return invalid(`step ${stepId} cannot move from ${step.status} to ${to}`);
	if (to === "failed" && !reason?.trim()) return invalid(`step ${stepId} needs a reason before it can be failed`);
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

/** Models address tasks by title as often as by id — resolve a reference that
 * is a real id, an exact title, or a truncated title ("… and" endings the UI
 * shows) to the task id. Ambiguous or unknown refs pass through so the checks
 * report them with the board digest. */
export const resolveTaskId = (ledger: Ledger, ref: string): string => {
	if (ledger.tasks[ref]) return ref;
	const norm = ref.replace(/[…\s.]+$/u, "").trim();
	const hits = ledger.order.filter((id) => {
		const title = ledger.tasks[id]!.title;
		return title === ref || (norm.length > 3 && title.startsWith(norm));
	});
	return hits.length === 1 ? hits[0]! : ref;
};

/** A run may adopt a task it doesn't own only if the task still has work left. */
export function checkAdopt(ledger: Ledger, id: string): Check {
	const task = ledger.tasks[id];
	if (!task) return unknownTask(ledger, id);
	if (task.status === "done" || task.status === "blocked" || task.status === "stale") return invalid(`task ${id} is ${task.status} — nothing to adopt`);
	return { ok: true };
}

export function checkRemove(ledger: Ledger, id: string): Check {
	const task = ledger.tasks[id];
	if (!task) return unknownTask(ledger, id);
	if (task.status === "done" || task.status === "stale") return invalid(`task ${id} is ${task.status}; completed and superseded tasks are protected`);
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
			const check = checkStepUpdate(ledger, body.taskId, body.stepId, body.to, body.callIds, outcomes, body.reason);
			if (!check.ok) throw new LedgerError(check.message);
			const task = ledger.tasks[body.taskId]!;
			const steps = task.steps.map((s) => (s.id === body.stepId ? { ...s, status: body.to, callIds: body.to === "done" ? [...body.callIds] : s.callIds, ...(body.reason ? { reason: body.reason } : {}) } : s));
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
	replace: "task_replace",
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

const SIGNAL_SCHEMA = {
	type: "object",
	description: "The tool call predicted to prove this step: tool name, optional repo-relative path glob. The harness closes the step when a matching call finishes ok.",
	properties: { tool: { type: "string" }, path: { type: "string" } },
	required: ["tool"],
};

const TASK_ITEM_SCHEMA = {
	type: "object",
	properties: {
		id: { type: "string" },
		title: { type: "string" },
		acceptance: ACCEPTANCE_SCHEMA,
		dependsOn: { type: "array", items: { type: "string" } },
		steps: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, signal: SIGNAL_SCHEMA }, required: ["id", "text"] } },
	},
	required: ["id", "title", "acceptance", "steps"],
} as const;

export const TASK_TOOLS: readonly ToolSpec[] = [
	{
		name: TASK_TOOL_NAMES.create,
		description: "Add a task with ordered steps. Each step is something you will do and then prove with a tool-call id.",
		inputSchema: { type: "object", properties: TASK_ITEM_SCHEMA.properties, required: [...TASK_ITEM_SCHEMA.required] },
	},
	{
		name: TASK_TOOL_NAMES.replace,
		description: "Replace the whole plan in one call: this run's unfinished tasks are marked stale (kept on the board as history) and the given tasks become the new active plan. Use when the board no longer matches the real work — preferred over removing and recreating tasks one by one. Completed tasks are untouched.",
		inputSchema: {
			type: "object",
			properties: { tasks: { type: "array", items: TASK_ITEM_SCHEMA } },
			required: ["tasks"],
		},
	},
	{
		name: TASK_TOOL_NAMES.stepAdd,
		description: "Add a step to an open task. When the plan changes mid-run, keep the board honest — add the new steps and retire stale ones instead of working around them.",
		inputSchema: {
			type: "object",
			properties: { taskId: { type: "string", description: "The board id of the parent task (t1, t2…) — from task.created events, not the title" }, id: { type: "string" }, text: { type: "string" }, signal: SIGNAL_SCHEMA },
			required: ["taskId", "id", "text"],
		},
	},
	{
		name: TASK_TOOL_NAMES.stepUpdate,
		description: "Move a step to a new status. Mark a step done once successful tool calls prove its work — the harness attaches those calls itself; never supply or hunt for call ids. If a step you marked done turns out wrong — or the plan changed and the step is obsolete — set it failed with a reason and a replacement step; the record stays and the replacement carries the work.",
		inputSchema: {
			type: "object",
			properties: {
				taskId: { type: "string", description: "The board id (t1, t2…) from task.created events — not the title" },
				stepId: { type: "string", description: "The step id inside that task (s1, s2…)" },
				status: { type: "string", enum: [...STEP_STATUSES] },
				reason: { type: "string", description: "Required when status is failed: what was wrong with the step." },
				replacement: {
					type: "object",
					description: "With status failed: a new step that carries the work instead.",
					properties: { id: { type: "string" }, text: { type: "string" } },
					required: ["id", "text"],
				},
			},
			required: ["taskId", "stepId", "status"],
		},
	},
	{
		name: TASK_TOOL_NAMES.update,
		description: "Move a task to a new status. Use done only after every step is done; the harness then runs the acceptance check.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string", description: "The board id (t1, t2…) — not the title" }, status: { type: "string", enum: [...TASK_STATUSES] }, reason: { type: "string" } },
			required: ["id", "status"],
		},
	},
	{
		name: TASK_TOOL_NAMES.remove,
		description: "Remove a task that is no longer needed — including one that is stale because the plan changed mid-run. Rewrite the board to match the new plan (remove stale tasks, task_create the new phases); open steps that no longer match real work count as drift. Completed tasks cannot be removed.",
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
	const steps = expectArray(o.steps, "input.steps");
	return {
		id: expectString(o.id, "input.id"),
		title: expectString(o.title, "input.title"),
		acceptance: parseAcceptance(o.acceptance, "input.acceptance"),
		dependsOn: o.dependsOn === undefined ? [] : expectArray(o.dependsOn, "input.dependsOn").map((d, i) => expectString(d, `input.dependsOn[${i}]`)),
		steps: steps.map((s, i) => {
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
		// Models reliably produce the step's sN but guess the task field's name —
		// accept the common aliases so a field-name slip isn't a failed call.
		taskId: expectString(o.taskId ?? o.task ?? o.task_id, "input.taskId"),
		step: parseStep({ id: o.id, text: o.text, status: "pending", callIds: [], ...(o.signal === undefined ? {} : { signal: o.signal }) }, "input"),
	};
}

export function parseTaskStepUpdateInput(value: unknown): { taskId: string; stepId: string; status: StepStatus; callIds: string[]; reason?: string; replacement?: { id: string; text: string } } {
	const o = expectObject(value, "input");
	const r = o.replacement === undefined ? undefined : expectObject(o.replacement, "input.replacement");
	return {
		taskId: expectString(o.taskId ?? o.task ?? o.task_id, "input.taskId"),
		stepId: expectString(o.stepId ?? o.step ?? o.step_id ?? o.id, "input.stepId"),
		status: expectOneOf(o.status, STEP_STATUSES, "input.status"),
		callIds: o.callIds === undefined ? [] : expectStringArray(o.callIds, "input.callIds"),
		...(o.reason === undefined ? {} : { reason: expectString(o.reason, "input.reason") }),
		...(r ? { replacement: { id: expectString(r.id, "input.replacement.id"), text: expectString(r.text, "input.replacement.text") } } : {}),
	};
}

/** Models sometimes serialize an array field as a JSON string — unwrap it. */
const expectArray = (value: unknown, path: string): unknown[] => {
	let v = value;
	if (typeof v === "string") {
		try {
			v = JSON.parse(v);
		} catch {
			throw new SchemaError(`${path}: expected an array, got a string that is not JSON`);
		}
	}
	if (!Array.isArray(v)) throw new SchemaError(`${path}: expected an array`);
	return v;
};

export function parseTaskReplaceInput(value: unknown): { tasks: TaskCreateInput[] } {
	const o = expectObject(value, "input");
	const tasks = expectArray(o.tasks, "input.tasks");
	if (tasks.length === 0)
		throw new SchemaError(
			"input.tasks: expected a non-empty array of tasks — each task needs id (a fresh one like t5, not an existing board id), title, acceptance {kind: \"command\", command}, and steps [{id, text}].",
		);
	return { tasks: tasks.map((t, i) => { try { return parseTaskCreateInput(t); } catch (e) { throw new SchemaError(`input.tasks[${i}]: ${e instanceof Error ? e.message : String(e)}`); } }) };
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
		id: expectString(o.id ?? o.taskId ?? o.task, "input.id"),
		status: expectOneOf(o.status, TASK_STATUSES, "input.status"),
		...(reason === undefined ? {} : { reason }),
	};
}

export function parseTaskRemoveInput(value: unknown): { id: string } {
	const o = expectObject(value, "input");
	return { id: expectString(o.id ?? o.taskId ?? o.task, "input.id") };
}
