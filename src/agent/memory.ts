import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { chunkTextInfo, contentHash, cosine, topK as topKOf } from "./vector";
import type { RecallScorer } from "./recall";

/** Recall ranking knobs, aligned with the backend scorer (backend/src/worker/memory.ts). */
const RECALL_CHUNK_CHARS = 1500;
const RECALL_MIN_CHARS = 40;
const RECALL_MIN_SCORE = 0.2;
const RECALL_TOP_K = 8;
/** Uncached transcript chunks embedded per recall call; the rest are scored on later calls. */
const RECALL_MAX_EMBEDS = 40;

const MEMORY_DIR = ".kronyx";
const RULES = "rules.md";
const FACTS = "memory/facts.md";


export function memoryEnabled(): boolean {
	return vscode.workspace.getConfiguration("kronyx").get<boolean>("memory.enabled", true);
}

/**
 * Memory context injected into the system prompt: workspace rules plus
 * accumulated project facts, plus semantic snippets from the local vector index
 * (ADR-0004 sqlite store, ADR-0005 API embeddings).
 */
export async function loadMemoryContext(
	root: string,
	task?: string,
	settings?: { baseUrl: string; apiKey: string },
): Promise<string> {
	if (!memoryEnabled()) return "";
	const read = (rel: string) => fs.readFile(path.join(root, MEMORY_DIR, rel), "utf8").catch(() => "");
	const [rules, facts] = await Promise.all([read(RULES), read(FACTS)]);
	const parts: string[] = [];
	if (rules.trim()) parts.push(`Workspace rules (.kronyx/rules.md):\n${rules.trim()}`);
	// Facts are appended forever — inject a bounded tail so the block can't
	// silently eat the context budget (same cap as the cloud memory block).
	const factsText = facts.trim();
	const factsCapped =
		factsText.length > 2400 ? factsText.slice(-2400).replace(/^[^\n]*\n?/, "") : factsText;
	if (factsCapped) parts.push(`Remembered project facts (.kronyx/memory/facts.md):\n${factsCapped}`);
	let hits: string[] = [];
	if (task && settings) {
		hits = await searchMemory(root, task, settings.baseUrl, settings.apiKey).catch(() => []);
		if (hits.length > 0) parts.push(`Relevant code/memory snippets (semantic search):\n${hits.join("\n\n")}`);
	}
	// Parity with the cloud contextManifest — record what actually entered context.
	if (parts.length) {
		const { openStore, insertMemoryEvent } = await import("../store");
		insertMemoryEvent(await openStore(root), {
			op: "memory_inject",
			detail: {
				chars: parts.join("").length,
				factLines: factsCapped ? factsCapped.split("\n").length : 0,
				factsTruncated: factsCapped.length < factsText.length,
				snippets: hits.length,
				previews: factsCapped.split("\n").filter(Boolean).slice(-5).map((l) => l.slice(0, 120)),
			},
		}, root);
	}
	return parts.join("\n\n");
}

/** Agent-callable: append a fact to .kronyx/memory/facts.md. */
export async function appendFact(root: string, fact: string): Promise<void> {
	const file = path.join(root, MEMORY_DIR, FACTS);
	await fs.mkdir(path.dirname(file), { recursive: true });
	const line = fact.trim().replace(/\n+/g, " ");
	await fs.appendFile(file, `${line.startsWith("-") ? line : `- ${line}`}\n`);
	const { openStore, insertMemoryEvent } = await import("../store");
	insertMemoryEvent(await openStore(root), { op: "memory_fact", detail: { chars: line.length } }, root);
}

// ---------- vector memory (ADR-0005: API embeddings; ADR-0004: sqlite store) ----------

export function embeddingModel(): string {
	return vscode.workspace.getConfiguration("kronyx").get<string>("memory.embeddingModel", "");
}

export function topK(): number {
	return vscode.workspace.getConfiguration("kronyx").get<number>("memory.topK", 5);
}


/**
 * recall_context ranker for the IDE: embeds the query and transcript chunks with
 * the configured embedding model. Transcript vectors go through the store's
 * content-hash cache, so repeated recall over the same transcript embeds once.
 * Returns undefined when embeddings are unavailable (keyword fallback).
 */
export function createIdeRecallScorer(root: string, baseUrl: string, apiKey: string): RecallScorer {
	return async (query, chunks) => {
		const model = embeddingModel();
		if (!model) return undefined;
		const [qv] = await embedTexts(baseUrl, apiKey, [query], "recall_context", root);
		if (!qv) return undefined;
		const usable = chunks.filter((c) => c.text.trim().length >= RECALL_MIN_CHARS);
		const texts = usable.map((c) => c.text.slice(0, RECALL_CHUNK_CHARS));
		const vectors = await embedChunksCached(baseUrl, apiKey, texts, root, "recall_context", RECALL_MAX_EMBEDS);
		const scored = usable
			.map((c, i) => ({ idx: c.idx, score: vectors[i] ? cosine(qv, vectors[i]!) : 0 }))
			.filter((h) => h.score >= RECALL_MIN_SCORE);
		return scored.sort((a, b) => b.score - a.score).slice(0, RECALL_TOP_K);
	};
}

export async function embedTexts(baseUrl: string, apiKey: string, texts: string[], op = "memory", root = ""): Promise<Float32Array[]> {
	const model = embeddingModel();
	if (!model) return [];
	const t0 = Date.now();
	let status = "failed";
	let tokensIn = 0;
	try {
		const res = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({ model, input: texts }),
			signal: AbortSignal.timeout(30_000),
		});
		if (!res.ok) return [];
		const json = (await res.json()) as { data?: { embedding: number[] }[]; usage?: { prompt_tokens?: number; total_tokens?: number } };
		status = "ok";
		tokensIn = json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? Math.ceil(texts.join("").length / 4);
		return (json.data ?? []).map((d) => new Float32Array(d.embedding));
	} finally {
		// Ledger row — syncs to usage_events like chat calls do (kind="embedding").
		const { openStore, insertApiCall } = await import("../store");
		insertApiCall(await openStore(root), {
			session: "", task: "", at: t0, status, baseUrl, model,
			tokensIn, tokensOut: 0, kind: "embedding", op, durationMs: Date.now() - t0,
		}, root);
	}
}

/**
 * Embed chunks, reusing cached vectors keyed by content hash + model so unchanged
 * text is never sent twice. Only cache misses reach the API.
 */
async function embedChunksCached(
	baseUrl: string,
	apiKey: string,
	chunks: string[],
	root: string,
	op: string,
	maxMisses = Number.POSITIVE_INFINITY,
): Promise<(Float32Array | undefined)[]> {
	const { openStore, getEmbeddingCache, putEmbeddingCache } = await import("../store");
	const d = await openStore(root);
	const model = embeddingModel() ?? "";
	const out: (Float32Array | undefined)[] = new Array(chunks.length);
	const missIdx: number[] = [];
	chunks.forEach((c, i) => {
		const hit = getEmbeddingCache(d, contentHash(c), model);
		if (hit) out[i] = hit;
		else if (missIdx.length < maxMisses) missIdx.push(i);
	});
	for (let i = 0; i < missIdx.length; i += INDEX_BATCH) {
		const slice = missIdx.slice(i, i + INDEX_BATCH);
		const vectors = await embedTexts(baseUrl, apiKey, slice.map((k) => chunks[k]), op, root);
		slice.forEach((k, j) => {
			const v = vectors[j];
			if (!v) return;
			out[k] = v;
			putEmbeddingCache(d, contentHash(chunks[k]), model, v);
		});
	}
	return out;
}

/** Batch size for embedding requests, shared by per-file and full-workspace indexing. */
const INDEX_BATCH = 8;
/** Full-workspace scan cap; files beyond it are reported in the index log. */
const MAX_INDEX_FILES = 800;
/** Quiet period before a changed file is re-indexed (agent edits arrive in bursts). */
export const INDEX_DEBOUNCE_MS = 500;

/**
 * Index a file's chunks into the store. Chunks of a deleted or unreadable file are
 * removed, so search never returns snippets from files that no longer exist.
 */
export async function indexFile(
	root: string,
	rel: string,
	baseUrl: string,
	apiKey: string,
	log: (line: string) => void = () => {},
): Promise<void> {
	if (!embeddingModel()) return;
	const abs = path.join(root, rel);
	const { openStore, deleteChunks, upsertChunk, kvSet, insertMemoryEvent } = await import("../store");
	const d = await openStore(root);
	const stat = await fs.stat(abs).catch(() => undefined);
	if (!stat || !stat.isFile()) {
		deleteChunks(d, rel, root);
		return;
	}
	const text = await fs.readFile(abs, "utf8").catch(() => "");
	if (!text || text.length > 300_000) {
		// Empty or now-oversized files must not keep stale chunks behind.
		deleteChunks(d, rel, root);
		kvSet(d, `mtime:${root}:${rel}`, undefined);
		return;
	}
	const { chunks, dropped } = chunkTextInfo(text);
	if (dropped) log(`[memory] ${rel}: ${dropped} chunk(s) beyond the per-file cap were not indexed`);
	const vectors = await embedChunksCached(baseUrl, apiKey, chunks, root, "memory_index");
	if (vectors.every((v) => !v)) return;
	const complete = vectors.every((v) => v);
	kvSet(d, `mtime:${root}:${rel}`, complete ? stat.mtimeMs : undefined);
	deleteChunks(d, rel, root);
	chunks.forEach((chunk, i) => {
		if (vectors[i]) upsertChunk(d, rel, i, chunk, vectors[i], root);
	});
	insertMemoryEvent(d, { op: "index_file", detail: { path: rel, chunks: chunks.length, dropped } }, root);
}

/** Full-workspace index: embeds changed files incrementally (mtime in kv). */
export async function indexWorkspace(
	root: string,
	baseUrl: string,
	apiKey: string,
	log: (line: string) => void = () => {},
): Promise<number> {
	if (!embeddingModel()) return 0;
	const { openStore, deleteChunks, upsertChunk, kvGet, kvSet, insertMemoryEvent, listIndexedPaths } = await import("../store");
	const d = await openStore(root);
	if (!d) return 0;
	const files: { rel: string; mtime: number }[] = [];
	const seen = new Set<string>();
	let truncated = false;
	for await (const rel of walkWorkspace(root, "")) {
		if (files.length >= MAX_INDEX_FILES) {
			truncated = true;
			break;
		}
		seen.add(rel);
		const stat = await fs.stat(path.join(root, rel)).catch(() => undefined);
		if (stat && stat.size < 300_000) files.push({ rel, mtime: stat.mtimeMs });
		else seen.delete(rel); // oversized or unreadable: treat as gone so stale chunks are pruned
	}
	if (truncated) log(`[memory] workspace has more than ${MAX_INDEX_FILES} indexable files; the rest are not indexed`);
	// Prune chunks of files that were deleted or renamed. Skipped when the scan was
	// truncated, since unseen files are not known to be gone.
	if (!truncated) {
		let pruned = 0;
		for (const rel of listIndexedPaths(d, root)) {
			if (seen.has(rel)) continue;
			deleteChunks(d, rel, root);
			kvSet(d, `mtime:${root}:${rel}`, undefined);
			pruned++;
		}
		if (pruned) log(`Pruned ${pruned} deleted file(s) from the index.`);
	}
	const stale = files.filter((f) => kvGet<number>(d, `mtime:${root}:${f.rel}`) !== f.mtime);
	if (stale.length === 0) return 0;
	log(`Indexing ${stale.length} changed file(s) (${files.length} scanned)...`);
	let done = 0;
	for (const file of stale) {
		const text = await fs.readFile(path.join(root, file.rel), "utf8").catch(() => "");
		const { chunks, dropped } = chunkTextInfo(text);
		if (dropped) log(`[memory] ${file.rel}: ${dropped} chunk(s) beyond the per-file cap were not indexed`);
		const vectors = chunks.length ? await embedChunksCached(baseUrl, apiKey, chunks, root, "memory_index") : [];
		// Leave mtime unset when any chunk failed to embed, so the next pass retries the file.
		const complete = vectors.length === chunks.length && vectors.every((v) => v);
		deleteChunks(d, file.rel, root);
		chunks.forEach((chunk, i) => {
			if (vectors[i]) upsertChunk(d, file.rel, i, chunk, vectors[i], root);
		});
		if (complete) kvSet(d, `mtime:${root}:${file.rel}`, file.mtime);
		if (++done % 25 === 0) log(`  ${done}/${stale.length} files indexed`);
	}
	log(`Index done: ${done} file(s) updated.`);
	insertMemoryEvent(d, { op: "index_done", detail: { scanned: files.length, stale: stale.length, indexed: done, truncated } }, root);
	return done;
}

async function* walkWorkspace(root: string, rel: string): AsyncGenerator<string> {
	const { IGNORED_DIRS } = await import("../tools/workspace");
	const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
		if (entry.name.startsWith(".") && entry.name !== ".kronyx") continue;
		const child = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) yield* walkWorkspace(root, child);
		else if (entry.isFile()) yield child;
	}
}

/** Semantic search over the local chunk index; returns top-k snippets. */
export async function searchMemory(root: string, query: string, baseUrl: string, apiKey: string): Promise<string[]> {
	if (!embeddingModel()) return [];
	const t0 = Date.now();
	const { openStore, listChunks, insertMemoryEvent } = await import("../store");
	const d = await openStore(root);
	const chunks = listChunks(d, undefined, root);
	if (chunks.length === 0) {
		insertMemoryEvent(d, { op: "memory_search", detail: { chunks: 0, hits: 0, tookMs: Date.now() - t0 } }, root);
		return [];
	}
	const [qv] = await embedTexts(baseUrl, apiKey, [query], "memory_search", root);
	if (!qv) {
		insertMemoryEvent(d, { op: "memory_search", detail: { chunks: chunks.length, hits: 0, noEmbed: true, tookMs: Date.now() - t0 } }, root);
		return [];
	}
	// Bounded top-k: candidates beyond the best k are dropped during the scan, not sorted.
	const scored = topKOf(chunks, topK(), (c) => cosine(qv, c.embedding)).map((r) => ({ ...r.item, score: r.score }));
	const hits = scored.map((c) => `// ${c.path}\n${c.text.slice(0, 800)}`);
	insertMemoryEvent(d, {
		op: "memory_search",
		detail: {
			chunks: chunks.length,
			hits: hits.length,
			query: query.slice(0, 140),
			paths: scored.map((c) => c.path).slice(0, 8),
			topScore: scored[0]?.score,
			tookMs: Date.now() - t0,
		},
	}, root);
	return hits;
}

/** Feedback capture: accept/reject decisions per PLAN-006 provenance. Stored in the
 * extension-global DB (telemetry, not project data) — not in the workspace. */
export async function logEpisode(root: string, entry: Record<string, unknown>): Promise<void> {
	if (!memoryEnabled()) return;
	const at = new Date().toISOString();
	const { openStore, insertEpisode } = await import("../store");
	insertEpisode(
		await openStore(root),
		{
			kind: String(entry.kind ?? "episode"),
			path: String(entry.path ?? ""),
			task: String(entry.task ?? ""),
			at,
			data: { at, ...entry },
		},
		root,
	);
}
