/**
 * Task ledger schema (vscode-free): the shared Task/Step/Acceptance shapes and
 * their parsers. One schema serves the UI, persistence, replay and resume across
 * every provider — profiles change behavior, never this format.
 */

import { expectObject, expectOneOf, expectString, expectStringArray, SchemaError } from "./parse";

export const TASK_STATUSES = ["pending", "in_progress", "blocked", "done", "stale"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STEP_STATUSES = ["pending", "in_progress", "blocked", "done", "failed"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** Machine-checkable acceptance. `none` means the harness accepts the task once its steps are covered; `reviewer` is reserved and not enabled. */
export type Acceptance = { kind: "command"; command: string } | { kind: "reviewer"; rubric: string } | { kind: "none" };

/** Auto-completion hint: the step is done when a matching tool call finishes ok. `path` is a repo-relative glob. */
export interface StepSignal {
	tool: string;
	path?: string;
}

export interface Step {
	id: string;
	text: string;
	status: StepStatus;
	/** Tool-call ids that prove the step is done. Must all have finished ok before the step can be done. */
	callIds: string[];
	signal?: StepSignal;
	/** Why the step was failed — set when the model reopens a step it got wrong. */
	reason?: string;
}

export interface Task {
	id: string;
	title: string;
	acceptance: Acceptance;
	dependsOn: string[];
	status: TaskStatus;
	steps: Step[];
	evidence: string[];
	/** The run that owns this task — plans are per-run; tasks cross runs only via task.adopted. */
	runId?: string;
	/** Which plan version this task belongs to (p1, p2…). task_replace mints a new plan id and marks the old plan's open tasks stale — the superseded plan stays on the ledger as history; at most one plan is active per run. */
	planId?: string;
	/** The run this task was adopted from, when it crossed runs. */
	adoptedFrom?: string;
	/** Log seq at which the task last went in_progress — the calls that prove its steps finished after this. */
	startedSeq?: number;
	/** Seq the task entered the board — proof done while dep-blocked still counts. */
	createdSeq?: number;
	/** plan = seeded or model-planned work; divergence = harness-synthesized record of off-plan work the model actually did. Absent means plan (older logs). */
	origin?: "plan" | "divergence";
}

export function parseAcceptance(value: unknown, path = "acceptance"): Acceptance {
	const o = expectObject(value, path);
	if (o.kind === "command") return { kind: "command", command: expectString(o.command, `${path}.command`) };
	if (o.kind === "reviewer") return { kind: "reviewer", rubric: expectString(o.rubric, `${path}.rubric`) };
	if (o.kind === "none") return { kind: "none" };
	throw new SchemaError(`${path}.kind: expected command, reviewer or none`);
}

export function parseSignal(value: unknown, path: string): StepSignal | undefined {
	if (value === undefined) return undefined;
	const o = expectObject(value, path);
	const pathGlob = o.path === undefined ? undefined : expectString(o.path, `${path}.path`);
	return { tool: expectString(o.tool, `${path}.tool`), ...(pathGlob === undefined ? {} : { path: pathGlob }) };
}

export function parseStep(value: unknown, path = "step"): Step {
	const o = expectObject(value, path);
	const signal = parseSignal(o.signal, `${path}.signal`);
	return {
		id: expectString(o.id, `${path}.id`),
		text: expectString(o.text, `${path}.text`),
		status: expectOneOf(o.status, STEP_STATUSES, `${path}.status`),
		callIds: expectStringArray(o.callIds, `${path}.callIds`),
		...(signal ? { signal } : {}),
		...(o.reason === undefined ? {} : { reason: expectString(o.reason, `${path}.reason`) }),
	};
}

export function parseTask(value: unknown, path = "task"): Task {
	const o = expectObject(value, path);
	return {
		id: expectString(o.id, `${path}.id`),
		title: expectString(o.title, `${path}.title`),
		acceptance: parseAcceptance(o.acceptance, `${path}.acceptance`),
		dependsOn: expectStringArray(o.dependsOn, `${path}.dependsOn`),
		status: expectOneOf(o.status, TASK_STATUSES, `${path}.status`),
		steps: Array.isArray(o.steps) ? o.steps.map((s, i) => parseStep(s, `${path}.steps[${i}]`)) : (() => { throw new SchemaError(`${path}.steps: expected an array`); })(),
		evidence: expectStringArray(o.evidence, `${path}.evidence`),
		...(o.runId === undefined ? {} : { runId: expectString(o.runId, `${path}.runId`) }),
		...(o.planId === undefined ? {} : { planId: expectString(o.planId, `${path}.planId`) }),
		...(o.adoptedFrom === undefined ? {} : { adoptedFrom: expectString(o.adoptedFrom, `${path}.adoptedFrom`) }),
		...(o.origin === undefined ? {} : { origin: expectOneOf(o.origin, ["plan", "divergence"] as const, `${path}.origin`) }),
	};
}
