/**
 * Stateless request strategy (vscode-free): the default request lifecycle.
 * Every turn replays the full projection — recap first, then the context
 * policy's projection — so any provider works without server-side state.
 */

import type { RequestStrategy, StrategyCtx, RequestTurn } from "../core/policies/requestStrategy";
import { emitHarnessContextManifest } from "../../context/adapters/harnessManifest";

export class StatelessStrategy implements RequestStrategy {
	async call(ctx: StrategyCtx): Promise<RequestTurn> {
		// Measure the pre-compaction projection: utilization pressure is the real
		// token cost of the next invocation, not a chars heuristic or a provider
		// usage field some transports never report. When no recap is emitted the
		// measurement build is reused unchanged — one projection per turn.
		const measured = ctx.behavior.context.build(ctx.state, ctx.offered, ctx.system, ctx.runId);
		const recapBefore = ctx.state.recap;
		await ctx.behavior.recap.maybeRecap({
			model: ctx.model,
			emit: ctx.emit,
			state: ctx.state,
			runId: ctx.runId,
			signal: ctx.signal,
			lastInputTokens: measured.unreducedInputTokens ?? measured.estimatedInputTokens ?? 0,
			taskDone: ctx.recap.taskDone,
			forced: ctx.recap.forced,
			context: ctx.behavior.context,
			onModelRequest: async (request) => {
				await emitHarnessContextManifest(ctx, request.messages, "full", { purpose: "general", compactionApplied: true, compactionAuthority: "local" });
			},
		});
		const context = ctx.state.recap === recapBefore ? measured : ctx.behavior.context.build(ctx.state, ctx.offered, ctx.system, ctx.runId);
		await emitHarnessContextManifest(ctx, context.messages, "full", {
		...(context.reductionLevel ? { reductionLevel: context.reductionLevel } : {}),
		...(context.overBudget ? { overBudget: context.overBudget } : {}),
	});
		const response = await ctx.complete({
			turn: ctx.turn,
			system: context.system,
			messages: context.messages,
			ledger: ctx.state.ledger,
			tools: ctx.tools,
			signal: ctx.signal,
			onReasoningDelta: ctx.onReasoningDelta,
			onTextDelta: ctx.onTextDelta,
		});
		return { response };
	}
}

/** Shared instance — the strategy is stateless itself. */
export const statelessStrategy = new StatelessStrategy();
