import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { AgentMessage, AgentTool } from "@cline/shared";
import type { Db } from "mongodb";
import { swallow } from "../lib/log";
import { getCache } from "./cache";
import type { RunDigest } from "../../../src/agent/runner";
import type { PriorTranscript, RecallScorer } from "../../../src/agent/recall";

const MAX_TRANSCRIPTS = 5;
/** Slice transcripts are debug-only — keep a much shorter tail. */
const MAX_SLICE_TRANSCRIPTS = 3;
const MAX_TRANSCRIPT_BYTES = 512 * 1024;
const MAX_DIGESTS = 3;
const MAX_MEMORIES = 50;

/** Persisted prior-run transcripts for cold recall — active tier only. */
export async function loadTranscripts(db: Db, uid: string, sessionId: string): Promise<PriorTranscript[]> {
	const docs = await db
		.collection("run_transcripts")
		// agentIndex>0 docs are multi-agent slice transcripts — stored for
		// debugging but excluded from recall (the merged run's transcript and
		// digests carry the outcome; slices would bloat context N×).
		.find({ uid, sessionId, state: { $ne: "compacted" }, agentIndex: { $in: [0, null] } })
		.sort({ savedAt: 1 })
		.limit(MAX_TRANSCRIPTS)
		.toArray();
	return docs.map((d) => ({
		label: String(d.label ?? d.runId),
		messages: decodeTranscript(d) as AgentMessage[],
	}));
}

/** Read both shapes: gzipped `data` (new) and raw `messages` (legacy). */
function decodeTranscript(d: Record<string, unknown>): unknown[] {
	const bin = d.data as { buffer?: Buffer } | Buffer | undefined;
	if (bin) {
		try {
			const buf = Buffer.isBuffer(bin) ? bin : (bin.buffer as Buffer);
			return JSON.parse(gunzipSync(buf).toString("utf8")) as unknown[];
		} catch {
			return [];
		}
	}
	return (d.messages ?? []) as unknown[];
}

/** Save the canonical transcript for a finished run (upsert per runId, cap history). */
export async function saveTranscript(
	db: Db,
	uid: string,
	sessionId: string,
	runId: string,
	messages: readonly AgentMessage[],
	agentIndex = 0,
): Promise<void> {
	let payload = messages as unknown[];
	if (JSON.stringify(payload).length > MAX_TRANSCRIPT_BYTES) {
		payload = payload.slice(-Math.floor(payload.length * 0.6));
	}
	const packed = gzipSync(JSON.stringify(payload));
	await db.collection("run_transcripts").updateOne(
		{ uid, runId, agentIndex },
		{
			$set: {
				uid,
				sessionId,
				runId,
				agentIndex,
				label: `run ${runId.slice(0, 8)}${agentIndex ? ` slice ${agentIndex}` : ""}`,
				data: packed,
				encoding: "gzip",
				savedAt: new Date(),
			},
			$unset: { messages: "" },
		},
		{ upsert: true },
	);
	// Retention tiers: past the active window, transcripts are marked compacted
	// (kept durable — represented by digests) rather than deleted.
	await db.collection("run_transcripts").updateMany(
		{ uid, sessionId, state: { $ne: "compacted" } },
		[{ $set: { state: "active" } }],
	).catch(swallow("memory", "op"));
	// Eviction: run transcripts and slice transcripts have separate caps —
	// slice chatter must not push real runs into compaction, and eviction is
	// keyed by {runId, agentIndex} (a runId alone no longer identifies one doc).
	const active = await db
		.collection("run_transcripts")
		.find({ uid, sessionId, state: { $ne: "compacted" } })
		.sort({ savedAt: -1 })
		.project({ runId: 1, agentIndex: 1 })
		.toArray();
	const main = active.filter((d) => !d.agentIndex);
	const slices = active.filter((d) => d.agentIndex);
	const evict = [...main.slice(MAX_TRANSCRIPTS), ...slices.slice(MAX_SLICE_TRANSCRIPTS)];
	for (const d of evict) {
		await db
			.collection("run_transcripts")
			.updateOne({ uid, runId: d.runId, agentIndex: d.agentIndex ?? 0 }, { $set: { state: "compacted", compactedAt: new Date() } })
			.catch(swallow("memory", "op"));
	}
}

export interface ProvenDigest extends RunDigest {
	runId: string;
	toSeq?: number;
	/** 0 = main/coordinator, 1..N = multi-agent slice that produced it. */
	agentIndex?: number;
}

/** Store digests with provenance (source run + event range) on the session doc. */
export async function recordDigests(
	db: Db,
	uid: string,
	sessionId: string,
	digests: readonly ProvenDigest[],
	/** Multi-agent runs produce one digest set per agent — let the caller raise the cap. */
	max = MAX_DIGESTS,
): Promise<void> {
	if (!digests.length) return;
	await db
		.collection("sessions")
		.updateOne({ uid, sessionId }, { $set: { digests: digests.slice(-max), updatedAt: new Date() } });
}

export interface MemoryDoc {
	memoryId: string;
	uid: string;
	sessionId: string;
	scope: "conversation" | "project";
	repo?: string;
	content: string;
	origin: { runId: string; kind: "agent" | "user" };
	confidence: number;
	status: "candidate" | "active" | "superseded";
	version: number;
	createdAt: Date;
	/** Usage evidence: how often this memory entered a run's context and how those runs ended. */
	injectedCount?: number;
	lastRecalledAt?: Date;
	lastInjectedRunId?: string;
	helpedRuns?: number;
	failedRuns?: number;
	lastOutcome?: string;
}

/** Diagnostic sink for vector/memory operations — worker wires this to run_events. */
export type MemoryReport = (d: Record<string, unknown>) => void;

export interface EmbedProvider {
	baseUrl: string;
	apiKey: string;
	embeddingModel?: string;
	/** Called per /embeddings request for usage accounting — must not throw. */
	onUsage?: (u: { model: string; tokensIn: number; durationMs: number; ok: boolean; error?: string; op?: string }) => void;
}

const DEFAULT_EMBED_MODEL = "openai/text-embedding-3-small";
/** Must match the `memories_vector` Atlas index numDimensions. */
const EMBEDDING_DIMS = 1536;
let dimsWarned = false;

/** OpenAI-compatible /embeddings call (works on AI Gateway, OpenAI, OpenRouter). */
async function embedText(provider: EmbedProvider, text: string, op?: string): Promise<number[] | undefined> {
	const model = provider.embeddingModel ?? DEFAULT_EMBED_MODEL;
	const t0 = Date.now();
	const report = (ok: boolean, tokensIn = 0, error?: string) => {
		try {
			provider.onUsage?.({ model, tokensIn, durationMs: Date.now() - t0, ok, error, op });
		} catch {}
	};
	try {
		const res = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/embeddings`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
			body: JSON.stringify({ model, input: text.slice(0, 8000) }),
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) {
			report(false, 0, `HTTP ${res.status}`);
			return undefined;
		}
		const data = (await res.json()) as {
			data?: { embedding?: number[] }[];
			usage?: { prompt_tokens?: number; total_tokens?: number };
		};
		report(true, data.usage?.prompt_tokens ?? data.usage?.total_tokens ?? Math.ceil(text.slice(0, 8000).length / 4));
		const embedding = data.data?.[0]?.embedding;
		if (embedding && embedding.length !== EMBEDDING_DIMS && !dimsWarned) {
			dimsWarned = true;
			console.warn(`[memory] ${model} returned ${embedding.length} dims — index expects ${EMBEDDING_DIMS}; vector recall will miss`);
		}
		return embedding;
	} catch (err) {
		report(false, 0, err instanceof Error ? err.message : String(err));
		return undefined;
	}
}

const RECALL_CHUNK_CHARS = 1500;
const RECALL_MIN_CHUNK_CHARS = 40;
const RECALL_MAX_EMBEDS = 40;
const RECALL_VEC_CACHE_MAX = 4000;
const RECALL_MIN_SCORE = 0.2;
/** $vectorSearch quality floor — below this, a "hit" is noise being injected. */
const MEM_RECALL_MIN_SCORE = 0.3;
/** Near-identical embedding match → merge instead of storing a duplicate fact. */
const MEM_DUPE_SCORE = 0.92;
/** Candidates never recalled after this long are presumed stale and superseded. */
const MEM_STALE_MS = 30 * 24 * 3600 * 1000;
/** Penalty per failed-run outcome when ranking vector hits (per point of score). */
const MEM_FAILED_RUN_PENALTY = 0.1;

/**
 * In-process chunk-vector cache, keyed by content hash so identical messages
 * (e.g. a transcript re-searched across runs) embed once per worker lifetime.
 * Transcript messages are immutable, so stale entries can't occur; Redis would
 * only add per-chunk round-trips for no durability benefit worth paying here.
 */
const recallVecCache = new Map<string, number[]>();

function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length && i < b.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Semantic ranker for recall_context: embeds the query plus up to
 * RECALL_MAX_EMBEDS not-yet-cached transcript chunks per call and returns
 * cosine-similar hits. Returns undefined when the provider can't embed at all
 * (tool falls back to keyword search).
 */
export function createRecallScorer(provider: EmbedProvider, report?: MemoryReport): RecallScorer {
	return async (query, chunks) => {
		const t0 = Date.now();
		const qVec = await embedText(provider, query, "recall_context");
		if (!qVec) {
			report?.({ op: "recall_context", usedVector: false, chunks: chunks.length, tookMs: Date.now() - t0 });
			return undefined;
		}
		let embedded = 0;
		let cacheHits = 0;
		const scored: { idx: number; score: number }[] = [];
		for (const c of chunks) {
			const text = c.text.slice(0, RECALL_CHUNK_CHARS);
			if (text.length < RECALL_MIN_CHUNK_CHARS) continue;
			const key = createHash("sha256").update(text).digest("hex").slice(0, 24);
			let v = recallVecCache.get(key);
			if (v) cacheHits++;
			if (!v && embedded < RECALL_MAX_EMBEDS) {
				v = await embedText(provider, text, "recall_context");
				embedded++;
				if (v) {
					if (recallVecCache.size >= RECALL_VEC_CACHE_MAX) {
						const oldest = recallVecCache.keys().next().value;
						if (oldest !== undefined) recallVecCache.delete(oldest);
					}
					recallVecCache.set(key, v);
				}
			}
			const score = v ? cosine(qVec, v) : 0;
			if (score >= RECALL_MIN_SCORE) scored.push({ idx: c.idx, score });
		}
		const hits = scored.sort((a, b) => b.score - a.score).slice(0, 8);
		report?.({
			op: "recall_context",
			usedVector: true,
			chunks: chunks.length,
			cacheHits,
			embeddingsMade: embedded,
			hits: hits.length,
			topScore: hits[0]?.score,
			previews: hits.slice(0, 3).map((h) => chunks[h.idx]?.text.slice(0, 100) ?? ""),
			tookMs: Date.now() - t0,
		});
		return hits;
	};
}

/** memory_write tool: provenance-carrying candidate in the `memories` collection. */
export function memoryWriteTool(
	db: Db,
	uid: string,
	sessionId: string,
	runId: string,
	provider?: EmbedProvider,
	repo?: string,
	report?: MemoryReport,
): AgentTool<{ fact: string; scope?: string }, string> {
	return {
		name: "memory_write",
		description:
			"Record a durable fact for future tasks (decisions made, paths, conventions, state). Keep it concise. scope=conversation recalls within this session; scope=project recalls across all sessions on this repository.",
		inputSchema: {
			type: "object",
			properties: {
				fact: { type: "string", description: "One concise fact to remember." },
				scope: { type: "string", enum: ["conversation", "project"], description: "conversation (default) or project-wide." },
			},
			required: ["fact"],
		},
		async execute(input) {
			const fact = String(input.fact ?? "").slice(0, 500);
			if (!fact) return "Empty fact ignored.";
			// project scope only makes sense with a repo to partition on.
			const scope: MemoryDoc["scope"] = input.scope === "project" && repo ? "project" : "conversation";
			const doc: MemoryDoc = {
				memoryId: randomUUID(),
				uid,
				sessionId,
				scope,
				...(repo ? { repo } : {}),
				content: fact,
				origin: { runId, kind: "agent" },
				confidence: 0.8,
				status: "candidate",
				version: 1,
				createdAt: new Date(),
			};
			const embedding = provider ? await embedText(provider, fact, "memory_write") : undefined;
			// Semantic dedupe: a near-identical fact already stored → merge into it
			// (reworded rewrites of "tests pass" shouldn't crowd the top-8).
			if (embedding) {
				const dup = await db
					.collection("memories")
					.aggregate([
						{
							$vectorSearch: {
								index: "memories_vector",
								path: "embedding",
								queryVector: embedding,
								numCandidates: 10,
								limit: 3,
								filter: { uid, status: { $in: ["active", "candidate"] } },
							},
						},
						{ $addFields: { score: { $meta: "vectorSearchScore" } } },
					])
					.toArray()
					.catch(swallow("memory", "op", []));
				const near = (dup as unknown as (MemoryDoc & { score?: number })[]).find(
					(d) => (d.score ?? 0) >= MEM_DUPE_SCORE && (d.scope === "project" ? d.repo === repo : d.sessionId === sessionId),
				);
				if (near) {
					await db.collection("memories").updateOne(
						{ uid, memoryId: near.memoryId },
						{ $set: { content: fact, embedding, updatedAt: new Date() }, $inc: { version: 1 } },
					);
					report?.({ op: "memory_write", embedded: true, scope, deduped: true, preview: fact.slice(0, 120) });
					return "Fact recorded (merged into an existing memory).";
				}
			}
			await db.collection("memories").insertOne(embedding ? { ...doc, embedding } : doc);
			report?.({ op: "memory_write", embedded: !!embedding, scope, preview: fact.slice(0, 120) });
			const stale = await db
				.collection("memories")
				.find({ uid, sessionId })
				.sort({ createdAt: -1 })
				.skip(MAX_MEMORIES)
				.project({ memoryId: 1 })
				.toArray();
			if (stale.length) {
				await db.collection("memories").updateMany(
					{ uid, memoryId: { $in: stale.map((d) => d.memoryId) } },
					{ $set: { status: "superseded" } },
				);
			}
			return "Fact recorded.";
		},
	};
}

/** Active + candidate memories: this session's conversation scope + repo's project scope. */
export async function loadMemories(db: Db, uid: string, sessionId: string, repo?: string): Promise<MemoryDoc[]> {
	const scopeFilter: Record<string, unknown>[] = [{ scope: "conversation", sessionId }];
	if (repo) scopeFilter.push({ scope: "project", repo });
	return db
		.collection("memories")
		.find({ uid, status: { $in: ["active", "candidate"] }, $or: scopeFilter })
		.sort({ createdAt: 1 })
		.limit(MAX_MEMORIES)
		.toArray() as Promise<unknown> as Promise<MemoryDoc[]>;
}

/**
 * Hybrid memory retrieval: Atlas $vectorSearch when embeddings exist,
 * keyword regex fallback otherwise. Top-8 by relevance then recency.
 */
export async function searchMemories(
	db: Db,
	uid: string,
	sessionId: string,
	query: string,
	provider?: EmbedProvider,
	repo?: string,
	report?: MemoryReport,
	runId?: string,
): Promise<MemoryDoc[]> {
	const t0 = Date.now();
	// Staleness sweep: candidates never injected after MEM_STALE_MS are presumed
	// dead knowledge — supersede them so they stop competing for the top-8.
	const staleScope: Record<string, unknown>[] = [{ scope: "conversation", sessionId }];
	if (repo) staleScope.push({ scope: "project", repo });
	void db
		.collection("memories")
		.updateMany(
			{
				uid,
				status: "candidate",
				createdAt: { $lt: new Date(Date.now() - MEM_STALE_MS) },
				$and: [{ $or: staleScope }, { $or: [{ injectedCount: 0 }, { injectedCount: { $exists: false } }] }],
			},
			{ $set: { status: "superseded", supersededAt: new Date(), supersededReason: "stale-never-recalled" } },
		)
		.catch(swallow("memory", "op"));
	// Repeated runs often recall with the same task text — cache the query
	// embedding briefly (5min) instead of re-billing an /embeddings call.
	let vector: number[] | undefined;
	let queryCacheHit = false;
	if (provider) {
		const cache = await getCache().catch(() => undefined);
		const key = `embed:${createHash("sha256").update(query.slice(0, 8000)).digest("hex").slice(0, 32)}`;
		vector = (await cache?.get(key).catch(() => undefined)) as number[] | undefined;
		if (vector) queryCacheHit = true;
		if (!vector) {
			vector = await embedText(provider, query, "memory_recall");
			if (vector) void cache?.set(key, vector, 5 * 60_000).catch(() => {});
		}
	}
	if (vector) {
		const hits = await db
			.collection("memories")
			.aggregate([
				{
					$vectorSearch: {
						index: "memories_vector",
						path: "embedding",
						queryVector: vector,
						numCandidates: 50,
						// Over-fetch: scope partition (session vs repo) is applied
						// below — $vectorSearch filters can't express that OR.
						limit: 16,
						filter: { uid, scope: { $in: ["conversation", "project"] }, status: { $in: ["active", "candidate"] } },
					},
				},
				{ $addFields: { score: { $meta: "vectorSearchScore" } } },
			])
			.toArray()
			.catch(swallow("memory", "op", []));
		const eligible = (hits as unknown as (MemoryDoc & { score?: number })[])
			.filter(
				(h) => (h.scope === "project" ? repo !== undefined && h.repo === repo : h.sessionId === sessionId) && (h.score === undefined || h.score >= MEM_RECALL_MIN_SCORE),
			)
			// Outcome-aware ranking: memories repeatedly injected into failed runs
			// sink below equally-similar ones with clean records.
			.sort((a, b) => (b.score ?? 0.5) - MEM_FAILED_RUN_PENALTY * (b.failedRuns ?? 0) - ((a.score ?? 0.5) - MEM_FAILED_RUN_PENALTY * (a.failedRuns ?? 0)));
		if (eligible.length) {
			const top = eligible.slice(0, 8) as (MemoryDoc & { score?: number })[];
			// Recall is the verification signal: promote candidates that made it into
			// context, and record the usage evidence (which run, how often).
			const ids = top.map((m) => m.memoryId);
			void Promise.all([
				db
					.collection("memories")
					.updateMany({ uid, status: "candidate", memoryId: { $in: ids } }, { $set: { status: "active" } }),
				db
					.collection("memories")
					.updateMany(
						{ uid, memoryId: { $in: ids } },
						{ $set: { lastRecalledAt: new Date(), lastInjectedRunId: runId ?? "" }, $inc: { injectedCount: 1 } },
					),
			]).catch(swallow("memory", "op"));
			report?.({
				op: "memory_recall",
				path: "vector",
				queryCacheHit,
				candidates: (hits as unknown[]).length,
				hits: top.length,
				query: query.slice(0, 140),
				items: top.map((m) => ({ scope: m.scope, status: m.status, preview: m.content.slice(0, 120), score: m.score })),
				topScore: top[0]?.score,
				tookMs: Date.now() - t0,
			});
			return top;
		}
	}
	// No embeddings available (provider lacks the model) — recency is the
	// honest degenerate, not a keyword workaround. sessionMemoryContext injects
	// the newest entries (slice(-10)) — report and count exactly those.
	const fallback = await loadMemories(db, uid, sessionId, repo);
	const injected = fallback.slice(-10);
	const ids = injected.map((m) => m.memoryId);
	void Promise.all([
		db
			.collection("memories")
			.updateMany({ uid, status: "candidate", memoryId: { $in: ids } }, { $set: { status: "active" } }),
		db
			.collection("memories")
			.updateMany(
				{ uid, memoryId: { $in: ids } },
				{ $set: { lastRecalledAt: new Date(), lastInjectedRunId: runId ?? "" }, $inc: { injectedCount: 1 } },
			),
	]).catch(swallow("memory", "op"));
	report?.({
		op: "memory_recall",
		path: provider ? "recent-fallback" : "no-embedder",
		queryCacheHit,
		hits: injected.length,
		query: query.slice(0, 140),
		items: injected.map((m) => ({ scope: m.scope, status: m.status, preview: m.content.slice(0, 120) })),
		tookMs: Date.now() - t0,
	});
	return fallback;
}

/** Lightweight context manifest (ADR §9) — what actually entered this run's context. */
export interface ContextManifest {
	contextId: string;
	transcriptsIncluded: string[];
	digestCount: number;
	memoryIdsUsed: string[];
	/** Characters of memory content injected into the system prompt. */
	memoryChars?: number;
	planSlugs: string[];
	builtAt: Date;
}

interface SessionForContext {
	repo?: string | null;
	base?: string | null;
	branch?: string | null;
	prUrl?: string | null;
	mode?: string;
	digests?: ProvenDigest[];
	extraRepos?: { repo: string }[];
}

/** System-prompt context block: durable session state for cold or warm runs. */
export function sessionMemoryContext(
	session: SessionForContext,
	plans: string[],
	memories: MemoryDoc[],
): string {
	const lines: string[] = ["Session context (persisted across tasks in this session):"];
	if (session.repo) {
		lines.push(
			`- Repository: ${session.repo} (base ${session.base ?? "main"})` +
				(session.branch ? ` — working branch ${session.branch}` : "") +
				(session.prUrl ? ` — PR ${session.prUrl}` : ""),
		);
	}
	if (session.extraRepos?.length) {
		lines.push(`- Additional read-only repos cloned under /home/user/repos/: ${session.extraRepos.map((r) => r.repo).join(", ")}`);
	}
	for (const [i, d] of (session.digests ?? []).entries()) {
		const files = d.filesChanged?.length ? ` Files: ${d.filesChanged.join(", ")}.` : "";
		lines.push(`- Earlier task ${i + 1}: "${d.task}" → ${d.status}. ${d.summary?.slice(0, 300) ?? ""}${files}`);
	}
	// Injected memories cost real context — cap the block, newest facts win.
	let memChars = 0;
	for (const m of memories.slice(-10)) {
		if (memChars + m.content.length > 2400) break;
		memChars += m.content.length;
		lines.push(`- Remembered: ${m.content}${m.status === "candidate" ? " (unverified)" : ""}`);
	}
	if (plans.length) lines.push(`- Saved plans: ${plans.join(", ")} (implementable on request)`);
	return lines.length > 1 ? lines.join("\n") : "";
}
