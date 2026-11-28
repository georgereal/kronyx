/** Execution-state snapshot derivation for harness event logs. */

import type { SessionEvent } from "../../harness/core/contracts";
import { canonicalJson, hashText } from "../../harness/core/canonical";
import { projectHarnessExecutionState } from "../state/projectHarness";
import type { ExecutionState } from "../contracts/execution";

export interface HarnessExecutionStateSnapshot {
	state: ExecutionState;
	stateVersion: number;
	eventCursor: number;
	stateHash: string;
}

/** Projects the whole session log. runId is metadata only; snapshots intentionally include prior runs in the same session. */
export function snapshotHarnessExecutionState(events: readonly SessionEvent[], sessionId: string, runId?: string): HarnessExecutionStateSnapshot {
	const state = projectHarnessExecutionState(events, sessionId, runId);
	return {
		state,
		stateVersion: state.stateVersion,
		eventCursor: state.eventCursor,
		stateHash: hashText(canonicalJson(state)),
	};
}
