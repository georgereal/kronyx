import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

const MEMORY_DIR = ".kronyx";
const RULES = "rules.md";
const FACTS = "memory/facts.md";
const EPISODES = "memory/episodes.jsonl";

export function memoryEnabled(): boolean {
	return vscode.workspace.getConfiguration("kronyx").get<boolean>("memory.enabled", true);
}

/**
 * Memory context injected into the system prompt: workspace rules plus
 * accumulated project facts. Vector/code-index tiers are deferred (ADR-0004/0005).
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
	if (facts.trim()) parts.push(`Remembered project facts (.kronyx/memory/facts.md):\n${facts.trim()}`);
	if (task && settings) {
		const hits = await searchMemory(root, task, settings.baseUrl, settings.apiKey).catch(() => []);
		if (hits.length > 0) parts.push(`Relevant code/memory snippets (semantic search):\n${hits.join("\n\n")}`);
	}
	return parts.join("\n\n");
}

/** Agent-callable: append a fact to .kronyx/memory/facts.md. */
export async function appendFact(root: string, fact: string): Promise<void> {
	const file = path.join(root, MEMORY_DIR, FACTS);
	await fs.mkdir(path.dirname(file), { recursive: true });
	const line = fact.trim().replace(/\n+/g, " ");
	await fs.appendFile(file, `${line.startsWith("-") ? line : `- ${line}`}\n`);
}

// ---------- vector memory (ADR-0005: API embeddings; ADR-0004: sqlite store) ----------

const CHUNK_LINES = 150;
const CHUNK_OVERLAP = 20;

export function embeddingModel(): string {
	return vscode.workspace.getConfiguration("kronyx").get<string>("memory.embeddingModel", "");
}

export function topK(): number {
	return vscode.workspace.getConfiguration("kronyx").get<number>("memory.topK", 5);
}

export function chunkText(text: string): string[] {
	const lines = text.split("\n");
	const chunks: string[] = [];
	for (let i = 0; i < lines.length; i += CHUNK_LINES - CHUNK_OVERLAP) {
		chunks.push(lines.slice(i, i + CHUNK_LINES).join("\n"));
		if (i + CHUNK_LINES >= lines.length) break;
	}
	return chunks.filter((c) => c.trim().length > 20).slice(0, 20);
}

export async function embedTexts(baseUrl: string, apiKey: string, texts: string[]): Promise<Float32Array[]> {
	const model = embeddingModel();
	if (!model) return [];
	const res = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({ model, input: texts }),
		signal: AbortSignal.timeout(30_000),
	});
	if (!res.ok) return [];
	const json = (await res.json()) as { data?: { embedding: number[] }[] };
	return (json.data ?? []).map((d) => new Float32Array(d.embedding));
}

const cosine = (a: Float32Array, b: Float32Array): number => {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
};

/** Index a file's chunks into the store. Silent no-op without embeddings configured. */
export async function indexFile(root: string, rel: string, baseUrl: string, apiKey: string): Promise<void> {
	if (!embeddingModel()) return;
	const abs = path.join(root, rel);
	const text = await fs.readFile(abs, "utf8").catch(() => "");
	if (!text || text.length > 300_000) return;
	const chunks = chunkText(text);
	const vectors = await embedTexts(baseUrl, apiKey, chunks);
	if (vectors.length === 0) return;
	const { openStore, deleteChunks, upsertChunk, kvSet } = await import("../store");
	const d = await openStore(root);
	kvSet(d, `mtime:${root}:${rel}`, (await fs.stat(abs)).mtimeMs);
	deleteChunks(d, rel, root);
	chunks.forEach((chunk, i) => {
		if (vectors[i]) upsertChunk(d, rel, i, chunk, vectors[i], root);
	});
}

/** Full-workspace index: embeds changed files incrementally (mtime in kv). */
export async function indexWorkspace(
	root: string,
	baseUrl: string,
	apiKey: string,
	log: (line: string) => void = () => {},
): Promise<number> {
	if (!embeddingModel()) return 0;
	const { openStore, deleteChunks, upsertChunk, kvGet, kvSet } = await import("../store");
	const d = await openStore(root);
	if (!d) return 0;
	const files: { rel: string; mtime: number }[] = [];
	for await (const rel of walkWorkspace(root, "")) {
		const stat = await fs.stat(path.join(root, rel)).catch(() => undefined);
		if (stat && stat.size < 300_000) files.push({ rel, mtime: stat.mtimeMs });
		if (files.length >= 800) break;
	}
	const stale = files.filter((f) => kvGet<number>(d, `mtime:${root}:${f.rel}`) !== f.mtime);
	if (stale.length === 0) return 0;
	log(`Indexing ${stale.length} changed file(s) (${files.length} scanned)...`);
	let done = 0;
	const BATCH = 8;
	for (const file of stale) {
		const text = await fs.readFile(path.join(root, file.rel), "utf8").catch(() => "");
		if (!text) continue;
		const chunks = chunkText(text);
		deleteChunks(d, file.rel, root);
		for (let i = 0; i < chunks.length; i += BATCH) {
			const batch = chunks.slice(i, i + BATCH);
			const vectors = await embedTexts(baseUrl, apiKey, batch);
			batch.forEach((chunk, j) => {
				if (vectors[j]) upsertChunk(d, file.rel, i + j, chunk, vectors[j], root);
			});
		}
		kvSet(d, `mtime:${root}:${file.rel}`, file.mtime);
		if (++done % 25 === 0) log(`  ${done}/${stale.length} files indexed`);
	}
	log(`Index done: ${done} file(s) updated.`);
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
	const { openStore, listChunks } = await import("../store");
	const d = await openStore(root);
	const chunks = listChunks(d, undefined, root);
	if (chunks.length === 0) return [];
	const [qv] = await embedTexts(baseUrl, apiKey, [query]);
	if (!qv) return [];
	return chunks
		.map((c) => ({ ...c, score: cosine(qv, c.embedding) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, topK())
		.map((c) => `// ${c.path}\n${c.text.slice(0, 800)}`);
}

/** Feedback capture: accept/reject decisions per PLAN-006 provenance. */
export async function logEpisode(root: string, entry: Record<string, unknown>): Promise<void> {
	if (!memoryEnabled()) return;
	const file = path.join(root, MEMORY_DIR, EPISODES);
	await fs.mkdir(path.dirname(file), { recursive: true });
	const at = new Date().toISOString();
	await fs.appendFile(file, `${JSON.stringify({ at, ...entry })}\n`);
	const { openStore, insertEpisode } = await import("../store");
	insertEpisode(
		await openStore(root),
		{
			kind: String(entry.kind ?? "episode"),
			path: String(entry.path ?? ""),
			task: String(entry.task ?? ""),
			at,
		},
		root,
	);
}
