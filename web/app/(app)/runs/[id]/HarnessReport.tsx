"use client";

import Link from "next/link";

/**
 * Harness report section on /runs/[id] — uploaded by the IDE after a harness
 * run finishes (POST /api/harness-reports). Mirrors src/harness/report.ts.
 */

export interface ActorAction {
	at: number;
	actor: string;
	label: string;
	detail?: string;
}

export interface ReportStep {
	id: string;
	text: string;
	status: string;
	signal?: { tool: string; path?: string };
	evidence: string[];
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	closedBy?: string;
	toolRuns?: number;
	replacedFrom?: { text: string; signal?: string };
	actions?: ActorAction[];
	runs?: { callId: string; seq: number; at: number; tool: string; target: string; ok: boolean; durationMs?: number; role?: string; error?: string; input?: string; output?: string }[];
}

export interface ReportTask {
	id: string;
	title: string;
	status: string;
	origin?: string;
	acceptance: { kind: string; command?: string; rubric?: string };
	dependsOn: string[];
	steps: ReportStep[];
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	evolutionClass?: string;
	actions?: ActorAction[];
}

export interface PlanVersion {
	id: string;
	createdAt: number;
	label: string;
	taskCount: number;
	stepCount: number;
	status: string;
}

export interface DivergenceEpisode {
	id: string;
	kind: string;
	title: string;
	startedAt: number;
	endedAt?: number;
	status: string;
	calls: { name: string; target?: string; ok: boolean }[];
	cause?: string;
	causeDetail?: string;
	lifecycle?: { at: number; label: string }[];
	replacement?: { taskId: string; stepId: string; wasText: string; wasSignal?: string; newText: string; newSignal?: string; at: number };
}

interface Intervention {
	seq: number;
	at: number;
	runId: string;
	kind: string;
	label: string;
	detail?: string;
}

export interface HarnessReport {
	generatedAt: number;
	runs: { runId: string; status?: string; startedAt: number; endedAt: number; turns: number; toolCalls: number; tasksCreated: number; tokensIn: number; tokensOut: number }[];
	board: { tasks: ReportTask[] };
		turns?: {
		turn: number; seq: number; at: number; providerId?: string; modelId?: string; reasoningId?: string; messageId?: string;
		text: string; reasoning?: string; toolCalls: { callId: string; name: string; target: string }[];
		usage?: { input: number; output: number; cached: number };
	}[];
	executions?: {
		callId: string; seq: number; tool: string; target: string; ok: boolean;
		startedAt: number; endedAt: number; durationMs: number; exitCode?: number; cwd?: string;
		input: string; output: string; error?: string;
	}[];
	events?: Record<string, unknown>[];
	eventsOmitted?: number;
	plans?: PlanVersion[];
	evolution?: {
		transitions: {
			from: string; to: string; retained: number; modified: number; added: number; discarded: number;
			pairs?: { oldId: string; oldTitle: string; newId?: string; newTitle?: string; class: string }[];
			addedTasks?: { id: string; title: string }[];
		}[];
		stepReplacements: { taskId: string; stepId: string; wasText: string; newText: string }[];
	};
	divergence?: DivergenceEpisode[];
	timeline?: { seq: number; at: number; kind: string; label: string; detail?: string; ok?: boolean; reasoning?: string; text?: string; input?: string; output?: string; callId?: string }[];
	timelineOmitted?: number;
	artifacts?: { path: string; tools: string[]; writes: number; firstAt: number; lastAt: number }[];
	summary?: {
		planVersions: number;
		tasks: { total: number; completed: number; changed: number };
		steps: { total: number; completed: number; skipped: number; replaced: number };
		toolRuns: { total: number; succeeded: number; retried: number };
		divergences: { total: number; taskAdded: number; stepReplaced: number; unplanned: number };
		durationMs?: number;
	};
	interventions: Intervention[];
	interventionsOmitted: number;
	context: {
		turns: number;
		toolCalls: number;
		toolFailures: number;
		refusals: number;
		tokens: { input: number; output: number; cached: number };
		bySource: { model: number; planner: number; tools: number; recap: number };
		recaps: number;
		clears: number;
		budgetWarnings: number;
	};
	execution: {
		tools: { name: string; calls: number; failures: number }[];
		stepsSignalDone: number;
		stepsCoveredAtCloseout: number;
		readFileCalls: number;
		readFilesCalls: number;
		exploreCalls: number;
		exploreTurns: number;
		maxReadOnlyStreak: number;
	};
}

export function HarnessReportSection({ report, runId }: { report: HarnessReport; runId?: string }) {
	const s = report.summary;
	const tile = (num: string | number, lbl: string) => (
		<div key={lbl} style={{ minWidth: 90 }}>
			<div style={{ fontSize: 15, fontWeight: 700 }}>{num}</div>
			<div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.05em", opacity: 0.6 }}>{lbl}</div>
		</div>
	);
	return (
		<div className="card" style={{ padding: 12, marginBottom: 12 }}>
			<div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
				<b style={{ fontSize: 13 }}>Harness report</b>
				{tile(s?.tasks?.total ?? report.board.tasks.length, "tasks")}
				{tile(s?.steps?.total ?? 0, "steps")}
				{tile(s?.toolRuns?.total ?? report.context.toolCalls, "tool runs")}
				{tile(s?.divergences?.total ?? 0, "divergences")}
				{tile(s?.planVersions ?? 1, "plan versions")}
				{runId && (
					<Link href={`/runs/${runId}/harness`} style={{ marginLeft: "auto", fontSize: 12, color: "#61afef" }}>
						Open full dashboard →
					</Link>
				)}
			</div>
		</div>
	);
}
