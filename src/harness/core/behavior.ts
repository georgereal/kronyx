/**
 * Harness behavior (vscode-free): the narrow policy seams a provider/model
 * profile may override, plus the default composition. Common features stay in
 * `defaults/`; a profile overrides only what diverges. The kernel keeps all
 * invariants — policies return normalized proposals/verdicts only.
 */

import type { ContextPolicy } from "./policies/context";
import type { RecapPolicy } from "./policies/recap";
import type { PlanningPolicy } from "./policies/planning";
import type { LoopControlPolicy } from "./policies/loopControl";
import type { SteeringPolicy } from "./policies/steering";
import type { RecallProvider } from "./policies/recall";
import type { EvidencePolicy } from "./policies/evidence";
import { defaultContextPolicy } from "../defaults/context";
import { defaultRecapPolicy } from "../defaults/recap";
import { defaultPlanningPolicy } from "../defaults/planning";
import { defaultLoopControlPolicy } from "../defaults/loopControl";
import { defaultSteeringPolicy } from "../defaults/steering";
import { defaultEvidencePolicy } from "../defaults/evidence";

export interface HarnessBehavior {
	context: ContextPolicy;
	recap: RecapPolicy;
	planner: PlanningPolicy;
	loopControl: LoopControlPolicy;
	steering: SteeringPolicy;
	/** Step-evidence rules: model-facing step spec + which calls prove a done step. */
	evidence: EvidencePolicy;
	/** Optional model-aware recall ranking; the tool wrapper stays common. */
	recall?: RecallProvider;
}

/** Every stage defaults to today's behavior. */
export function defaultBehavior(): HarnessBehavior {
	return {
		context: defaultContextPolicy,
		recap: defaultRecapPolicy,
		planner: defaultPlanningPolicy,
		loopControl: defaultLoopControlPolicy,
		steering: defaultSteeringPolicy,
		evidence: defaultEvidencePolicy,
	};
}
