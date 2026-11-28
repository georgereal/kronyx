/**
 * Harness-facing Context Manager facade. It owns projection assembly, result
 * capping, board rendering, budget metadata, and invocation manifests behind
 * one injectable object; the kernel still consumes those capabilities through
 * the narrow ContextPolicy seam.
 */

import type { ToolSpec } from "../../harness/core/contracts";
import type { ContextManifestRequest, ProjectedContext } from "../../harness/core/policies/context";
import type { HarnessState, Message } from "../../harness/core/projections";
import type { ContextManifest } from "../contracts/context";
import {
	KEEP_RECENT_MESSAGES,
	buildHarnessContextProjection,
	capResult as capHarnessResult,
	taskBoard as harnessTaskBoard,
	type ProjectionBudget,
} from "./harnessProjection";
import { buildHarnessContextManifest } from "./harnessManifest";

export interface HarnessContextManager {
	readonly budgetTokens: number;
	readonly outputReserveTokens: number;
	readonly keepRecentMessages: number;
	build(state: HarnessState, tools: readonly ToolSpec[], system: string, runId?: string): ProjectedContext;
	capResult(message: Extract<Message, { kind: "tool" }>): Message;
	taskBoard(state: HarnessState, runId?: string): string | undefined;
	manifest(request: ContextManifestRequest): ContextManifest;
}

export function createHarnessContextManager(budget: ProjectionBudget): HarnessContextManager {
	return {
		budgetTokens: budget.inputTokens,
		outputReserveTokens: budget.outputReserveTokens,
		keepRecentMessages: KEEP_RECENT_MESSAGES,
		build: (state, tools, system, runId) => buildHarnessContextProjection(state, tools, system, runId, budget),
		capResult: (message) => capHarnessResult(message),
		taskBoard: harnessTaskBoard,
		manifest: buildHarnessContextManifest,
	};
}
