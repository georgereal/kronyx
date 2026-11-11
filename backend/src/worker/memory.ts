import { randomUUID } from "node:crypto";
import type { AgentMessage, AgentTool } from "@cline/shared";
import type { Db } from "mongodb";
import { swallow } from "../lib/log";
import type { RunDigest } from "../../../src/agent/runner";
import type { PriorTranscript } from "../../../src/agent/recall";

const MAX_TRANSCRIPTS = 5;
const MAX_TRANSCRIPT_BYTES = 512 * 1024;
const MAX_DIGESTS = 3;
const MAX_MEMORIES = 50;

/** Persisted prior-run transcripts for cold recall — active tier only. */
export async function loadTranscripts(db: Db, uid: string, sessionId: string): Promise<PriorTranscript[]> {
	const docs = await db
		.collection("run_transcripts")
		.find({ uid, sessionId, state: { $ne: "compacted" } })
		.sort({ savedAt: 1 })
		.limit(MAX_TRANSCRIPTS)
		.toArray();
	return docs.map((d) => ({ label: String(d.label ?? d.runId), messages: (d.messages ?? []) as AgentMessage[] }));
}

/** Save the canonical transcript for a finished run (upsert per runId, cap history). */
export async function saveTranscript(
	db: Db,
	uid: string,
	sessionId: string,
	runId: string,
	messages: readonly AgentMessage[],
): Promise<void> {
	let payload = messages as unknown[];
	if (JSON.stringify(payload).length > MAX_TRANSCRIPT_BYTES) {
		payload = payload.slice(-Math.floor(payload.length * 0.6));
	}
	await db.collection("run_transcripts").updateOne(
		{ uid, runId },
		{ $set: { uid, sessionId, runId, label: `run ${runId.slice(0, 8)}`, messages: payload, savedAt: new Date() } },
		{ upsert: true },
	);
	// Retention tiers: past the active window, transcripts are marked compacted
	// (kept durable — represented by digests) rather than deleted.
	await db.collection("run_transcripts").updateMany(
		{ uid, sessionId, state: { $ne: "compacted" } },
		[{ $set: { state: "active" } }],
	).catch(swallow("memory", "op"));
	const stale = await db
		.collection("run_transcripts")
		.find({ uid, sessionId, state: { $ne: "compacted" } })
		.sort({ savedAt: -1 })
		.skip(MAX_TRANSCRIPTS)
		.project({ runId: 1 })
		.toArray();
	if (stale.length) {
		await db.collection("run_transcripts").updateMany(
			{ uid, runId: { $in: stale.map((d) => d.runId) } },
			{ $set: { state: "compacted", compactedAt: new Date() } },
		);
	}
}

export interface ProvenDigest extends RunDigest {
	runId: string;
	toSeq?: number;
}

/** Store digests with provenance (source run + event range) on the session doc. */
export async function recordDigests(
	db: Db,
	uid: string,
	sessionId: string,
	digests: readonly ProvenDigest[],
): Promise<void> {
	if (!digests.length) return;
	await db
		.collection("sessions")
		.updateOne({ uid, sessionId }, { $set: { digests: digests.slice(-MAX_DIGESTS), updatedAt: new Date() } });
}

interface MemoryDoc {
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
}

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

/** memory_write tool: provenance-carrying candidate in the `memories` collection. */
export function memoryWriteTool(
	db: Db,
	uid: string,
	sessionId: string,
	runId: string,
	provider?: EmbedProvider,
	repo?: string,
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
			await db.collection("memories").insertOne(embedding ? { ...doc, embedding } : doc);
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
): Promise<MemoryDoc[]> {
	const vector = provider ? await embedText(provider, query, "memory_recall") : undefined;
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
			])
			.toArray()
			.catch(swallow("memory", "op", []));
		const eligible = (hits as unknown as MemoryDoc[]).filter((h) =>
			h.scope === "project" ? repo !== undefined && h.repo === repo : h.sessionId === sessionId,
		);
		if (eligible.length) {
			const top = eligible.slice(0, 8);
			// Recall is the verification signal: promote candidates that made it into context.
			void db
				.collection("memories")
				.updateMany({ uid, status: "candidate", memoryId: { $in: top.map((m) => m.memoryId) } }, { $set: { status: "active" } })
				.catch(swallow("memory", "op"));
			return top;
		}
	}
	// No embeddings available (provider lacks the model) — recency is the
	// honest degenerate, not a keyword workaround.
	return loadMemories(db, uid, sessionId, repo);
}

/** Lightweight context manifest (ADR §9) — what actually entered this run's context. */
export interface ContextManifest {
	contextId: string;
	transcriptsIncluded: string[];
	digestCount: number;
	memoryIdsUsed: string[];
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
	for (const m of memories.slice(-10)) {
		lines.push(`- Remembered: ${m.content}${m.status === "candidate" ? " (unverified)" : ""}`);
	}
	if (plans.length) lines.push(`- Saved plans: ${plans.join(", ")} (implementable on request)`);
	return lines.length > 1 ? lines.join("\n") : "";
}
