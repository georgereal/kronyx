/**
 * Default evidence policy (vscode-free). The model-facing `task_step_update`
 * spec omits `callIds` entirely — evidence ids are harness-internal and never
 * leave the harness in either direction. On `status: done` the harness
 * attaches every successful external call since the task's proof window
 * opened (`startedSeq`), so the model marks steps done without citing ids.
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
		return { ...call, input: { ...input, callIds: settledCalls(state, task?.startedSeq ?? 0).map((s) => s.call.callId) } };
	},
};
