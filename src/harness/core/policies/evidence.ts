/**
 * Evidence policy (vscode-free). Owns the two ends of step proof: what the
 * model-facing `task_step_update` spec exposes, and which calls get attached
 * as proof when a step is marked done. Tracking rules differ per transport —
 * Responses-family models see provider call ids, Cline's are harness-generated
 * the model never sees — so the default is harness-side attachment only. The
 * kernel invariant (a done step lands with resolved callIds on the durable
 * `step.updated` event) never moves.
 */

import type { HarnessState } from "../projections";
import type { ToolCall, ToolSpec } from "../contracts";

export interface EvidencePolicy {
	/** The model-facing `task_step_update` spec. */
	stepTool(): ToolSpec;
	/** Resolves proving-call ids onto a step update before ledger validation. `ignoreCited` drops any model-supplied ids — used on transports where the model's ids can never be authoritative. */
	attach(call: ToolCall, state: HarnessState, opts?: { ignoreCited?: boolean }): ToolCall;
}
