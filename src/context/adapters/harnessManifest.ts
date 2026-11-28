import type { ContextComponentType, ContextManifest } from "../contracts/context";
import { countJsonTokens, countTokens } from "../budget/tokenCounter";
import { zeroComponentVersions } from "../contracts/execution";
import type { ContextManifestRequest } from "../../harness/core/policies/context";
import type { StrategyCtx } from "../../harness/core/policies/requestStrategy";
import type { HarnessState, Message } from "../../harness/core/projections";
import { hashText } from "../../harness/core/canonical";
import { PRESSURE_SHARE, WRITE_TOOLS, countMessagesTokens, executionStateNote, inferHarnessPurpose, taskBoard } from "./harnessProjection";

export { inferHarnessPurpose };

function messageTokens(messages: readonly Message[]): { total: number; toolIds: string[]; boardTokens: number; omissionRefs: string[] } {
	const total = countMessagesTokens(messages);
	const toolIds: string[] = [];
	const omissionRefs: string[] = [];
	let boardTokens = 0;
	for (const message of messages) {
		if (message.kind === "tool") {
			toolIds.push(message.callId);
			if (/chars elided|tool result digest|tool result elided|superseded tool result/.test(message.output)) omissionRefs.push(`execution://tool/${encodeURIComponent(message.callId)}/full-output`);
		} else if (message.kind === "system" && message.text.startsWith("Task board:")) {
			boardTokens += countTokens(message.text) + 4;
		}
	}
	return { total, toolIds, boardTokens, omissionRefs };
}

const numericHash = (text: string): number => (text ? parseInt(hashText(text).slice(0, 8), 16) : 0);

/**
 * Component versions as change cursors: the seq at which the component last
 * changed, or a content hash where no cursor exists. They are honest equality
 * indicators for cross-manifest diffing — never synthetic counters.
 */
function harnessComponentVersions(state: HarnessState, board: string | undefined) {
	const versions = zeroComponentVersions();
	const toolSeqs = state.messages.filter((m) => m.kind === "tool").map((m) => (m as Extract<Message, { kind: "tool" }>).seq);
	versions.toolResultVersion = toolSeqs.at(-1) ?? 0;
	versions.validationVersion = state.verdicts.at(-1)?.seq ?? 0;
	versions.compactionVersion = state.compactions.length + (state.recap ? 1 : 0);
	versions.planVersion = numericHash(board ?? "");
	versions.taskSummaryVersion = state.recap ? state.recap.covers : 0;
	const inputs = new Map<string, unknown>();
	for (const m of state.messages) {
		if (m.kind !== "assistant") continue;
		for (const call of m.toolCalls) if (!inputs.has(call.callId)) inputs.set(call.callId, call.input);
	}
	const writes = state.messages.filter((m): m is Extract<Message, { kind: "tool" }> => m.kind === "tool" && m.ok && WRITE_TOOLS.test(m.name));
	versions.fileChangeVersion = writes.at(-1)?.seq ?? 0;
	return versions;
}

/** Builds the per-invocation observability manifest from the exact harness messages selected for the wire. */
export function buildHarnessContextManifest(request: ContextManifestRequest): ContextManifest {
	const counted = messageTokens(request.messages);
	const systemTokens = countTokens(request.system);
	const toolSchemaTokens = countJsonTokens(request.tools);
	const wireInput = counted.total + systemTokens + toolSchemaTokens;
	const outputReserve = request.outputReserveTokens ?? 8_000;
	const note = executionStateNote(request.state);
	const noteTokens = note ? countTokens(note) + 4 : 0;
	const byComponent: Partial<Record<ContextComponentType, number>> = {
		system_instructions: systemTokens,
		capability_instructions: toolSchemaTokens,
		interaction_tail: Math.max(0, counted.total - counted.boardTokens - noteTokens),
	};
	if (counted.boardTokens) byComponent.active_plan = counted.boardTokens;
	if (noteTokens) byComponent.execution_state = noteTokens;
	const board = taskBoard(request.state, request.runId);
	const componentVersions = harnessComponentVersions(request.state, board);
	const compactionApplied = request.compactionApplied ?? (request.forcedCompaction === true || request.budgetPressure === true);
	const effectiveInput = request.effectiveInputTokens ?? wireInput;
	return {
		schemaVersion: 1,
		invocationId: `inv-${request.runId}-${request.turn}-${request.state.lastSeq + 1}`,
		sessionId: request.sessionId ?? request.runId,
		runId: request.runId,
		turn: request.turn,
		purpose: request.purpose ?? inferHarnessPurpose(request.state),
		providerId: request.providerId ?? "unknown",
		modelId: request.modelId ?? "unknown",
		payloadMode: request.payloadMode,
		contextVersion: Math.max(1, request.state.lastSeq),
		componentVersions,
		includedEvents: request.state.lastSeq ? [`execution://seq/1-${request.state.lastSeq}`] : [],
		includedToolResults: counted.toolIds,
		retrievedRepositoryItems: [],
		compactionApplied,
		compactionAuthority: request.compactionAuthority ?? (compactionApplied ? "local" : "none"),
		compactionRecords: request.state.compactions.map((c) => c.compactionId).filter(Boolean),
		inputTokenCount: effectiveInput,
		effectiveInputTokenCount: effectiveInput,
		wireInputTokenCount: wireInput,
		tokenBreakdown: {
			totalInput: effectiveInput,
			effectiveInput,
			wireInput,
			outputReserve,
			byComponent,
			estimationMethod: "tokenizer",
		},
		outputTokenReservation: outputReserve,
		estimationMethod: "tokenizer",
		omittedContent: [
			...counted.omissionRefs.map((reference) => ({ reference, reason: "full output retained in ledger; compact representation included" })),
			...(request.overBudget
				? [{ reference: `execution://invocation/inv-${request.runId}-${request.turn}`, reason: `critical budget violation: input exceeds the usable budget even at reduction level ${request.reductionLevel ?? 0}; fixed instructions and paired tool state cannot be reduced further` }]
				: []),
			...(request.reductionLevel
				? [{ reference: `execution://invocation/inv-${request.runId}-${request.turn}-reduction`, reason: `priority reduction level ${request.reductionLevel} applied: older evidence collapsed to recovery pointers` }]
				: []),
		],
		truncationApplied: counted.omissionRefs.length > 0 || request.overBudget === true,
		createdAt: new Date().toISOString(),
	};
}

/** Strategy glue: ask the injected context policy/manager for the manifest, then append it as a durable event. */
export async function emitHarnessContextManifest(
	ctx: StrategyCtx,
	messages: readonly Message[],
	payloadMode: ContextManifestRequest["payloadMode"],
	opts: { compactionApplied?: boolean; compactionAuthority?: "local" | "provider" | "none"; purpose?: ContextManifestRequest["purpose"]; reductionLevel?: number; overBudget?: boolean } = {},
): Promise<ContextManifest> {
	// Token accounting uses the same measuring stick as budget enforcement.
	// For conversation deltas the wire payload is only the unsynced tail, while
	// the effective context is the full projected state the server-side
	// conversation is supposed to represent — measured honestly, never equated.
	const wireTokens = countMessagesTokens(messages) + countTokens(ctx.system) + countJsonTokens(ctx.tools);
	let effectiveInputTokens = wireTokens;
	if (payloadMode === "conversation-delta") {
		const full = ctx.behavior.context.build(ctx.state, ctx.offered, ctx.system, ctx.runId);
		effectiveInputTokens = full.estimatedInputTokens ?? wireTokens;
	}
	const budgetPressure = wireTokens >= ctx.behavior.context.budgetTokens * PRESSURE_SHARE;
	const request: ContextManifestRequest = {
		state: ctx.state,
		tools: ctx.tools,
		system: ctx.system,
		turn: ctx.turn,
		runId: ctx.runId,
		...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
		messages,
		payloadMode,
		...(opts.purpose ? { purpose: opts.purpose } : {}),
		...(ctx.model.identity?.providerId ? { providerId: ctx.model.identity.providerId } : {}),
		...(ctx.model.identity?.modelId ? { modelId: ctx.model.identity.modelId } : {}),
		...(opts.compactionApplied !== undefined ? { compactionApplied: opts.compactionApplied } : {}),
		...(opts.compactionAuthority ? { compactionAuthority: opts.compactionAuthority } : {}),
		outputReserveTokens: ctx.behavior.context.outputReserveTokens,
		effectiveInputTokens,
		...(opts.reductionLevel ? { reductionLevel: opts.reductionLevel } : {}),
		...(opts.overBudget ? { overBudget: opts.overBudget } : {}),
		budgetPressure,
		forcedCompaction: ctx.recap.forced,
	};
	const manifest = ctx.behavior.context.manifest ? await ctx.behavior.context.manifest(request) : buildHarnessContextManifest(request);
	await ctx.emit({ type: "context.manifest", manifest });
	return manifest;
}
