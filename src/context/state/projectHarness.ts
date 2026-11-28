import type { ExecutionState, ExecutionTaskState, FileChangeState, ValidationState } from "../contracts/execution";
import { initialExecutionState } from "./executionState";

export interface HarnessLikeEvent {
	type: string;
	seq: number;
	runId?: string;
	text?: string;
	task?: {
		id: string;
		title: string;
		status: string;
		origin?: string;
		steps?: { id: string; text: string; status: string }[];
	};
	id?: string;
	taskId?: string;
	stepId?: string;
	to?: string;
	status?: string;
	reason?: string;
	callId?: string;
	name?: string;
	input?: unknown;
	ok?: boolean;
	command?: string;
	detail?: string;
	covers?: number;
	at?: number;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined);
const pathFromInput = (input: unknown): string | undefined => {
	const o = asRecord(input);
	if (!o) return undefined;
	for (const key of ["path", "file", "filePath", "rel", "target_file"]) if (typeof o[key] === "string") return o[key];
	return undefined;
};
const isWriteTool = (name: string | undefined): boolean => !!name && /^(write_file|edit_file|append_file|insert_lines|file_editor|apply_patch)/.test(name);

/** Identity key for failure resolution: same tool on the same target. Without a path the tool name alone is the best honest identity. */
const failureKey = (name: string | undefined, input: unknown): string | undefined => {
	if (!name) return undefined;
	const path = pathFromInput(input);
	return path ? `${name}:${path}` : name;
};

function refreshPlanLists(state: ExecutionState): void {
	state.plan.completed = state.plan.tasks.filter((t) => t.status === "done").map((t) => t.id);
	state.plan.inProgress = state.plan.tasks.filter((t) => t.status === "in_progress").map((t) => t.id);
	state.plan.pending = state.plan.tasks.filter((t) => t.status === "pending").map((t) => t.id);
	state.plan.blocked = state.plan.tasks.filter((t) => t.status === "blocked").map((t) => t.id);
	state.plan.version++;
	state.componentVersions.planVersion = state.plan.version;
}

function upsertTask(state: ExecutionState, task: HarnessLikeEvent["task"], seq: number): void {
	if (!task) return;
	const existing = state.plan.tasks.find((t) => t.id === task.id);
	const normalized: ExecutionTaskState = {
		id: task.id,
		title: task.title,
		status: task.status,
		...(task.origin ? { origin: task.origin } : {}),
		steps: (task.steps ?? []).map((s) => ({ id: s.id, text: s.text, status: s.status })),
		startedSeq: task.status === "in_progress" ? seq : undefined,
	};
	if (existing) Object.assign(existing, normalized);
	else state.plan.tasks.push(normalized);
	refreshPlanLists(state);
}

function updateTask(state: ExecutionState, id: string | undefined, to: string | undefined, seq: number): void {
	if (!id || !to) return;
	const task = state.plan.tasks.find((t) => t.id === id);
	if (!task) return;
	task.status = to;
	if (to === "in_progress" && task.startedSeq === undefined) task.startedSeq = seq;
	if (to === "done" || to === "failed") task.closedSeq = seq;
	refreshPlanLists(state);
}

function updateStep(state: ExecutionState, taskId: string | undefined, stepId: string | undefined, to: string | undefined, seq: number): void {
	if (!taskId || !stepId || !to) return;
	const task = state.plan.tasks.find((t) => t.id === taskId);
	const step = task?.steps.find((s) => s.id === stepId);
	if (!task || !step) return;
	step.status = to;
	if (to !== "pending" && task.startedSeq === undefined) task.startedSeq = seq;
	state.componentVersions.planVersion = ++state.plan.version;
}

function recordFileChange(state: ExecutionState, path: string, seq: number): void {
	const existing = state.changes.filesModified.find((f) => f.path === path);
	if (existing) {
		existing.lastSeenSeq = seq;
		existing.stale = false;
	} else {
		const change: FileChangeState = { path, operation: "unknown", firstSeenSeq: seq, lastSeenSeq: seq, evidenceRef: `execution://seq/${seq}` };
		state.changes.filesModified.push(change);
	}
	state.changes.version++;
	state.componentVersions.fileChangeVersion = state.changes.version;
}

function recordValidation(state: ExecutionState, event: HarnessLikeEvent): void {
	const validation: ValidationState = {
		status: event.ok ? "passed" : "failed",
		...(event.command ? { command: event.command } : {}),
		...(event.detail ? { summary: event.detail.slice(0, 500) } : {}),
		evidenceRef: `execution://seq/${event.seq}`,
		updatedSeq: event.seq,
	};
	const command = event.command ?? "";
	if (/test|spec|jest|vitest|pytest|go test|mvn test|gradle test/i.test(command)) state.validation.tests = validation;
	else if (/build|compile|tsc|lint|typecheck/i.test(command)) state.validation.build = validation;
	state.validation.checks.push(validation);
	state.validation.checks = state.validation.checks.slice(-20);
	state.validation.version++;
	state.componentVersions.validationVersion = state.validation.version;
}

/** Derives the canonical structured state from harness-shaped events without importing harness types. */
export function projectHarnessExecutionState(events: readonly HarnessLikeEvent[], sessionId: string, runId?: string): ExecutionState {
	const state = initialExecutionState(sessionId, runId);
	const requested = new Map<string, { name: string; seq: number; input?: unknown }>();
	const issueKeys = new Map<string, string>();
	for (const event of events) {
		if (runId !== undefined && event.runId !== undefined && event.runId !== runId) continue;
		state.eventCursor = Math.max(state.eventCursor, event.seq);
		state.stateVersion++;
		state.updatedAt = new Date(event.at ?? Date.now()).toISOString();
		switch (event.type) {
			case "user.input":
				if (!state.objective && event.text) {
					state.objective = event.text;
					state.constraints.push({ id: "constraint-user-objective", text: event.text, provenance: { type: "user", ref: `execution://seq/${event.seq}`, verification: "observed" }, active: true });
					state.componentVersions.taskSummaryVersion++;
				}
				break;
			case "tool.requested":
				if (event.callId && event.name) requested.set(event.callId, { name: event.name, seq: event.seq, input: event.input });
				break;
			case "tool.finished": {
				const req = event.callId ? requested.get(event.callId) : undefined;
				if (event.callId) requested.delete(event.callId);
				const name = event.name ?? req?.name;
				if (isWriteTool(name)) {
					const path = pathFromInput(req?.input);
					if (path) recordFileChange(state, path, event.seq);
				}
				state.componentVersions.toolResultVersion++;
				const key = failureKey(name, req?.input);
				if (!event.ok && event.name) {
					const id = `issue-${event.seq}`;
					state.openIssues.push({ id, description: `${event.name} failed at seq ${event.seq}`, status: "open", severity: "medium", evidenceRefs: [`execution://seq/${event.seq}`] });
					if (key) issueKeys.set(id, key);
				} else if (event.ok && key) {
					// A later success of the same tool+target resolves the earlier failure — an
					// unresolved-failure list that only grows would cry wolf forever.
					for (const issue of state.openIssues) {
						if (issue.status !== "open") continue;
						const issueKey = issueKeys.get(issue.id);
						if (issueKey === key || issueKey === key.split(":")[0]) issue.status = "resolved";
					}
				}
				break;
			}
			case "task.created":
			case "task.adopted":
				upsertTask(state, event.task, event.seq);
				break;
			case "task.updated":
				updateTask(state, event.id ?? event.taskId, event.to, event.seq);
				break;
			case "step.updated":
				updateStep(state, event.taskId, event.stepId, event.to, event.seq);
				break;
			case "verifier.result":
				recordValidation(state, event);
				break;
			case "context.recap":
			case "context.compaction":
				state.compaction.compactionVersion++;
				state.compaction.lastCompactionCursor = event.seq;
				state.componentVersions.compactionVersion = state.compaction.compactionVersion;
				if (event.covers !== undefined) state.compaction.activeSummaries.push({ ref: `execution://seq/${event.seq}`, coversToSeq: event.covers, version: state.compaction.compactionVersion });
				break;
			case "run.status": {
				const status = event.status ?? event.to;
				if (status === "completed" || status === "failed" || status === "paused" || status === "stopped" || status === "running") state.status = status;
				break;
			}
		}
	}
	state.activeToolCalls = [...requested.entries()].map(([callId, r]) => ({ callId, name: r.name, requestedSeq: r.seq }));
	refreshPlanLists(state);
	state.plan.version = Math.max(1, state.plan.version);
	return state;
}
