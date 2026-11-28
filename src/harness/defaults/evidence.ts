/**
 * Default evidence policy (vscode-free). The model-facing `task_step_update`
 * spec omits `callIds` entirely — evidence ids are harness-internal and never
 * leave the harness in either direction. On `status: done` the harness
 * attaches the successful external calls since the step's own window opened
 * (the previous sibling's close, or the task start) — degrading to the
 * task-wide window when the work pre-dates a batch close.
 */

import { LOG_SLICE } from "./context";
import { TASK_TOOLS, TASK_TOOL_NAMES, TASK_TOOL_SET } from "../core/taskLedger";
import type { EvidencePolicy } from "../core/policies/evidence";
import type { HarnessState } from "../core/projections";
import type { ToolCall, ToolSpec } from "../core/contracts";

/** Successful external calls that finished after seq, with their inputs and log seq. A task's steps are proven from the task's start, since the model works ahead of the board. */
export function settledCalls(state: HarnessState, seq: number): Array<{ call: ToolCall; seq: number }> {
	const inputs = new Map(state.messages.flatMap((m) => (m.kind === "assistant" ? m.toolCalls.map((c) => [c.callId, c] as const) : [])));
	return state.messages.flatMap((m) => {
		if (m.kind !== "tool" || !m.ok || m.seq <= seq || TASK_TOOL_SET.has(m.name) || m.name === LOG_SLICE) return [];
		const call = inputs.get(m.callId);
		return call ? [{ call, seq: m.seq }] : [];
	});
}

/**
 * Evidence window for a step: opens at the LATER of the task's start and the
 * close of the last settled sibling step before it. The model works ahead of
 * the board, so a step's proof often lands before the step formally opens —
 * but it never lands before the previous sibling's work ended. Task-start
 * scoping alone attaches the same shared pile of calls to every step.
 */
const stepWindowStart = (state: HarnessState, taskId: string | undefined, stepId: unknown): number => {
	const task = taskId ? state.ledger.tasks[taskId] : undefined;
	if (!task) return 0;
	let start = task.createdSeq ?? task.startedSeq ?? 0;
	const idx = task.steps.findIndex((s) => s.id === stepId);
	const siblings = idx >= 0 ? task.steps.slice(0, idx) : task.steps;
	for (const s of siblings) {
		const closed = (s as { closedSeq?: number }).closedSeq;
		if (typeof closed === "number" && closed > start) start = closed;
	}
	return start;
};

const stepSpec = (): ToolSpec => {
	const spec = TASK_TOOLS.find((t) => t.name === TASK_TOOL_NAMES.stepUpdate);
	if (!spec) throw new Error("task_step_update spec missing");
	return spec;
};

export const defaultEvidencePolicy: EvidencePolicy = {
	stepTool: stepSpec,
	attach(call: ToolCall, state: HarnessState, opts?: { ignoreCited?: boolean }): ToolCall {
		if (call.name !== TASK_TOOL_NAMES.stepUpdate) return call;
		const input = (call.input ?? {}) as { taskId?: unknown; status?: unknown; callIds?: unknown };
		if (input.status !== "done" || (!opts?.ignoreCited && Array.isArray(input.callIds) && input.callIds.length > 0)) return call;
		const task = state.ledger.tasks[String(input.taskId)];
		const windowStart = stepWindowStart(state, String(input.taskId), (input as { stepId?: unknown }).stepId);
		// Tighten to the step's own window when it holds evidence — but a batch
		// close (all the work done, then steps closed in a row) legitimately
		// shares the task-wide pile: the work pre-dates every close, so falling
		// back is correct rather than noise.
		const own = settledCalls(state, windowStart);
		const calls = own.length ? own : settledCalls(state, task?.createdSeq ?? task?.startedSeq ?? 0);
		return { ...call, input: { ...input, callIds: calls.map((s) => s.call.callId) } };
	},
};
