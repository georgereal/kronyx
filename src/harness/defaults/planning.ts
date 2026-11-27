/**
 * Planner pass (vscode-free). One model call at run start decomposes the task
 * into the harness-owned board: tasks with ordered steps, an acceptance check,
 * and per-step completion signals. The model never manages the board — the
 * loop emits the ledger events and advances them itself.
 *
 * A step's `signal` predicts which tool call will complete it; the loop marks
 * the step done when that call finishes ok, citing the call id as evidence.
 * Steps without a signal are covered by the task's acceptance check at
 * close-out. When the planner call fails or returns garbage, a single fallback
 * task keeps the board honest.
 */

import {
	expectObject,
	expectString,
	parseAcceptance,
	type Acceptance,
	type ModelPort,
	type Step,
	type StepSignal,
	type Task,
} from "../core/contracts";
import { emptyLedger } from "../core/taskLedger";
import type { PlanningPolicy, PlanResult } from "../core/policies/planning";

export type { PlanResult };

export const PLANNER_SYSTEM = [
	"You are the planner inside the Kronyx harness. Turn the user's task into a checklist the harness will track and verify.",
	"Reply with JSON only, no prose:",
	'{"tasks":[{"id":"t1","title":"short title","acceptance":{"kind":"command","command":"shell command that exits 0 when done"},"dependsOn":[],"steps":[{"id":"s1","text":"what to do","signal":{"tool":"tool_name","path":"optional/glob/**"}}]}]}',
	"Rules:",
	"- 1-4 tasks, ordered smallest-first. dependsOn lists task ids that must finish first.",
	"- Scale plan weight to the ask: a survey/explain/review ask gets 1-2 lightweight tasks with read/search signals and acceptance none; an implementation ask gets the full explore -> implement -> verify pipeline. For broad codebase surveys prefer explore_codebase signals — it reads in a separate context and returns digested findings.",
	"- Every step gets a signal predicting the tool call that completes it: tool is the tool name (read_file, search_files, list_files, write_file, edit_file, run_command, explore_codebase, ...). Add path only when the step names a concrete file — never invent paths (e.g. README.md that may not exist) and never put a glob on list/explore steps; a signal that no real call can match stalls the board.",
	"- acceptance: kind command with a real verification command (tests, lint, build) when one exists; kind none when nothing machine-checkable applies. Never use reviewer.",
	"- Steps are coarse (3-8 per task): explore, implement, verify — not individual file reads.",
	"- Earlier runs' plans (when listed) are context only — never create tasks whose purpose is to rediscover what a prior run already planned or found, and never plan to re-run their work. This run's board holds only tasks created for it.",
	"- A continuation ask (\"continue\", \"implement the plan\", \"go ahead\") on a session whose saved plans or earlier runs already produced a plan: plan the plan's own phases as steps — implement and verify work with write_file/edit_file/run_command signals. Fresh exploration steps here are always wrong; the exploring already happened.",
].join("\n");

const READ_ONLY_RULES = [
	"This run is READ-ONLY: steps may only read, search, and analyze. Never plan a step that writes, edits, or runs a mutating command — it cannot be executed and would block the whole board.",
	"The deliverable is the answer text (or the save_plan tool output in plan mode, which is the one allowed write and lands in .kronyx/plans/).",
	"Always use \"acceptance\":{\"kind\":\"none\"} — a command acceptance that checks files this run cannot create is unsatisfiable.",
].join("\n");



const MAX_TASKS = 4;
const MAX_STEPS = 8;

const slug = (value: string, fallback: string): string => {
	const s = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
	return s || fallback;
};

function parseSignal(value: unknown): StepSignal | undefined {
	if (value === undefined || value === null) return undefined;
	const o = expectObject(value, "signal");
	const path = o.path === undefined ? undefined : expectString(o.path, "signal.path");
	return { tool: expectString(o.tool, "signal.tool"), ...(path === undefined ? {} : { path }) };
}

export interface ParsedPlan {
	tasks: Task[];
	continueIds: string[];
	/** Slug of a saved plan the planner says already answers the task — skip adoption and answer from it. */
	reusePlan?: string;
}

/** Parses the planner's JSON reply into ledger tasks + adopted ids. Returns null when unusable. */
export function parsePlan(raw: string): ParsedPlan | null {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let doc: { tasks?: unknown; continue?: unknown; reuse_plan?: unknown };
	try {
		doc = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return null;
	}
	// An empty tasks array with continue ids is the adopt answer; an empty
	// reply overall is handled by the caller. A malformed doc returns null.
	// {"reuse_plan":"<slug>"} alone is the reuse-an-artifact answer.
	const reusePlan = typeof doc.reuse_plan === "string" ? doc.reuse_plan : undefined;
	if (!Array.isArray(doc.tasks)) return reusePlan ? { tasks: [], continueIds: [], reusePlan } : null;
	const continueIds = Array.isArray(doc.continue) ? doc.continue.filter((d): d is string => typeof d === "string") : [];
	const tasks: Task[] = [];
	const usedIds = new Set<string>();
	const rawToFinal = new Map<string, string>();
	const rawDeps = new Map<string, string[]>();
	for (const [i, value] of doc.tasks.slice(0, MAX_TASKS).entries()) {
		try {
			const o = expectObject(value, `tasks[${i}]`);
			const parsedAcceptance = parseAcceptance(o.acceptance ?? { kind: "none" }, `tasks[${i}].acceptance`);
			const acceptance: Acceptance = parsedAcceptance.kind === "reviewer" ? { kind: "none" } : parsedAcceptance;
			const stepsRaw = Array.isArray(o.steps) ? o.steps.slice(0, MAX_STEPS) : [];
			const seenSteps = new Set<string>();
			const steps: Step[] = [];
			for (const [j, sv] of stepsRaw.entries()) {
				try {
					const so = expectObject(sv, `tasks[${i}].steps[${j}]`);
					const id = slug(String(so.id ?? `s${j + 1}`), `s${j + 1}`);
					if (seenSteps.has(id)) continue;
					seenSteps.add(id);
					const signal = parseSignal(so.signal);
					steps.push({ id, text: expectString(so.text, `steps[${j}].text`), status: "pending", callIds: [], ...(signal ? { signal } : {}) });
				} catch {
					continue;
				}
			}
			if (!steps.length) continue;
			let id = slug(String(o.id ?? `t${i + 1}`), `t${i + 1}`);
			while (usedIds.has(id)) id = `${id}-${i + 1}`;
			usedIds.add(id);
			rawToFinal.set(String(o.id ?? `t${i + 1}`), id);
			rawDeps.set(id, Array.isArray(o.dependsOn) ? o.dependsOn.filter((d): d is string => typeof d === "string") : []);
			tasks.push({
				id,
				title: expectString(o.title ?? "", `tasks[${i}].title`, { allowEmpty: true }) || `Task ${tasks.length + 1}`,
				acceptance,
				dependsOn: [],
				status: "pending",
				steps,
				evidence: [],
			});
		} catch {
			continue;
		}
	}
	// Dependencies name tasks the way the planner wrote them; remap them to the ids the tasks received, dropping any that name no task.
	const finalIds = new Set(tasks.map((t) => t.id));
	for (const t of tasks) t.dependsOn = (rawDeps.get(t.id) ?? []).map((d) => rawToFinal.get(d) ?? slug(d, d)).filter((d) => finalIds.has(d) && d !== t.id);
	return { tasks, continueIds, ...(reusePlan ? { reusePlan } : {}) };
}

/** Deterministic board when the planner can't produce one: a single task with no machine check. */
export function fallbackPlan(taskText: string): Task[] {
	return [
		{
			id: "task-1",
			title: taskText.replace(/\s+/g, " ").trim().slice(0, 80) || "Task",
			acceptance: { kind: "none" },
			dependsOn: [],
			status: "pending",
			steps: [{ id: "s1", text: "Complete the task", status: "pending", callIds: [] }],
			evidence: [],
		},
	];
}

/**
 * One model call (no tools) that returns the board. Falls back on any failure.
 * When `board` is given (the current ledger rendered as text), the planner may
 * answer {"tasks":[]} — meaning the existing board already covers the request.
 */
export async function makePlan(model: ModelPort, taskText: string, opts: { signal?: AbortSignal; writable?: boolean; board?: string; plans?: string[] } = {}): Promise<PlanResult> {
	try {
		const boardBlock = opts.board
			? `\n\nPLANS FROM EARLIER RUNS IN THIS SESSION (context only — a run's board holds only the tasks you create for it; prior work is never adopted):\n${opts.board}\nReply {"tasks":[]} when nothing new is needed at all. Emit new tasks only for genuinely new work the earlier plans miss.`
			: "";
		const plansBlock = opts.plans?.length
			? `\n\nSAVED DELIVERABLES FROM EARLIER WORK (in .kronyx/plans/):\n${opts.plans.map((p) => `- ${p}`).join("\n")}\nIf one of these already answers the task well enough, reply {"reuse_plan":"<slug>"} — the run will answer from the artifact instead of re-deriving the analysis. If the ask is to continue or implement one of them, plan that plan's phases as implementation steps (write_file/edit_file/run_command signals) — never re-plan exploration.`
			: "";
		const response = await model.complete({
			turn: 0,
			system: opts.writable === false ? `${PLANNER_SYSTEM}\n${READ_ONLY_RULES}` : PLANNER_SYSTEM,
			messages: [{ kind: "user", text: `TASK:\n${taskText.slice(0, 4000)}${boardBlock}${plansBlock}`, seq: 0 }],
			ledger: emptyLedger(),
			tools: [],
			signal: opts.signal,
		});
		const parsed = parsePlan(response.text);
		if (parsed === null) return { tasks: fallbackPlan(taskText), continueIds: [], fallback: true };
		// An empty answer with no board to continue still needs a plan.
		if (parsed.tasks.length === 0 && parsed.continueIds.length === 0 && !parsed.reusePlan && !opts.board) return { tasks: fallbackPlan(taskText), continueIds: [], fallback: true };
		return { ...parsed, ...(response.usage ? { usage: response.usage } : {}) };
	} catch {
		return { tasks: fallbackPlan(taskText), continueIds: [], fallback: true };
	}
}

/** Today's planner prompt/parser/fallback as the default PlanningPolicy. */
export const defaultPlanningPolicy: PlanningPolicy = { plan: makePlan };
