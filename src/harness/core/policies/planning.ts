/**
 * Planning policy (vscode-free). One model call at run start proposes the board.
 * The kernel still remaps ids, validates dependencies/signals/read-only
 * constraints, and emits the ledger events — a policy returns a normalized
 * proposal only.
 */

import type { ModelPort, Task, Usage } from "../contracts";

export interface PlanResult {
	tasks: Task[];
	/** Ids of prior-run tasks this run adopts and continues. */
	continueIds: string[];
	/** Saved-plan slug the planner says already answers the task. */
	reusePlan?: string;
	/** The planner call failed or returned no usable plan — the board is a
	 * placeholder the model should replace with its real plan. */
	fallback?: boolean;
	usage?: Usage;
}

export interface PlanningPolicy {
	plan(
		model: ModelPort,
		taskText: string,
		opts: { writable: boolean; board?: string; plans?: string[]; signal?: AbortSignal },
	): Promise<PlanResult>;
}
