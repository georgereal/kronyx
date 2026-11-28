/**
 * Harness report (vscode-free): a bounded, human-readable summary of what the
 * harness did over a session log — the plan it owned, where it intervened,
 * what context it spent, and how the work executed. Built once per run for the
 * IDE panel and the dashboard upload; pure over SessionEvents.
 */

import type { Acceptance, RunStatus, SessionEvent, StepSignal, StepStatus, TaskStatus } from "../core/contracts";
import type { Task, Step, Usage } from "../core/contracts";
import { project, reduce, type HarnessState } from "../core/projections";
import { callIsReadOnly, READ_ONLY_TOOL_NAMES } from "../defaults/steering";
import type { Ledger } from "../core/taskLedger";

export const REPORT_INTERVENTION_CAP = 200;
const TEXT_CAP = 300;

export interface ReportStep {
	id: string;
	text: string;
	status: StepStatus;
	signal?: StepSignal;
	/** Tool-call ids that prove the step (empty when acceptance-covered at close-out). */
	evidence: string[];
	/** Evidence resolved to readable calls: which tool, what target, whether it succeeded. */
	proof?: { name: string; target: string; ok: boolean }[];
	/** How the step closed: manual = model called task_step_update; auto = harness signal/window proof; acceptance = covered at close-out. */
	closedBy?: "manual" | "auto" | "acceptance";
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	/** Work calls proving this step (evidence count). */
	toolRuns?: number;
	/** Every tool call made while this step was open — plus failed close attempts — with proof/close attribution. */
	runs?: StepRun[];
	/** Set when this step replaced an earlier version's step — the before picture. */
	replacedFrom?: { text: string; signal?: string };
	/** Actor-attributed action log — the info panel. */
	actions?: { at: number; seq: number; actor: "model" | "harness" | "verifier"; label: string; detail?: string }[];
}

export interface StepRun {
	callId: string;
	seq: number;
	at: number;
	tool: string;
	target: string;
	ok: boolean;
	durationMs?: number;
	/** evidence = counted as proof of the step's work; close = task_step_update attempt on this step. */
	role?: "evidence" | "close" | "task";
	/** Failure output (truncated) — why a close was refused or a call failed. */
	error?: string;
	/** Full call input (JSON, truncated) and result output (truncated) — inspect in the UI instead of the raw log. */
	input?: string;
	output?: string;
}

export interface ReportTask {
	id: string;
	title: string;
	status: TaskStatus;
	acceptance: Acceptance;
	dependsOn: string[];
	steps: ReportStep[];
	/** plan = planner-authored; divergence = harness-recorded off-plan work. */
	origin?: "plan" | "divergence";
	planId?: string;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	/** Evolution class against the previous plan version (active-version tasks only). */
	evolutionClass?: EvolutionClass;
	/** Actor-attributed action log — who did what to this task, when. */
	actions?: { at: number; seq: number; actor: "model" | "harness" | "verifier"; label: string; detail?: string }[];
}

export interface DivergenceEpisode {
	id: string;
	title: string;
	/** unplanned-work = off-plan writes the harness recorded; step-replaced = the model changed how a step is implemented across plan versions; task-added = scope the model added beyond the original plan. */
	kind: "unplanned-work" | "step-replaced" | "task-added";
	lifecycle: { at: number; label: string }[];
	status: TaskStatus;
	startedAt: number;
	endedAt?: number;
	/** Off-plan write/run calls in the episode window. */
	calls: { seq: number; name: string; target: string; ok: boolean }[];
	/** harness = a harness intervention (refusal, loop verdict, compaction) immediately preceded the episode — the harness's backlog. model = no such trigger — the model-quality signal. Unplanned-work episodes only. */
	cause?: "harness" | "model";
	causeDetail?: string;
	/** step-replaced only: the before/after. */
	replacement?: { wasText: string; newText: string; wasSignal?: string; newSignal?: string; taskId: string; stepId: string };
}

export interface ReportPlanVersion {
	id: string;
	/** First task.created of this version. */
	createdAt: number;
	taskCount: number;
	stepCount: number;
	status: "active" | "superseded";
	/** Task ids created under this planId, in creation order. */
	tasks: string[];
	/** Short label derived from the first task titles. */
	label: string;
}

export type EvolutionClass = "retained" | "modified" | "added";

export interface StepReplacement {
	taskId: string;
	stepId: string;
	wasText: string;
	newText: string;
	wasSignal?: string;
	newSignal?: string;
	/** First task.created of the version carrying the replacement. */
	at: number;
	/** The new version's task/step it landed on. */
	newTaskId: string;
	newStepId: string;
}

export interface ReportEvolution {
	transitions: {
		from: string;
		to: string;
		retained: number;
		modified: number;
		added: number;
		discarded: number;
		/** Task-pair mappings — old task → matched new task (undefined when discarded). */
		pairs: { oldId: string; oldTitle: string; newId?: string; newTitle?: string; class: "retained" | "modified" | "discarded" }[];
		/** New tasks with no old match — added scope. */
		addedTasks: { id: string; title: string }[];
	}[];
	/** Lifecycle class of the active version's tasks — drives the tree chips. */
	taskClasses: Record<string, EvolutionClass>;
	stepReplacements: StepReplacement[];
}

export interface ReportTimelineRow {
	seq: number;
	at: number;
	kind: "turn" | "tool" | "intervention" | "lifecycle" | "step" | "verifier" | "run" | "user";
	label: string;
	detail?: string;
	ok?: boolean;
	/** Model reasoning for the turn (from the reasoning field or provider items). */
	reasoning?: string;
	/** The model's visible reply text for the turn. */
	text?: string;
	/** Tool call payload (truncated) — inspect in place. */
	input?: string;
	output?: string;
	callId?: string;
}

export interface ReportTurn {
	turn: number;
	seq: number;
	at: number;
	providerId?: string;
	modelId?: string;
	/** Provider item ids — reasoning (rs_*), message (msg_*), per-call (fc_*). */
	reasoningId?: string;
	messageId?: string;
	text: string;
	reasoning?: string;
	toolCalls: { callId: string; name: string; target: string }[];
	usage?: { input: number; output: number; cached: number };
}

export interface ReportExecution {
	callId: string;
	seq: number;
	tool: string;
	target: string;
	ok: boolean;
	startedAt: number;
	endedAt: number;
	durationMs: number;
	/** Parsed from the exit-N output prefix (run_command only). */
	exitCode?: number;
	/** Leading cd target in the command, when present. */
	cwd?: string;
	input: string;
	output: string;
	error?: string;
}

export interface ReportArtifact {
	path: string;
	tools: string[];
	writes: number;
	firstAt: number;
	lastAt: number;
}

export interface ReportRun {
	runId: string;
	status?: RunStatus;
	startedAt: number;
	endedAt: number;
	turns: number;
	toolCalls: number;
	/** Ledger tasks this run's planner emitted (0 = ran without a board). */
	tasksCreated: number;
	tokensIn: number;
	tokensOut: number;
}

export type InterventionKind = "steer" | "loop" | "budget" | "refused" | "verifier" | "recap" | "clear" | "status";

export interface Intervention {
	seq: number;
	at: number;
	runId: string;
	kind: InterventionKind;
	label: string;
	detail?: string;
}

export interface HarnessReport {
	generatedAt: number;
	/** Per-run aggregates in first-seen order. */
	runs: ReportRun[];
	/** Ledger snapshot at the end of the selected run (opts.runId) or the log end. */
	board: { tasks: ReportTask[] };
	interventions: Intervention[];
	/** Interventions dropped by REPORT_INTERVENTION_CAP. */
	interventionsOmitted: number;
	/** Off-plan work episodes the harness recorded, oldest first. */
	divergence: DivergenceEpisode[];
	/** Rollup: episodes by attributed cause. */
	divergenceSummary: { episodes: number; harnessCaused: number; modelCaused: number; calls: number };
	/** Plan versions in creation order — single-entry for unversioned/seeded runs. */
	plans: ReportPlanVersion[];
	evolution: ReportEvolution;
	/** Chronological execution rows for the timeline tab, capped. */
	timeline: ReportTimelineRow[];
	timelineOmitted: number;
	artifacts: ReportArtifact[];
	/** Per-turn detail for the turn inspector. */
	turns: ReportTurn[];
	/** Per-tool-call execution detail for the execution inspector. */
	executions: ReportExecution[];
	/** The raw event stream, payload-capped, for the Run Data tab. */
	events: Record<string, unknown>[];
	eventsOmitted: number;
	/** Header tile rollup. */
	summary: {
		planVersions: number;
		tasks: { total: number; completed: number; changed: number };
		steps: { total: number; completed: number; skipped: number; replaced: number };
		toolRuns: { total: number; succeeded: number; retried: number };
		divergences: { total: number; unplanned: number; stepReplaced: number; taskAdded: number };
		startedAt: number;
		endedAt: number;
		durationMs: number;
	};
	context: {
		turns: number;
		toolCalls: number;
		toolFailures: number;
		refusals: number;
		tokens: { input: number; output: number; cached: number };
		/** Input-token attribution by what spent them. */
		bySource: { model: number; planner: number; tools: number; recap: number };
		/** Per-turn input tokens — what each model request actually sent. */
		perTurn: { turn: number; input: number; output: number }[];
		recaps: number;
		clears: number;
		budgetWarnings: number;
	};
	execution: {
		tools: { name: string; calls: number; failures: number }[];
		/** Steps closed by a matching tool call (evidence callIds). */
		stepsSignalDone: number;
		/** Steps closed by acceptance coverage at harness close-out (no callIds). */
		stepsCoveredAtCloseout: number;
		readFileCalls: number;
		readFilesCalls: number;
		exploreCalls: number;
		/** Model turns whose tool calls were all read-only. */
		exploreTurns: number;
		/** Longest consecutive run of read-only turns — the wandering signal. */
		maxReadOnlyStreak: number;
	};
}

const clip = (s: string, cap = TEXT_CAP): string => (s.length > cap ? `${s.slice(0, cap)}…` : s);

/** Mirrors the kernel's divergence write set — the work that counts as off-plan when it serves no open signal. */
const DIVERGENCE_WRITE_TOOLS = new Set(["write_file", "edit_file", "file_editor", "append_file", "insert_lines", "apply_patch", "rename_symbol", "run_command", "start_process"]);
const TASK_TOOL_SET_LOCAL = new Set(["task_create", "task_update", "task_step_update", "task_replace", "task_remove", "step_add", "save_plan", "read_plan", "list_plans"]);

const taskView = (t: Task): ReportTask => ({
	id: t.id,
	title: t.title,
	status: t.status,
	acceptance: t.acceptance,
	dependsOn: t.dependsOn,
	...(t.origin ? { origin: t.origin } : {}),
	steps: t.steps.map((s: Step) => ({
		id: s.id,
		text: s.text,
		status: s.status,
		...(s.signal ? { signal: s.signal } : {}),
		evidence: [...s.callIds],
	})),
});

const boardView = (ledger: Ledger): { tasks: ReportTask[] } => ({
	tasks: ledger.order.flatMap((id) => {
		const t = ledger.tasks[id];
		return t ? [taskView(t)] : [];
	}),
});

/** Maps one event to an intervention entry, or null when it isn't one. */
function interventionOf(e: SessionEvent): { kind: InterventionKind; label: string; detail?: string } | null {
	switch (e.type) {
		case "task.updated":
			// Routine pending→in_progress flips are noise; blocked is worth showing.
			return e.to === "blocked" ? { kind: "status", label: `task ${e.id} blocked`, ...(e.reason ? { detail: clip(e.reason) } : {}) } : null;
		case "verifier.result":
			return { kind: "verifier", label: `acceptance ${e.taskId}: ${e.ok ? "passed" : "failed"}`, ...(e.detail ? { detail: clip(e.detail) } : {}) };
		case "stop.refused":
			return { kind: "refused", label: "finish refused — open work remains", detail: clip(e.openTaskIds.join(", ")) };
		case "budget.warning":
			return { kind: "budget", label: `input tokens ${e.used}/${e.limit}` };
		case "steer.note":
			return { kind: "steer", label: e.rule, detail: clip(e.text) };
		case "context.recap":
			return { kind: "recap", label: `recap covered ${e.covers} messages`, detail: clip(e.text) };
		case "context.cleared":
			return { kind: "clear", label: "context cleared" };
		case "loop.verdict":
			return e.level === "none" ? null : { kind: "loop", label: `loop control: ${e.level}`, ...(e.reason ? { detail: clip(e.reason) } : {}) };
		case "run.status":
			return e.status === "running" ? null : { kind: "status", label: `run ${e.status}`, ...(e.reason ? { detail: clip(e.reason) } : {}) };
		default:
			return null;
	}
}

/**
 * Builds the report over a whole session log. With `opts.runId`, stats and the
 * intervention list are scoped to that run and the board is the ledger snapshot
 * at that run's last event; without it everything covers the whole log.
 */
export function buildHarnessReport(events: readonly SessionEvent[], opts: { runId?: string; now?: () => number } = {}): HarnessReport {
	const scoped = opts.runId;
	const inScope = (e: SessionEvent) => scoped === undefined || e.runId === scoped;

	const runs = new Map<string, ReportRun>();
	const interventions: Intervention[] = [];
	let interventionsSeen = 0;
	const context = {
		turns: 0,
		toolCalls: 0,
		toolFailures: 0,
		refusals: 0,
		tokens: { input: 0, output: 0, cached: 0 },
		bySource: { model: 0, planner: 0, tools: 0, recap: 0 },
		perTurn: [] as { turn: number; input: number; output: number }[],
		recaps: 0,
		clears: 0,
		budgetWarnings: 0,
	};
	const toolStats = new Map<string, { calls: number; failures: number }>();
	// callId → requested input, enriched with the outcome when it finishes — the
	// resolution table for step evidence. manualCloses keys "taskId/stepId" named
	// by a model task_step_update call: everything else closed harness-side.
	const callTable = new Map<string, { name: string; input: Record<string, unknown>; ok?: boolean; at?: number; output?: string }>();
	/** Every external call + close attempt, attributed to the step open at the time. Keyed "taskId/stepId". */
	const stepRuns = new Map<string, import("./report").StepRun[]>();
	/** Currently-open steps in open order — a call attributes to the most recently opened one. */
	const openStepKeys: string[] = [];
	const manualCloses = new Set<string>();
	const execution = { stepsSignalDone: 0, stepsCoveredAtCloseout: 0, readFileCalls: 0, readFilesCalls: 0, exploreCalls: 0, exploreTurns: 0, maxReadOnlyStreak: 0 };
	let readOnlyStreak = 0;

	// Dashboard collection: versions, lifecycle, actions, timeline, artifacts, retries.
	const TIMELINE_CAP = 500;
	const timeline: ReportTimelineRow[] = [];
	let timelineSeen = 0;
	const turnDetails: ReportTurn[] = [];
	const executions: ReportExecution[] = [];
	const rawEvents: Record<string, unknown>[] = [];
	// Raw events embedded payload-capped — the Run Data tab reads these on the web.
	const RAW_EVENT_CAP = 3000;
	const RAW_TOTAL_CAP = 4 * 1024 * 1024;
	let rawBytes = 0;
	let rawOmitted = 0;
	const capDeep = (v: unknown): unknown => {
		if (typeof v === "string") return v.length > RAW_EVENT_CAP ? `${v.slice(0, RAW_EVENT_CAP)}…` : v;
		if (Array.isArray(v)) return v.map(capDeep);
		if (v && typeof v === "object") {
			const o: Record<string, unknown> = {};
			for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = capDeep(x);
			return o;
		}
		return v;
	};
	const pushTimeline = (e: SessionEvent, row: Omit<ReportTimelineRow, "seq" | "at">) => {
		timelineSeen++;
		if (timeline.length < TIMELINE_CAP) timeline.push({ seq: e.seq, at: e.at, ...row });
	};
	/** taskId → creation-time snapshot + planId — the version composition record. */
	const createdTasks = new Map<string, { at: number; seq: number; runId: string; planId: string; task: Task; viaTool?: string }>();
	const taskLife = new Map<string, { startedAt?: number; endedAt?: number }>();
	const stepLife = new Map<string, { startedAt?: number; endedAt?: number }>();
	const life = <T extends { startedAt?: number; endedAt?: number }>(map: Map<string, T>, key: string): T => {
		const row = map.get(key) ?? ({} as T);
		map.set(key, row);
		return row;
	};
	const artifactMap = new Map<string, { tools: Set<string>; writes: number; firstAt: number; lastAt: number }>();
	const fingerprints = new Map<string, number>();
	let retriedRuns = 0;
	const fpOf = (name: string, input: unknown) => `${name}:${JSON.stringify(input ?? {})}`;
	const ARTIFACT_WRITE_TOOLS = new Set(["write_file", "edit_file", "append_file", "insert_lines", "apply_patch", "rename_symbol"]);

	/** Actor-attributed action logs per task/step — the "(i)" panel data. Bounded per entity. */
	const ACTION_CAP = 40;
	type Action = { at: number; seq: number; actor: "model" | "harness" | "verifier"; label: string; detail?: string };
	const taskActions = new Map<string, Action[]>();
	const stepActions = new Map<string, Action[]>();
	const pushAction = (map: Map<string, Action[]>, key: string, a: Action) => {
		const list = map.get(key) ?? [];
		if (list.length < ACTION_CAP) list.push(a);
		map.set(key, list);
	};
	/** In-flight task-tool call — a ledger event landing while one is open is model-caused; anything else is harness-caused (auto-advance, close-out). */
	let pendingTaskTool: { name: string; taskId?: string; stepId?: string } | undefined;

	// Replay for the board: snapshot the ledger after each run's last event.
	const ledgerByRun = new Map<string, Ledger>();
	let state: HarnessState = project([]);
	let lastLedger: Ledger = state.ledger;

	const addTokens = (u: Usage | undefined, source: keyof HarnessReport["context"]["bySource"]) => {
		if (!u) return;
		context.tokens.input += u.inputTokens;
		context.tokens.output += u.outputTokens;
		context.tokens.cached += u.cachedTokens;
		context.bySource[source] += u.inputTokens;
	};

	for (const e of events) {
		if (rawBytes < RAW_TOTAL_CAP) {
			const capped = capDeep(e) as Record<string, unknown>;
			rawBytes += JSON.stringify(capped).length;
			rawEvents.push(capped);
		} else {
			rawOmitted++;
		}
		state = reduce(state, e);
		lastLedger = state.ledger;
		ledgerByRun.set(e.runId, state.ledger);

		// Evidence resolution is scope-independent — a call proves a step whichever run slice is selected.
		if (e.type === "tool.requested") {
			callTable.set(e.callId, { name: e.name, input: (e.input ?? {}) as Record<string, unknown>, at: e.at });
			if (TASK_TOOL_SET_LOCAL.has(e.name)) {
				const inp = (e.input ?? {}) as { taskId?: unknown; id?: unknown; stepId?: unknown };
				const tid = inp.taskId ?? inp.id;
				pendingTaskTool = { name: e.name, taskId: typeof tid === "string" ? tid : undefined, stepId: typeof inp.stepId === "string" ? inp.stepId : undefined };
			}
			if (e.name === "task_step_update") {
				const inp = (e.input ?? {}) as { taskId?: unknown; id?: unknown; stepId?: unknown };
				const tid = inp.taskId ?? inp.id;
				if (typeof tid === "string" && typeof inp.stepId === "string") manualCloses.add(`${tid}/${inp.stepId}`);
			}
		}
		if (e.type === "tool.finished") {
			const row = callTable.get(e.callId);
			if (row) {
				row.ok = e.ok;
				row.output = e.output;
				if (!TASK_TOOL_SET_LOCAL.has(e.name)) {
					const exitLine = e.name === "run_command" ? /^exit (\d+)\n/.exec(e.output ?? "") : null;
					const cdMatch = e.name === "run_command" && typeof row.input.command === "string" ? /^\s*cd\s+([^\s;&]+)\s*&&/.exec(row.input.command) : null;
					executions.push({
						callId: e.callId,
						seq: e.seq,
						tool: e.name,
						target: targetOf(row.input).slice(0, 200),
						ok: e.ok,
						startedAt: row.at ?? e.at,
						endedAt: e.at,
						durationMs: row.at === undefined ? 0 : Math.max(0, e.at - row.at),
						...(exitLine ? { exitCode: Number(exitLine[1]) } : e.name === "run_command" && !e.ok ? { exitCode: 1 } : {}),
						...(cdMatch ? { cwd: cdMatch[1] } : {}),
						input: clip(JSON.stringify(row.input), 3000),
						output: clip(e.output ?? "", 3000),
						...(e.ok ? {} : { error: clip(e.output ?? "") }),
					});
				}
				const durationMs = row.at === undefined ? undefined : Math.max(0, e.at - row.at);
				if (!TASK_TOOL_SET_LOCAL.has(e.name)) {
					// external work call — attribute to the most recently opened still-open step
					const key = openStepKeys[openStepKeys.length - 1];
					if (key) {
						const arr = stepRuns.get(key) ?? [];
						arr.push({ callId: e.callId, seq: e.seq, at: row.at ?? e.at, tool: e.name, target: targetOf(row.input).slice(0, 120), ok: e.ok, ...(durationMs !== undefined ? { durationMs } : {}), input: clip(JSON.stringify(row.input), 3000), output: clip(e.output ?? "", 3000), ...(e.ok ? {} : { error: clip(e.output ?? "") }) });
						stepRuns.set(key, arr);
					}
				} else if (e.name === "task_step_update") {
					// close attempts — the failures are the model/harness gap story, so they belong in the step's run list
					const inp = row.input as { taskId?: unknown; id?: unknown; stepId?: unknown };
					const tid = typeof (inp.taskId ?? inp.id) === "string" ? String(inp.taskId ?? inp.id) : undefined;
					const sid = typeof inp.stepId === "string" ? inp.stepId : undefined;
					if (tid && sid) {
						const key = `${tid}/${sid}`;
						const arr = stepRuns.get(key) ?? [];
						arr.push({ callId: e.callId, seq: e.seq, at: row.at ?? e.at, tool: e.name, target: `${tid}/${sid}`, ok: e.ok, role: "close", ...(durationMs !== undefined ? { durationMs } : {}), input: clip(JSON.stringify(row.input), 3000), output: clip(e.output ?? "", 3000), ...(e.ok ? {} : { error: clip(e.output ?? "") }) });
						stepRuns.set(key, arr);
					}
				}
			}
			if (TASK_TOOL_SET_LOCAL.has(e.name)) pendingTaskTool = undefined;
		}

		const run = runs.get(e.runId) ?? { runId: e.runId, startedAt: e.at, endedAt: e.at, turns: 0, toolCalls: 0, tasksCreated: 0, tokensIn: 0, tokensOut: 0 };
		run.endedAt = e.at;
		runs.set(e.runId, run);

		if (inScope(e)) {
			const hit = interventionOf(e);
			if (hit) {
				interventionsSeen++;
				if (interventions.length < REPORT_INTERVENTION_CAP) {
					interventions.push({ seq: e.seq, at: e.at, runId: e.runId, ...hit });
				}
				pushTimeline(e, { kind: "intervention", label: hit.label, detail: hit.detail });
			}

			switch (e.type) {
				case "model.response": {
					const pi = e.providerItems;
					const items = (pi?.items ?? []) as { type?: unknown; id?: unknown }[];
					turnDetails.push({
						turn: e.turn,
						seq: e.seq,
						at: e.at,
						...(pi?.providerId ? { providerId: pi.providerId } : {}),
						...(pi?.modelId ? { modelId: pi.modelId } : {}),
						...(items.find((i) => i.type === "reasoning")?.id ? { reasoningId: String(items.find((i) => i.type === "reasoning")!.id) } : {}),
						...(items.find((i) => i.type === "message")?.id ? { messageId: String(items.find((i) => i.type === "message")!.id) } : {}),
						text: clip(e.text ?? "", 2000),
						...(reasoningOf(e) ? { reasoning: reasoningOf(e) } : {}),
						toolCalls: e.toolCalls.map((c) => ({ callId: c.callId, name: c.name, target: targetOf(((c.input ?? {}) as Record<string, unknown>)).slice(0, 200) })),
						...(e.usage ? { usage: { input: e.usage.inputTokens, output: e.usage.outputTokens, cached: e.usage.cachedTokens } } : {}),
					});
					context.turns++;
					run.turns = Math.max(run.turns, e.turn);
					addTokens(e.usage, "model");
					if (e.usage) context.perTurn.push({ turn: e.turn, input: e.usage.inputTokens, output: e.usage.outputTokens });
					run.tokensIn += e.usage?.inputTokens ?? 0;
					run.tokensOut += e.usage?.outputTokens ?? 0;
					pushTimeline(e, {
						kind: "turn",
						label: `turn ${e.turn}${e.toolCalls.length ? ` — ${e.toolCalls.map((c) => c.name).join(", ")}` : " — text"}`,
						detail: e.usage ? `${e.usage.inputTokens.toLocaleString()} in / ${e.usage.outputTokens.toLocaleString()} out` : undefined,
						...(reasoningOf(e) ? { reasoning: reasoningOf(e) } : {}),
						...(e.text ? { text: clip(e.text, 2000) } : {}),
					});
					const readOnly = e.toolCalls.length > 0 && e.toolCalls.every((c) => READ_ONLY_TOOL_NAMES.has(c.name));
					if (readOnly) {
						execution.exploreTurns++;
						readOnlyStreak++;
						execution.maxReadOnlyStreak = Math.max(execution.maxReadOnlyStreak, readOnlyStreak);
					} else {
						readOnlyStreak = 0;
					}
					break;
				}
				case "tool.finished": {
					context.toolCalls++;
					if (!e.ok) context.toolFailures++;
					run.toolCalls++;
					addTokens(e.usage, "tools");
					const stat = toolStats.get(e.name) ?? { calls: 0, failures: 0 };
					stat.calls++;
					if (!e.ok) stat.failures++;
					toolStats.set(e.name, stat);
					if (e.name === "read_file") execution.readFileCalls++;
					if (e.name === "read_files") execution.readFilesCalls++;
					if (e.name === "explore_codebase") execution.exploreCalls++;
					const input = callTable.get(e.callId)?.input ?? {};
					const fp = fpOf(e.name, input);
					const seen = fingerprints.get(fp) ?? 0;
					if (seen > 0) retriedRuns++;
					fingerprints.set(fp, seen + 1);
					const path = typeof input.path === "string" ? input.path : "";
					const isEditorWrite = e.name === "file_editor" && typeof input.command === "string" && input.command !== "view";
					if (path && (ARTIFACT_WRITE_TOOLS.has(e.name) || isEditorWrite)) {
						const a = artifactMap.get(path) ?? { tools: new Set<string>(), writes: 0, firstAt: e.at, lastAt: e.at };
						a.tools.add(e.name);
						a.writes++;
						a.lastAt = e.at;
						artifactMap.set(path, a);
					}
					if (!READ_ONLY_TOOL_NAMES.has(e.name) && !TASK_TOOL_SET_LOCAL.has(e.name)) {
						pushTimeline(e, {
						kind: "tool",
						label: `${e.name}${path ? ` ${path.split("/").pop()}` : typeof input.command === "string" ? ` ${String(input.command).slice(0, 60)}` : ""}`,
						ok: e.ok,
						callId: e.callId,
						input: clip(JSON.stringify(input), 1500),
						output: clip(e.output ?? "", 1500),
					});
					}
					break;
				}
				case "task.created": {
					run.tasksCreated++;
					addTokens(e.usage, "planner");
					createdTasks.set(e.task.id, { at: e.at, seq: e.seq, runId: e.runId, planId: e.task.planId ?? "p0", task: e.task, viaTool: pendingTaskTool?.name });
					pushTimeline(e, { kind: "lifecycle", label: `task ${e.task.id} created — ${e.task.title}`, detail: e.task.planId ? `plan ${e.task.planId}` : undefined });
					const creatorActor = e.task.origin === "divergence" ? "harness" : pendingTaskTool ? "model" : "harness";
					pushAction(taskActions, e.task.id, {
						at: e.at, seq: e.seq, actor: creatorActor,
						label: creatorActor === "model" ? `created by model${pendingTaskTool ? ` via ${pendingTaskTool.name}` : ""}` : e.task.origin === "divergence" ? "recorded by harness — off-plan work" : `seeded by planner${e.task.planId ? ` (${e.task.planId})` : ""}`,
						detail: `${e.task.steps.length} steps · acceptance: ${e.task.acceptance.kind === "command" ? e.task.acceptance.command : e.task.acceptance.kind}`,
					});
					break;
				}
				case "task.updated": {
					const row = life(taskLife, e.id);
					if (e.to === "in_progress" && row.startedAt === undefined) row.startedAt = e.at;
					if ((e.to === "done" || e.to === "blocked" || e.to === "stale") && row.endedAt === undefined) row.endedAt = e.at;
					if (e.to === "done" || e.to === "blocked" || e.to === "stale") pushTimeline(e, { kind: "lifecycle", label: `task ${e.id} ${e.to}` });
					const byModel = pendingTaskTool !== undefined;
					pushAction(taskActions, e.id, {
						at: e.at, seq: e.seq, actor: byModel ? "model" : "harness",
						label: `${byModel ? "model marked" : "harness moved"} → ${e.to}`,
						...(e.reason ? { detail: clip(e.reason) } : {}),
					});
					break;
				}
				case "step.updated": {
					pushTimeline(e, { kind: "step", label: `step ${e.taskId}/${e.stepId} → ${e.to}${e.to === "done" ? (e.callIds.length ? ` (${e.callIds.length} proving)` : " (acceptance-covered)") : ""}` });
					const row = life(stepLife, `${e.taskId}/${e.stepId}`);
					if (e.to === "in_progress" && row.startedAt === undefined) row.startedAt = e.at;
					if (e.to === "in_progress") {
						const key = `${e.taskId}/${e.stepId}`;
						if (!openStepKeys.includes(key)) openStepKeys.push(key);
					}
					if (e.to === "done" || e.to === "failed" || e.to === "pending") {
						const key = `${e.taskId}/${e.stepId}`;
						const ix = openStepKeys.indexOf(key);
						if (ix >= 0) openStepKeys.splice(ix, 1);
					}
					if ((e.to === "done" || e.to === "failed") && row.endedAt === undefined) row.endedAt = e.at;
					if (e.to === "done") {
						if (e.callIds.length) execution.stepsSignalDone++;
						else execution.stepsCoveredAtCloseout++;
					}
					const byModel = pendingTaskTool?.taskId === e.taskId && pendingTaskTool?.stepId === e.stepId;
					const label = `${byModel ? "model marked" : "harness moved"} → ${e.to}${e.to === "done" ? (e.callIds.length ? ` (${e.callIds.length} proving call${e.callIds.length === 1 ? "" : "s"})` : " (acceptance-covered)") : ""}`;
					pushAction(stepActions, `${e.taskId}/${e.stepId}`, { at: e.at, seq: e.seq, actor: byModel ? "model" : "harness", label });
					pushAction(taskActions, e.taskId, { at: e.at, seq: e.seq, actor: byModel ? "model" : "harness", label: `step ${e.stepId} ${label}` });
					break;
				}
				case "verifier.result":
					pushAction(taskActions, e.taskId, { at: e.at, seq: e.seq, actor: "verifier", label: `acceptance ${e.ok ? "passed" : "failed"}`, detail: clip(e.detail ?? "") });
					break;
				case "stop.refused":
					context.refusals++;
					break;
				case "budget.warning":
					context.budgetWarnings++;
					break;
				case "context.recap":
					context.recaps++;
					addTokens(e.usage, "recap");
					break;
				case "context.cleared":
					context.clears++;
					break;
				case "steer.note": {
					const refs = e.text.match(/\bt\d+\b/g) ?? [];
					for (const ref of new Set(refs)) {
						pushAction(taskActions, ref, { at: e.at, seq: e.seq, actor: "harness", label: `steer ${e.rule}`, detail: clip(e.text) });
					}
					break;
				}
				case "run.status":
					run.status = e.status;
					if (e.status === "running") pushTimeline(e, { kind: "run", label: "run started" });
					break;
				case "user.input":
					pushTimeline(e, { kind: "user", label: "user task", detail: clip(e.text ?? "", 400) });
					break;
			}
		}
	}

	const boardLedger = scoped ? (ledgerByRun.get(scoped) ?? lastLedger) : lastLedger;
	function reasoningOf(e: SessionEvent): string | undefined {
		if (e.type !== "model.response") return undefined;
		if (e.reasoning) return clip(e.reasoning, 4000);
		const items = e.providerItems?.items;
		if (!Array.isArray(items)) return undefined;
		const parts: string[] = [];
		for (const item of items as { type?: unknown; content?: unknown }[]) {
			if (item?.type !== "reasoning" || !Array.isArray(item.content)) continue;
			for (const c of item.content as { type?: unknown; text?: unknown }[]) {
				if (c?.type === "reasoning_text" && typeof c.text === "string") parts.push(c.text);
			}
		}
		return parts.length ? clip(parts.join("\n\n"), 4000) : undefined;
	}

	function targetOf(input: Record<string, unknown>): string {
		if (typeof input.command === "string") return input.command;
		if (typeof input.path === "string") return input.path;
		if (Array.isArray(input.files)) return (input.files as { path?: unknown }[]).map((f) => String(f?.path ?? "")).filter(Boolean).join(", ");
		return "";
	}
	const board = boardView(boardLedger);
	for (const task of board.tasks) {
		for (const step of task.steps) {
			// Run attachment is status-independent — unclosed steps are exactly where the
			// friction story lives (failed close attempts on steps that never close).
			const runs = stepRuns.get(`${task.id}/${step.id}`);
			if (runs?.length) {
				const evidenceSet = new Set(step.evidence);
				for (const r of runs) if (r.role !== "close" && evidenceSet.has(r.callId)) r.role = "evidence";
				step.runs = runs.sort((x, y) => x.seq - y.seq);
			}
			if (step.status !== "done" && step.status !== "failed") continue;
			step.closedBy = step.evidence.length === 0 ? "acceptance" : manualCloses.has(`${task.id}/${step.id}`) ? "manual" : "auto";
			const proof = step.evidence.flatMap((id) => {
				const row = callTable.get(id);
				return row ? [{ name: row.name, target: targetOf(row.input).slice(0, 120), ok: row.ok ?? true }] : [];
			});
			if (proof.length) step.proof = proof;
		}
	}
	// ---------- Plan versions, lifecycle enrichment, evolution diff ----------

	/** Version composition: tasks grouped by planId in first-seen order. p0 = unversioned (older logs). */
	const versionOrder: string[] = [];
	const versionTasks = new Map<string, { at: number; tasks: { id: string; title: string; steps: { id: string; text: string; signal?: string }[] }[] }>();
	for (const [id, row] of createdTasks) {
		if (scoped !== undefined && row.runId !== scoped) continue;
		let v = versionTasks.get(row.planId);
		if (!v) {
			v = { at: row.at, tasks: [] };
			versionTasks.set(row.planId, v);
			versionOrder.push(row.planId);
		}
		v.at = Math.min(v.at, row.at);
		v.tasks.push({
			id,
			title: row.task.title,
			steps: row.task.steps.map((s) => ({ id: s.id, text: s.text, ...(s.signal ? { signal: `${s.signal.tool}${s.signal.path ? ` ${s.signal.path}` : ""}` } : {}) })),
		});
	}
	// Order versions: p0 first if present, then numeric plan order.
	versionOrder.sort((a, b) => (a === "p0" ? -1 : b === "p0" ? 1 : Number(a.slice(1)) - Number(b.slice(1))));
	const activeVersion = versionOrder.at(-1);
	const plans: ReportPlanVersion[] = versionOrder.map((id) => {
		const v = versionTasks.get(id)!;
		return {
			id,
			createdAt: v.at,
			taskCount: v.tasks.length,
			stepCount: v.tasks.reduce((n, t) => n + t.steps.length, 0),
			status: id === activeVersion ? "active" : "superseded",
			tasks: v.tasks.map((t) => t.id),
			label: v.tasks[0]?.title ?? id,
		};
	});

	/** Normalized text for cross-version matching — ids can't match (replacements must be fresh), so titles carry it. */
	const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
	const tokens = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 2));
	const similarity = (a: string, b: string): number => {
		const ta = tokens(a);
		const tb = tokens(b);
		if (!ta.size || !tb.size) return 0;
		let inter = 0;
		for (const w of ta) if (tb.has(w)) inter++;
		return inter / Math.max(ta.size, tb.size);
	};

	const taskClasses: Record<string, EvolutionClass> = {};
	const stepReplacements: StepReplacement[] = [];
	const transitions: ReportEvolution["transitions"] = [];
	for (let i = 1; i < versionOrder.length; i++) {
		const prev = versionTasks.get(versionOrder[i - 1]!)!;
		const next = versionTasks.get(versionOrder[i]!)!;
		const nextAt = next.at;
		const used = new Set<number>();
		let retained = 0;
		let modified = 0;
		// Match each old task to the best new one — exact normalized title first, then token similarity.
		const matches: { oldT: (typeof prev.tasks)[number]; newT: (typeof next.tasks)[number] | undefined; score: number }[] = [];
		for (const oldT of prev.tasks) {
			let best: { idx: number; score: number } | undefined;
			next.tasks.forEach((newT, idx) => {
				if (used.has(idx)) return;
				const exact = norm(oldT.title) === norm(newT.title);
				const score = exact ? 1 : similarity(oldT.title, newT.title);
				if (score >= 0.5 && (!best || score > best.score)) best = { idx, score };
			});
			if (best) {
				used.add(best.idx);
				matches.push({ oldT, newT: next.tasks[best.idx], score: best.score });
			} else {
				matches.push({ oldT, newT: undefined, score: 0 });
			}
		}
		for (const m of matches) {
			if (!m.newT) continue;
			const oldSteps = m.oldT.steps.map((s) => norm(s.text)).join("|");
			const newSteps = m.newT.steps.map((s) => norm(s.text)).join("|");
			const same = norm(m.oldT.title) === norm(m.newT.title) && oldSteps === newSteps;
			if (same) {
				retained++;
				taskClasses[m.newT.id] = "retained";
			} else {
				modified++;
				taskClasses[m.newT.id] = "modified";
			}
			// Step-level replacement: same step id, materially different text/signal.
			for (const ns of m.newT.steps) {
				const os = m.oldT.steps.find((s) => s.id === ns.id);
				if (!os) continue;
				const textChanged = norm(os.text) !== norm(ns.text);
				const signalChanged = (os.signal ?? "") !== (ns.signal ?? "");
				if (textChanged || signalChanged) {
					stepReplacements.push({
						taskId: m.oldT.id,
						stepId: os.id,
						wasText: os.text,
						newText: ns.text,
						...(os.signal ? { wasSignal: os.signal } : {}),
						...(ns.signal ? { newSignal: ns.signal } : {}),
						at: nextAt,
						newTaskId: m.newT.id,
						newStepId: ns.id,
					});
				}
			}
		}
		// Unmatched new tasks are added scope.
		const addedTasks: { id: string; title: string }[] = [];
		next.tasks.forEach((t, idx) => {
			if (!used.has(idx)) {
				taskClasses[t.id] = "added";
				addedTasks.push({ id: t.id, title: t.title });
			}
		});
		transitions.push({
			from: versionOrder[i - 1]!,
			to: versionOrder[i]!,
			retained,
			modified,
			added: next.tasks.length - used.size,
			discarded: matches.filter((m) => !m.newT).length,
			pairs: matches.map((m) => {
				if (!m.newT) return { oldId: m.oldT.id, oldTitle: m.oldT.title, class: "discarded" as const };
				const oldSteps = m.oldT.steps.map((s) => norm(s.text)).join("|");
				const newSteps = m.newT.steps.map((s) => norm(s.text)).join("|");
				const same = norm(m.oldT.title) === norm(m.newT.title) && oldSteps === newSteps;
				return { oldId: m.oldT.id, oldTitle: m.oldT.title, newId: m.newT.id, newTitle: m.newT.title, class: (same ? "retained" : "modified") as "retained" | "modified" };
			}),
			addedTasks,
		});
	}
	const evolution: ReportEvolution = { transitions, taskClasses, stepReplacements };

	// ---------- Lifecycle enrichment of the board ----------
	for (const task of board.tasks) {
		const tl = taskLife.get(task.id);
		if (tl?.startedAt !== undefined) {
			task.startedAt = tl.startedAt;
			if (tl.endedAt !== undefined) {
				task.endedAt = tl.endedAt;
				task.durationMs = tl.endedAt - tl.startedAt;
			}
		}
		const created = createdTasks.get(task.id);
		if (created) task.planId = created.planId;
		if (taskClasses[task.id]) task.evolutionClass = taskClasses[task.id];
		for (const step of task.steps) {
			const sl = stepLife.get(`${task.id}/${step.id}`);
			if (sl?.startedAt !== undefined) {
				step.startedAt = sl.startedAt;
				if (sl.endedAt !== undefined) {
					step.endedAt = sl.endedAt;
					step.durationMs = sl.endedAt - sl.startedAt;
				}
			}
			step.toolRuns = step.evidence.length;
			const repl = stepReplacements.find((r) => r.newTaskId === task.id && r.newStepId === step.id);
			if (repl) step.replacedFrom = { text: repl.wasText, ...(repl.wasSignal ? { signal: repl.wasSignal } : {}) };
		}
	}

	// Divergence episodes: harness-recorded off-plan work. The episode window
	// runs creation→close; every write/run finish inside it is off-plan by
	// construction (the first on-plan call closes the episode), except that
	// closing call itself — the window's last write when the episode is done.
	const divEvents = events.filter((e) => e.type === "task.created" && e.task.origin === "divergence" && inScope(e));
	const divergence: DivergenceEpisode[] = [];
	for (const created of divEvents) {
		if (created.type !== "task.created") continue;
		const id = created.task.id;
		const lifespan = events.filter((e) => e.type === "task.updated" && e.id === id);
		const closed = lifespan.find((e) => e.type === "task.updated" && e.to === "done");
		const endSeq = closed?.seq;
		const endAt = closed?.at;
		const finishes = events.filter(
			(e): e is Extract<SessionEvent, { type: "tool.finished" }> =>
				e.type === "tool.finished" && e.runId === created.runId && e.seq > created.seq && (endSeq === undefined || e.seq < endSeq) &&
				!TASK_TOOL_SET_LOCAL.has(e.name) && e.name !== "log_slice",
		);
		const writes = finishes.filter((e) => {
			const req = callTable.get(e.callId);
			const input = req?.input ?? {};
			if (callIsReadOnly(e.name, input)) return false;
			return DIVERGENCE_WRITE_TOOLS.has(e.name);
		});
		// A closed episode's last write is the on-plan call that ended it.
		const offplan = closed ? writes.slice(0, -1) : writes;
		// Attribution: harness-caused when a harness intervention immediately
		// precedes the episode — refusals the model was recovering from, loop
		// verdicts, compaction forcing re-reads. Otherwise the model wandered
		// on its own. Harness-caused is our backlog; model-caused is the
		// model-quality signal.
		const prior = events.filter((e) => e.runId === created.runId && e.seq < created.seq);
		let cause: "harness" | "model" = "model";
		let causeDetail: string | undefined;
		const near = (n: number) => prior.filter((e) => e.seq >= created.seq - n);
		const refusal = near(8).reverse().find((e) => e.type === "tool.finished" && !e.ok && /Refused by|waiting on|has open steps|needs a passing acceptance/.test(e.output ?? ""));
		const verdict = near(12).reverse().find((e) => e.type === "loop.verdict" && e.level !== "none");
		const recap = near(6).reverse().find((e) => e.type === "context.recap");
		const trigger = [refusal, verdict, recap].filter(Boolean).sort((a, b) => (b?.seq ?? 0) - (a?.seq ?? 0))[0];
		if (trigger) {
			cause = "harness";
			causeDetail =
				trigger.type === "tool.finished"
					? `after refusal: ${clip(trigger.output ?? "").slice(0, 90)}`
					: trigger.type === "loop.verdict"
						? `after loop control ${trigger.level}`
						: "after compaction recap";
		}
		const lifecycle = [{ at: created.at, label: "divergence detected — episode opened" }];
		if (offplan.length) lifecycle.push({ at: events.find((e) => e.seq === offplan[0]!.seq)?.at ?? created.at, label: `first off-plan call — ${offplan[0]!.name}` });
		if (closed && endAt !== undefined) lifecycle.push({ at: endAt, label: "returned to plan — episode closed" });
		divergence.push({
			id,
			title: created.task.title,
			kind: "unplanned-work",
			lifecycle,
			status: closed ? "done" : "in_progress",
			startedAt: created.at,
			...(endAt !== undefined ? { endedAt: endAt } : {}),
			calls: offplan.map((e) => ({ seq: e.seq, name: e.name, target: targetOf(callTable.get(e.callId)?.input ?? {}).slice(0, 80), ok: e.ok })),
			cause,
			...(causeDetail ? { causeDetail } : {}),
		});
	}

	// Plan-evolution divergences: step replacements and added scope. These are
	// model-initiated by construction — the model rewrote the plan — but unlike
	// unplanned work they went through the front door (task_replace), so the
	// harness accepted them; the record is for visibility, not friction.
	for (const repl of stepReplacements) {
		if (!inScope({ runId: createdTasks.get(repl.newTaskId)?.runId ?? "" } as SessionEvent)) continue;
		const stepKey = `${repl.newTaskId}/${repl.newStepId}`;
		const sl = stepLife.get(stepKey);
		const lifecycle = [{ at: repl.at, label: `step replacement registered — plan rewritten` }];
		if (sl?.startedAt !== undefined) lifecycle.push({ at: sl.startedAt, label: "new step executed" });
		if (sl?.endedAt !== undefined) lifecycle.push({ at: sl.endedAt, label: "completion accepted" });
		divergence.push({
			id: `${repl.newTaskId}/${repl.newStepId}`,
			title: `${repl.taskId}/${repl.stepId} — implementation approach changed`,
			kind: "step-replaced",
			lifecycle,
			status: sl?.endedAt !== undefined ? "done" : "in_progress",
			startedAt: repl.at,
			...(sl?.endedAt !== undefined ? { endedAt: sl.endedAt } : {}),
			calls: [],
			replacement: { wasText: repl.wasText, newText: repl.newText, ...(repl.wasSignal ? { wasSignal: repl.wasSignal } : {}), ...(repl.newSignal ? { newSignal: repl.newSignal } : {}), taskId: repl.newTaskId, stepId: repl.newStepId },
		});
	}
	for (const [taskId, cls] of Object.entries(taskClasses)) {
		if (cls !== "added") continue;
		const created = createdTasks.get(taskId);
		if (!created || (scoped !== undefined && created.runId !== scoped)) continue;
		// Tasks minted by a wholesale task_replace are the new plan itself — the
		// evolution flow shows them. Divergence is scope the model added piecemeal.
		if (created.viaTool === "task_replace") continue;
		const tl = taskLife.get(taskId);
		const lifecycle = [{ at: created.at, label: "added scope registered — beyond the original plan" }];
		if (tl?.startedAt !== undefined) lifecycle.push({ at: tl.startedAt, label: "work started" });
		if (tl?.endedAt !== undefined) lifecycle.push({ at: tl.endedAt, label: "completion accepted" });
		divergence.push({
			id: taskId,
			title: created.task.title,
			kind: "task-added",
			lifecycle,
			status: tl?.endedAt !== undefined ? "done" : createdTasks.get(taskId)?.task.status === "done" ? "done" : "in_progress",
			startedAt: created.at,
			...(tl?.endedAt !== undefined ? { endedAt: tl.endedAt } : {}),
			calls: [],
		});
	}
	divergence.sort((a, b) => a.startedAt - b.startedAt);
	const divergenceSummary = {
		episodes: divergence.length,
		harnessCaused: divergence.filter((d) => d.cause === "harness").length,
		modelCaused: divergence.filter((d) => d.cause === "model").length,
		calls: divergence.reduce((n, d) => n + d.calls.length, 0),
	};

	// Attach actor action logs.
	for (const task of board.tasks) {
		const acts = taskActions.get(task.id);
		if (acts?.length) task.actions = acts;
		for (const step of task.steps) {
			const sActs = stepActions.get(`${task.id}/${step.id}`);
			if (sActs?.length) step.actions = sActs;
		}
	}

	const artifacts: ReportArtifact[] = [...artifactMap.entries()]
		.map(([path, a]) => ({ path, tools: [...a.tools].sort(), writes: a.writes, firstAt: a.firstAt, lastAt: a.lastAt }))
		.sort((a, b) => b.writes - a.writes || a.path.localeCompare(b.path));

	const allTasks = board.tasks.filter((t) => t.origin !== "divergence");
	const allSteps = allTasks.flatMap((t) => t.steps);
	const startedAt = runs.size ? Math.min(...[...runs.values()].map((r) => r.startedAt)) : 0;
	const endedAt = runs.size ? Math.max(...[...runs.values()].map((r) => r.endedAt)) : 0;
	const summary = {
		planVersions: plans.length,
		tasks: {
			total: allTasks.length,
			completed: allTasks.filter((t) => t.status === "done").length,
			changed: allTasks.filter((t) => t.status === "stale" || t.evolutionClass === "modified").length,
		},
		steps: {
			total: allSteps.length,
			completed: allSteps.filter((s) => s.status === "done").length,
			skipped: allSteps.filter((s) => {
				if (s.status === "blocked") return true;
				// Acceptance-covered: the task closed done with this step never run.
				const parent = allTasks.find((t) => t.steps.includes(s));
				return s.status === "pending" && parent?.status === "done";
			}).length,
			replaced: stepReplacements.length,
		},
		toolRuns: { total: context.toolCalls, succeeded: context.toolCalls - context.toolFailures, retried: retriedRuns },
		divergences: {
			total: divergence.length,
			unplanned: divergence.filter((d) => d.kind === "unplanned-work").length,
			stepReplaced: divergence.filter((d) => d.kind === "step-replaced").length,
			taskAdded: divergence.filter((d) => d.kind === "task-added").length,
		},
		startedAt,
		endedAt,
		durationMs: endedAt - startedAt,
	};

	return {
		generatedAt: (opts.now ?? Date.now)(),
		runs: [...runs.values()],
		board,
		divergence,
		divergenceSummary,
		plans,
		evolution,
		timeline,
		timelineOmitted: Math.max(0, timelineSeen - TIMELINE_CAP),
		turns: turnDetails,
		executions,
		events: rawEvents,
		eventsOmitted: rawOmitted,
		artifacts,
		summary,
		interventions,
		interventionsOmitted: Math.max(0, interventionsSeen - REPORT_INTERVENTION_CAP),
		context,
		execution: {
			...execution,
			tools: [...toolStats.entries()]
				.map(([name, s]) => ({ name, ...s }))
				.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
		},
	};
}

// ---------- Cross-run analytics ----------

export interface HarnessAnalytics {
	runs: number;
	/** Per-run rows for the trend table. */
	perRun: {
		session?: string;
		runId?: string;
		durationMs?: number;
		divergences: { total: number; harness: number; model: number };
		failedCloses: number;
		planVersions: number;
		repeatReads: number;
	}[];
	/** Divergence rollup across all runs. */
	divergences: { total: number; harnessCaused: number; modelCaused: number; byKind: Record<string, number> };
	/** Harness-friction backlog — normalized failure/steering reasons ranked by frequency. */
	friction: { reason: string; count: number; example?: string }[];
	/** Steering rules fired, ranked — each firing is a place the harness had to correct the model. */
	steering: { rule: string; count: number }[];
	/** Loop verdicts by reason kind. */
	loopVerdicts: Record<string, number>;
	/** Most re-read files across runs — thrash signal. */
	repeatReads: { path: string; reads: number }[];
	/** Plan churn. */
	churn: { avgVersions: number; runsWithReplacements: number; stepReplacements: number };
}

/** Normalize a close-failure error into a stable bucket — the harness-improvement backlog key. */
function frictionBucket(error: string): string {
	if (/waiting on/.test(error)) return "dependency gate — close attempted while task waits on another";
	if (/step\.grounding/.test(error)) return "grounding refusal — no proving call in evidence window";
	if (/closed? steps?/i.test(error) || /close.*step/i.test(error)) return "step-close ordering violation";
	if (/not in_progress|not open/i.test(error)) return "close attempted on non-open step";
	return error.slice(0, 90);
}

/**
 * Aggregates built harness reports across runs — the cross-run improvement view.
 * Pure over reports, so the vscode panel (local logs) and the web dashboard
 * (uploaded reports) share the exact same computation.
 */
export function buildHarnessAnalytics(reports: { report: HarnessReport; session?: string; runId?: string }[]): HarnessAnalytics {
	const out: HarnessAnalytics = {
		runs: reports.length,
		perRun: [],
		divergences: { total: 0, harnessCaused: 0, modelCaused: 0, byKind: {} },
		friction: [],
		steering: [],
		loopVerdicts: {},
		repeatReads: [],
		churn: { avgVersions: 0, runsWithReplacements: 0, stepReplacements: 0 },
	};
	const frictionCounts = new Map<string, { count: number; example?: string }>();
	const steeringCounts = new Map<string, number>();
	const readCounts = new Map<string, number>();
	let versionsSum = 0;

	for (const { report, session, runId } of reports) {
		// divergences
		const divs = report.divergence ?? [];
		const harness = divs.filter((d) => d.cause === "harness").length;
		const model = divs.filter((d) => d.cause === "model").length;
		out.divergences.total += divs.length;
		out.divergences.harnessCaused += harness;
		out.divergences.modelCaused += model;
		for (const d of divs) out.divergences.byKind[d.kind] = (out.divergences.byKind[d.kind] ?? 0) + 1;

		// close-out friction — failed close attempts across all steps
		let failedCloses = 0;
		for (const task of report.board.tasks) {
			for (const step of task.steps) {
				for (const r of step.runs ?? []) {
					if (r.role === "close" && !r.ok && r.error) {
						failedCloses++;
						const bucket = frictionBucket(r.error);
						const row = frictionCounts.get(bucket) ?? { count: 0 };
						row.count++;
						row.example ??= r.error.slice(0, 200);
						frictionCounts.set(bucket, row);
					}
				}
			}
		}

		// steering rules + loop verdicts from interventions
		for (const iv of report.interventions ?? []) {
			if (iv.kind === "steer") steeringCounts.set(iv.label, (steeringCounts.get(iv.label) ?? 0) + 1);
			if (iv.kind === "loop") {
				const reason = iv.detail?.split("\n")[0]?.trim() || "unknown";
				out.loopVerdicts[reason] = (out.loopVerdicts[reason] ?? 0) + 1;
			}
		}

		// repeat reads — same file read repeatedly within the run
		const fileReads = new Map<string, number>();
		for (const ex of report.executions ?? []) {
			if (ex.tool === "read_file" || ex.tool === "read_files") {
				for (const p of ex.target.split(",").map((x) => x.trim()).filter(Boolean)) {
					fileReads.set(p, (fileReads.get(p) ?? 0) + 1);
					readCounts.set(p, (readCounts.get(p) ?? 0) + 1);
				}
			}
		}
		const repeatReads = [...fileReads.values()].filter((n) => n >= 4).reduce((a, b) => a + b, 0);

		// churn
		const versions = report.summary?.planVersions ?? report.plans?.length ?? 1;
		versionsSum += versions;
		const replacements = report.evolution?.stepReplacements?.length ?? 0;
		if (replacements) out.churn.runsWithReplacements++;
		out.churn.stepReplacements += replacements;

		out.perRun.push({
			...(session ? { session } : {}),
			...(runId ? { runId } : {}),
			...(report.summary?.durationMs !== undefined ? { durationMs: report.summary.durationMs } : {}),
			divergences: { total: divs.length, harness, model },
			failedCloses,
			planVersions: versions,
			repeatReads,
		});
	}

	out.friction = [...frictionCounts.entries()]
		.map(([reason, row]) => ({ reason, count: row.count, ...(row.example ? { example: row.example } : {}) }))
		.sort((a, b) => b.count - a.count);
	out.steering = [...steeringCounts.entries()].map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count);
	out.repeatReads = [...readCounts.entries()]
		.filter(([, n]) => n >= 6)
		.map(([path, reads]) => ({ path, reads }))
		.sort((a, b) => b.reads - a.reads)
		.slice(0, 15);
	out.churn.avgVersions = reports.length ? versionsSum / reports.length : 0;
	out.perRun.sort((a, b) => (a.session ?? "").localeCompare(b.session ?? ""));
	return out;
}
