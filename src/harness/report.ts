/**
 * Harness report (vscode-free): a bounded, human-readable summary of what the
 * harness did over a session log — the plan it owned, where it intervened,
 * what context it spent, and how the work executed. Built once per run for the
 * IDE panel and the dashboard upload; pure over SessionEvents.
 */

import type { Acceptance, RunStatus, SessionEvent, StepSignal, StepStatus, TaskStatus } from "./contracts";
import type { Task, Step, Usage } from "./contracts";
import { project, reduce, type HarnessState } from "./projections";
import { READ_ONLY_TOOL_NAMES } from "./steering";
import type { Ledger } from "./taskLedger";

export const REPORT_INTERVENTION_CAP = 200;
const TEXT_CAP = 300;

export interface ReportStep {
	id: string;
	text: string;
	status: StepStatus;
	signal?: StepSignal;
	/** Tool-call ids that prove the step (empty when acceptance-covered at close-out). */
	evidence: string[];
}

export interface ReportTask {
	id: string;
	title: string;
	status: TaskStatus;
	acceptance: Acceptance;
	dependsOn: string[];
	steps: ReportStep[];
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
	context: {
		turns: number;
		toolCalls: number;
		toolFailures: number;
		refusals: number;
		tokens: { input: number; output: number; cached: number };
		/** Input-token attribution by what spent them. */
		bySource: { model: number; planner: number; tools: number; recap: number };
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

const clip = (s: string): string => (s.length > TEXT_CAP ? `${s.slice(0, TEXT_CAP)}…` : s);

const taskView = (t: Task): ReportTask => ({
	id: t.id,
	title: t.title,
	status: t.status,
	acceptance: t.acceptance,
	dependsOn: t.dependsOn,
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
		recaps: 0,
		clears: 0,
		budgetWarnings: 0,
	};
	const toolStats = new Map<string, { calls: number; failures: number }>();
	const execution = { stepsSignalDone: 0, stepsCoveredAtCloseout: 0, readFileCalls: 0, readFilesCalls: 0, exploreCalls: 0, exploreTurns: 0, maxReadOnlyStreak: 0 };
	let readOnlyStreak = 0;

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
		state = reduce(state, e);
		lastLedger = state.ledger;
		ledgerByRun.set(e.runId, state.ledger);

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
			}

			switch (e.type) {
				case "model.response": {
					context.turns++;
					run.turns = Math.max(run.turns, e.turn);
					addTokens(e.usage, "model");
					run.tokensIn += e.usage?.inputTokens ?? 0;
					run.tokensOut += e.usage?.outputTokens ?? 0;
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
					break;
				}
				case "task.created":
					run.tasksCreated++;
					addTokens(e.usage, "planner");
					break;
				case "step.updated":
					if (e.to === "done") {
						if (e.callIds.length) execution.stepsSignalDone++;
						else execution.stepsCoveredAtCloseout++;
					}
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
				case "run.status":
					run.status = e.status;
					break;
			}
		}
	}

	const boardLedger = scoped ? (ledgerByRun.get(scoped) ?? lastLedger) : lastLedger;
	return {
		generatedAt: (opts.now ?? Date.now)(),
		runs: [...runs.values()],
		board: boardView(boardLedger),
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
