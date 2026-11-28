/**
 * Shared interaction-history compactor for harness execution. The durable raw
 * transcript remains in the execution ledger; this module creates the compact
 * model-written recap and the CompactionRecord that describes it.
 */

import type { ModelPort, Usage } from "../../harness/core/contracts";
import type { RecapCtx } from "../../harness/core/policies/recap";
import { emptyLedger } from "../../harness/core/taskLedger";
import type { Message } from "../../harness/core/projections";
import type { CompactionRecord } from "../contracts/compaction";
import { PRESSURE_SHARE } from "./harnessProjection";
import { zeroComponentVersions } from "../contracts/execution";

export const RECAP_SYSTEM = [
	"You write a brief for the SAME agent to continue this coding task. It is not a narrative of the transcript.",
	"In at most 300 words of compact prose cover: what was being done and its live state; intentions and next steps;",
	"remaining work and the criteria for completion; files read or changed, with paths; errors and their resolutions;",
	"and pointers to details the agent can recover with log_slice by seq. An earlier recap, if present, comes first and must be kept.",
].join(" ");

const LINE_CAP = 1500;

export function transcriptOf(prior: string | undefined, chunk: readonly Message[]): string {
	const lines = chunk.map((m) => {
		switch (m.kind) {
			case "user":
				return `user (seq ${m.seq}): ${m.text}`;
			case "assistant":
				return `assistant (seq ${m.seq}): ${m.text}${m.toolCalls.length ? ` [calls: ${m.toolCalls.map((c) => c.name).join(", ")}]` : ""}`;
			case "tool":
				return `tool ${m.name} ${m.ok ? "ok" : "failed"} (seq ${m.seq}): ${m.output.slice(0, LINE_CAP)}`;
			case "system":
				return `system: ${m.text}`;
		}
	});
	return [prior ? `Earlier recap:\n${prior}` : "", ...lines].filter(Boolean).join("\n");
}

/** One model call (no tools) that returns the brief. Undefined when the model returns nothing. */
export async function makeRecap(
	model: ModelPort,
	prior: string | undefined,
	chunk: readonly Message[],
	signal?: AbortSignal,
	onRequest?: (request: { system: string; messages: { kind: "user"; text: string; seq: number }[] }) => Promise<void>,
): Promise<{ text: string; usage?: Usage } | undefined> {
	const request = {
		system: RECAP_SYSTEM,
		messages: [{ kind: "user" as const, text: transcriptOf(prior, chunk), seq: 0 }],
	};
	await onRequest?.(request);
	const response = await model.complete({
		turn: 0,
		system: request.system,
		messages: request.messages,
		ledger: emptyLedger(),
		tools: [],
		...(signal ? { signal } : {}),
	});
	const text = response.text.trim();
	return text ? { text, ...(response.usage ? { usage: response.usage } : {}) } : undefined;
}

function harnessComponentVersions(state: RecapCtx["state"]) {
	const versions = zeroComponentVersions();
	versions.planVersion = state.ledger.order.length;
	versions.toolResultVersion = state.messages.filter((m) => m.kind === "tool").length;
	versions.validationVersion = state.verdicts.length;
	versions.compactionVersion = state.compactions.length + (state.recap ? 1 : 0);
	return versions;
}

/**
 * Current trigger logic: manual compact or real context pressure. Task
 * completion alone intentionally does not trigger interaction compaction.
 * Pressure is measured in real tokens against the usable input budget — the
 * caller passes the measured cost of the next invocation, so the trigger does
 * not depend on provider-reported usage being present or accurate.
 * Emits both the model-facing recap event and the durable compaction record.
 */
export async function maybeHarnessRecap(ctx: RecapCtx): Promise<void> {
	const pressured = ctx.lastInputTokens >= ctx.context.budgetTokens * PRESSURE_SHARE;
	if (!ctx.forced && !pressured) return;
	const boundary = Math.max(0, ctx.state.messages.length - ctx.context.keepRecentMessages);
	const covered = ctx.state.recap?.covers ?? 0;
	if (boundary <= covered) return;
	const chunk = ctx.state.messages.slice(covered, boundary);
	let recap: Awaited<ReturnType<typeof makeRecap>>;
	try {
		recap = await makeRecap(ctx.model, ctx.state.recap?.text, chunk, ctx.signal, ctx.onModelRequest);
	} catch (err) {
		await ctx.emit({ type: "steer.note", rule: "context.recap", text: `compaction failed — continuing without it (${err instanceof Error ? err.message : String(err)})` });
		return;
	}
	if (!recap) return;
	const recapSeq = ctx.state.lastSeq + 1;
	await ctx.emit({ type: "context.recap", covers: boundary, text: recap.text, scope: "interaction_history", ...(recap.usage ? { usage: recap.usage } : {}) });
	const seqs = chunk.map((m) => m.seq).filter((seq): seq is number => seq !== undefined);
	const record: CompactionRecord = {
		schemaVersion: 1,
		compactionId: `cmp-${ctx.runId ?? "run"}-${boundary}-${recapSeq}`,
		scope: "interaction_history",
		sourceEventRange: { from: seqs[0] ?? 1, to: seqs.at(-1) ?? Math.max(1, ctx.state.lastSeq) },
		summaryRef: `execution://seq/${recapSeq}`,
		preservedReferences: chunk.flatMap((m) => (m.kind === "tool" && m.envelope ? [m.envelope.evidenceRef] : [])).slice(0, 50),
		createdAt: new Date().toISOString(),
		version: ctx.state.compactions.length + 1,
		componentVersions: harnessComponentVersions(ctx.state),
		modelGenerated: true,
	};
	await ctx.emit({ type: "context.compaction", record });
}
