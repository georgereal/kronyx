import { cosine, topK } from "../agent/vector";
import type { SessionEvent } from "../harness/contracts";
import { embedTexts, memoryEnabled } from "./memory";
import { localEmbedError } from "./localEmbed";

/** Run-memory chunks live under runs://<session>/<runId>[/<taskId>] in the sqlite vector store. */
const RUN_PREFIX = "runs://";
const TOP_K = 6;
const MIN_SCORE = 0.2;
const DIGEST_CHARS = 4000;
const TASK_ENTRY_CHARS = 1500;
const CHUNK_WINDOW = 1400;

export interface RunDigest {
	taskId?: string;
	label: string;
	text: string;
}

/** Builds the embeddable digest entries for one finished run: one run-level
 *  digest (prompt + task outcomes + final report) plus one entry per task so
 *  `task` filters and task-level queries land precisely. */
export function buildRunDigests(events: readonly SessionEvent[], runId: string, session: string): RunDigest[] {
	const scoped = events.filter((e) => e.runId === runId);
	if (!scoped.length) return [];
	// The real prompt is the tail paragraph of the run's first user.input —
	// earlier blocks are injected context (IDE state, memory snippets, run digests).
	const firstInput = scoped.find((e) => e.type === "user.input" && e.text.trim());
	const promptText = firstInput?.type === "user.input" ? (firstInput.text.split(/\n\s*\n/).pop() ?? firstInput.text).trim() : "";
	const tasks = new Map<string, { title: string; status: string }>();
	for (const e of scoped) {
		if (e.type === "task.created") tasks.set(e.task.id, { title: e.task.title, status: "pending" });
		if (e.type === "task.updated") {
			const t = tasks.get(e.id);
			if (t) t.status = e.to;
		}
	}
	const outcome = [...scoped].reverse().find((e) => e.type === "run.status");
	const status = outcome?.type === "run.status" ? outcome.status : "?";
	const reason = outcome?.type === "run.status" && "reason" in outcome ? String((outcome as { reason?: string }).reason ?? "") : "";
	const finished = status === "completed";
	const lastText = [...scoped].reverse().find((e) => e.type === "model.response" && e.text.trim());
	const reportSection = finished
		? `Final report:\n${lastText?.type === "model.response" ? lastText.text : "(none)"}`
		: `Run did not finish — ${status}${reason ? ` (${reason})` : ""}.\nLast note: ${lastText?.type === "model.response" ? lastText.text.slice(0, 400) : "(none)"}`;
	const recaps = scoped.filter((e) => e.type === "context.recap");
	const lastRecap = recaps.at(-1);
	const taskLines = [...tasks.entries()].map(([id, t]) => `${id}: ${t.title} — ${t.status}`);
	const digests: RunDigest[] = [
		{
			label: `run ${runId.slice(0, 8)} · ${session}`,
			text:
				`Run ${runId} of session "${session}" (${status}).\n` +
				`Prompt: ${promptText.slice(0, 600) || "(none)"}\n` +
				(taskLines.length ? `Tasks:\n${taskLines.join("\n")}\n` : "") +
				`${reportSection}\n` +
				(lastRecap?.type === "context.recap" ? `Latest compaction brief:\n${lastRecap.text}` : "").slice(0, DIGEST_CHARS),
		},
	];
	for (const [id, t] of tasks) {
		digests.push({
			taskId: id,
			label: `run ${runId.slice(0, 8)} · task ${id}`,
			text: `Task ${id} "${t.title}" in run ${runId} of session "${session}" — status: ${t.status}. Prompt context: ${promptText.slice(0, 400)}`.slice(
				0,
				TASK_ENTRY_CHARS,
			),
		});
	}
	// Mid-run compaction briefs are indexed separately — a run killed mid-work
	// leaves its recap behind even when there is no final report.
	for (const r of recaps) {
		if (r.type !== "context.recap") continue;
		digests.push({
			taskId: `recap-${r.seq}`,
			label: `run ${runId.slice(0, 8)} · recap @${r.seq}`,
			text: `Compaction brief (covers messages 1–${r.covers}) from run ${runId} of session "${session}":\n${r.text}`.slice(0, DIGEST_CHARS),
		});
	}
	return digests;
}

/** Embeds digests for every finished run in the session log into the workspace
 *  vector store — already-indexed runs are skipped, so the first call after the
 *  feature lands backfills earlier runs too. No-op without an embedding model. */
export async function indexRunDigests(root: string, session: string, runId: string, events: readonly SessionEvent[], baseUrl: string, apiKey: string): Promise<void> {
	if (!memoryEnabled()) return;
	const { openStore, upsertChunk, deleteChunks, listIndexedPaths, kvGet, kvSet } = await import("../store");
	const d = await openStore(root);
	const indexed = new Set(listIndexedPaths(d, root));
	// Last status per run — a run indexed mid-flight is re-embedded once its
	// terminal status lands, so digests don't stay stale at "running".
	const lastStatus = new Map<string, string>();
	for (const e of events) {
		if (e.runId && e.type === "run.status") lastStatus.set(e.runId, e.status);
	}
	if (runId) lastStatus.set(runId, lastStatus.get(runId) ?? "finished");
	const pending = [...lastStatus.entries()]
		.filter(([, status]) => status !== "running")
		.map(([rid]) => rid)
		.filter((rid) => {
			const key = `runidx:${session}/${rid}`;
			return !indexed.has(`${RUN_PREFIX}${session}/${rid}`) || kvGet<string>(d, key) !== lastStatus.get(rid);
		});
	if (!pending.length) return;
	const digests = pending.flatMap((rid) => buildRunDigests(events, rid, session).map((digest) => ({ ...digest, rid })));
	if (!digests.length) return;
	// Split long digests into windowed chunks — one averaged vector over a 4k
	// report dilutes every term; ~1400-char windows keep matching sharp.
	const pieces: { rid: string; path: string; idx: number; text: string }[] = [];
	for (const digest of digests) {
		const base = `${RUN_PREFIX}${session}/${digest.rid}${digest.taskId ? `/${digest.taskId}` : ""}`;
		for (let i = 0; i * CHUNK_WINDOW < digest.text.length; i++) {
			pieces.push({ rid: digest.rid, path: base, idx: i, text: digest.text.slice(i * CHUNK_WINDOW, (i + 1) * CHUNK_WINDOW) });
		}
	}
	const vectors = await embedTexts(baseUrl, apiKey, pieces.map((p) => p.text), "run_index", root);
	if (!vectors.length && localEmbedError) {
		const { insertMemoryEvent } = await import("../store");
		insertMemoryEvent(d, { op: "run_index", detail: { digests: digests.length, embedded: 0, err: localEmbedError } }, root);
		return;
	}
	for (const p of new Set(pieces.map((x) => x.path))) deleteChunks(d, p, root);
	for (let i = 0; i < pieces.length; i++) {
		const v = vectors[i];
		if (!v) continue;
		const piece = pieces[i];
		upsertChunk(d, piece.path, piece.idx, piece.text, v, root);
	}
	for (const rid of pending) kvSet(d, `runidx:${session}/${rid}`, lastStatus.get(rid));
}

/** Compact index of prior runs for prompt injection: one line per run —
 *  status, prompt, task outcomes, a snapshot of the report. Small enough to
 *  always fit; the model recalls details via recall_context scope 'runs'. */
export function buildRunIndex(events: readonly SessionEvent[], session: string, limit = 8): string {
	const runIds: string[] = [];
	for (const e of events) {
		if (e.runId && e.type === "run.status" && !runIds.includes(e.runId)) runIds.push(e.runId);
	}
	const lines: string[] = [];
	for (const rid of runIds.slice(-limit)) {
		const scoped = events.filter((e) => e.runId === rid);
		const outcome = [...scoped].reverse().find((e) => e.type === "run.status");
		const status = outcome?.type === "run.status" ? outcome.status : "?";
		const reason = outcome?.type === "run.status" && "reason" in outcome ? String((outcome as { reason?: string }).reason ?? "") : "";
		const firstInput = scoped.find((e) => e.type === "user.input" && e.text.trim());
		const prompt = firstInput?.type === "user.input" ? (firstInput.text.split(/\n\s*\n/).pop() ?? "").trim().slice(0, 80) : "";
		const taskBits: string[] = [];
		const taskTitles = new Map<string, string>();
		for (const e of scoped) {
			if (e.type === "task.created") taskTitles.set(e.task.id, e.task.title);
			if (e.type === "task.updated") taskBits.push(`${e.id}→${e.to}`);
		}
		const lastText = status === "completed" ? [...scoped].reverse().find((e) => e.type === "model.response" && e.text.trim()) : undefined;
		const snapshot = lastText?.type === "model.response" ? lastText.text.replace(/\s+/g, " ").slice(0, 120) : "";
		lines.push(
			`- run ${rid.slice(0, 8)} — ${status}${reason ? ` (${reason})` : ""}${prompt ? ` · "${prompt}"` : ""}` +
				(taskBits.length ? ` · tasks: ${[...new Set(taskBits)].join(", ")}` : "") +
				(snapshot ? ` · report: ${snapshot}` : ""),
		);
	}
	if (!lines.length) return "";
	return `Earlier runs in session "${session}" (recall_context scope 'runs' retrieves their digests; narrow by runId or task):\n${lines.join("\n")}`;
}

/** Semantic search over indexed run digests — the `searchRuns` seam for the
 *  harness recall_context. runId/task filters match chunk paths. */
export async function searchRunDigests(
	root: string,
	baseUrl: string,
	apiKey: string,
	query: string,
	filter: { runId?: string; task?: string },
): Promise<{ label: string; text: string; score: number }[] | undefined> {
	if (!memoryEnabled()) return undefined;
	const [qv] = await embedTexts(baseUrl, apiKey, [query], "run_recall", root);
	if (!qv) return undefined;
	const { openStore, listChunks } = await import("../store");
	const chunks = listChunks(await openStore(root), 5000, root).filter((c) => {
		if (!c.path.startsWith(RUN_PREFIX)) return false;
		// Vectors from a different embedding model are incomparable.
		if (c.embedding.length !== qv.length) return false;
		const parts = c.path.slice(RUN_PREFIX.length).split("/");
		// Filters accept the prefixes shown in the run index (runId is shown as
		// its first 8 chars; task may be an id or title text).
		if (filter.runId && !parts[1].startsWith(filter.runId)) return false;
		if (filter.task && parts[2] !== filter.task && !parts[2]?.startsWith(filter.task) && !c.text.includes(filter.task)) return false;
		return true;
	});
	const scored = topK(
		chunks.map((c) => ({ path: c.path, text: c.text, score: cosine(qv, c.embedding) })),
		TOP_K,
		(c) => c.score,
	)
		.map((r) => r.item)
		.filter((c) => c.score >= MIN_SCORE)
		.map((c) => ({ label: c.path.slice(RUN_PREFIX.length).replaceAll("/", " · "), text: c.text, score: c.score }));
	return scored;
}
