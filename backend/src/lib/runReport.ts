import type { Db } from "mongodb";

/**
 * Collated per-run report: joins the usage_events ledger with the run_events
 * trace into one JSON document. Persisted to `run_reports` at run finish and
 * built on demand for extension-ingested or historical runs.
 */

const DELTA_TYPES = new Set(["assistant-delta", "reasoning-delta"]);

interface UsageRow {
	at?: Date;
	kind?: string;
	op?: string;
	model?: string;
	status?: string;
	iteration?: number | null;
	contextMsgs?: number | null;
	tokensIn?: number;
	tokensOut?: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoningTokens?: number;
	costUsd?: number | null;
	billedCostUsd?: number | null;
	durationMs?: number;
}

export async function buildRunReport(db: Db, uid: string, runId: string) {
	const [run, usage, events] = await Promise.all([
		db.collection("runs").findOne({ uid, runId }),
		db.collection("usage_events").find({ uid, runId }).sort({ at: 1 }).project({ _id: 0, uid: 0 }).toArray(),
		db.collection("run_events").find({ uid, runId }).sort({ seq: 1 }).project({ seq: 1, event: 1 }).toArray(),
	]);
	if (!run && usage.length === 0 && events.length === 0) return null;

	const rows = usage as unknown as UsageRow[];
	const totals = {
		chatCalls: 0,
		embeddingCalls: 0,
		iterations: 0,
		tokensIn: 0,
		tokensOut: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoningTokens: 0,
		costUsd: 0,
		billedCostUsd: 0,
		llmMs: 0,
		cacheHitRatio: 0,
	};
	for (const r of rows) {
		if (r.kind === "embedding") totals.embeddingCalls++;
		else totals.chatCalls++;
		if (typeof r.iteration === "number") totals.iterations = Math.max(totals.iterations, r.iteration);
		totals.tokensIn += r.tokensIn ?? 0;
		totals.tokensOut += r.tokensOut ?? 0;
		totals.cacheRead += r.cacheRead ?? 0;
		totals.cacheWrite += r.cacheWrite ?? 0;
		totals.reasoningTokens += r.reasoningTokens ?? 0;
		totals.costUsd += r.costUsd ?? 0;
		totals.billedCostUsd += r.billedCostUsd ?? 0;
		totals.llmMs += r.durationMs ?? 0;
	}
	totals.cacheHitRatio = totals.tokensIn > 0 ? totals.cacheRead / totals.tokensIn : 0;

	const toolNames = new Map<string, string>();
	const tools: { name: string; ok: boolean; durationMs: number; seq: number }[] = [];
	const timeline: { seq: number; type: string; [k: string]: unknown }[] = [];
	const eventCounts: Record<string, number> = {};
	for (const e of events) {
		const ev = (e.event ?? {}) as Record<string, unknown>;
		const type = String(ev.type ?? "?");
		eventCounts[type] = (eventCounts[type] ?? 0) + 1;
		if (type === "tool-started") {
			toolNames.set(String(ev.id), String(ev.name ?? "?"));
			continue;
		}
		if (type === "tool-finished") {
			tools.push({
				name: toolNames.get(String(ev.id)) ?? "?",
				ok: Boolean(ev.ok),
				durationMs: Number(ev.durationMs) || 0,
				seq: e.seq as number,
			});
			continue;
		}
		if (DELTA_TYPES.has(type)) continue;
		const { type: _t, ...rest } = ev;
		timeline.push({ seq: e.seq as number, type, ...rest });
	}

	return {
		runId,
		sessionId: String(run?.sessionId ?? events[0]?.sessionId ?? ""),
		uid,
		generatedAt: new Date(),
		run: run
			? {
					status: run.status,
					mode: run.mode,
					modelId: run.modelId,
					task: run.task,
					startedAt: run.startedAt,
					finishedAt: run.finishedAt,
					error: run.error,
					contextManifest: run.contextManifest,
				}
			: null,
		totals,
		usage: rows,
		tools,
		timeline,
		eventCounts,
	};
}

/** Build + upsert the report. Never throws — callers run it best-effort. */
export async function saveRunReport(db: Db, uid: string, runId: string): Promise<void> {
	const report = await buildRunReport(db, uid, runId);
	if (!report) return;
	await db
		.collection("run_reports")
		.updateOne({ uid, runId }, { $set: report }, { upsert: true });
}
