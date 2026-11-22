import { randomUUID } from "node:crypto";
import { authenticate } from "../lib/apiKeys";
import { getDb } from "../lib/mongo";
import { swallow } from "../lib/log";
import { json } from "../routes";
import { embedText, searchMemories, type EmbedProvider } from "../worker/memory";
import { activeProviderCreds, loadUserSettings } from "../worker/settings";

const MAX_IMPORT = 200;

/** Embedder for manual memory ops — the account's active provider profile
 *  (embeddings only need baseUrl+apiKey, not a chat model). Each call records a
 *  usage_events row so manual ops appear in usage telemetry. */
async function embedder(uid: string): Promise<EmbedProvider | undefined> {
	const db = await getDb();
	const settings = await loadUserSettings(db, uid).catch(() => null);
	const creds = settings && activeProviderCreds(settings);
	if (!settings || !creds) return undefined;
	const { baseUrl, apiKey } = creds;
	return {
		baseUrl,
		apiKey,
		embeddingModel: typeof settings.data.embeddingModel === "string" ? settings.data.embeddingModel : undefined,
		onUsage: (u) => {
			void db
				.collection("usage_events")
				.insertOne({
					uid,
					deviceId: "web",
					clientRowId: `mem-${randomUUID()}`,
					at: new Date(),
					status: u.ok ? "ok" : "failed",
					provider: "manual",
					baseUrl,
					model: u.model,
					profile: "manual",
					kind: "embedding",
					op: u.op ?? "manual-embed",
					tokensIn: u.tokensIn,
					tokensOut: 0,
					cacheRead: 0,
					cacheWrite: 0,
					durationMs: u.durationMs,
				})
				.catch(swallow("memories", "insert"));
		},
	};
}

const pub = (d: Record<string, unknown>) => {
	const { _id, embedding, ...rest } = d;
	void _id;
	void embedding;
	return rest;
};

/** GET /api/memories/export — full doc set (no embeddings) as a JSON file. */
export async function exportMemories(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const docs = await db.collection("memories").find({ uid }).sort({ createdAt: 1 }).toArray();
	return new Response(JSON.stringify({ exportedAt: new Date().toISOString(), docs: docs.map(pub) }, null, 2), {
		headers: { "content-type": "application/json", "content-disposition": `attachment; filename="kronyx-memories-${Date.now()}.json"` },
	});
}

/** POST /api/memories — manual memory. Embeds best-effort. */
export async function createMemory(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const b = (await req.json().catch(() => null)) as { content?: string; scope?: string; repo?: string; branch?: string; sessionId?: string; tags?: unknown } | null;
	const content = String(b?.content ?? "").slice(0, 500).trim();
	if (!content) return json({ error: "content required" }, { status: 400 });
	const scope = b?.scope === "project" ? "project" : "conversation";
	const tags = Array.isArray(b?.tags) ? b.tags.map(String).slice(0, 12) : [];
	const doc: Record<string, unknown> = {
		memoryId: randomUUID(),
		uid,
		sessionId: String(b?.sessionId ?? "manual"),
		scope,
		...(b?.repo ? { repo: String(b.repo) } : {}),
		...(b?.branch ? { branch: String(b.branch) } : {}),
		content,
		origin: { kind: "user" },
		confidence: 0.8,
		status: "active",
		version: 1,
		tags,
		createdAt: new Date(),
	};
	const provider = await embedder(uid);
	const embedding = provider ? await embedText(provider, content, "manual-memory-write") : undefined;
	if (embedding) doc.embedding = embedding;
	const db = await getDb();
	await db.collection("memories").insertOne(doc);
	return json({ memory: pub(doc) });
}

/** PATCH /api/memories/:id — content (re-embed), tags, status, scope, repo. */
export async function updateMemory(req: Request, params: Record<string, string>): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
	if (!b) return json({ error: "body required" }, { status: 400 });
	const $set: Record<string, unknown> = { updatedAt: new Date() };
	if (typeof b.content === "string" && b.content.trim()) $set.content = b.content.slice(0, 500).trim();
	if (typeof b.status === "string" && ["candidate", "active", "superseded"].includes(b.status)) $set.status = b.status;
	if (typeof b.scope === "string" && ["conversation", "project"].includes(b.scope)) $set.scope = b.scope;
	if (typeof b.repo === "string") $set.repo = b.repo || undefined;
	if (Array.isArray(b.tags)) $set.tags = b.tags.map(String).slice(0, 12);
	if ($set.content) {
		const provider = await embedder(uid);
		const embedding = provider ? await embedText(provider, String($set.content), "manual-memory-update") : undefined;
		if (embedding) $set.embedding = embedding;
	}
	const db = await getDb();
	const r = await db
		.collection("memories")
		.findOneAndUpdate({ uid, memoryId: params.id }, { $set, $inc: { version: 1 } }, { returnDocument: "after" });
	if (!r) return json({ error: "not found" }, { status: 404 });
	return json({ memory: pub(r as unknown as Record<string, unknown>) });
}

/** DELETE /api/memories/:id */
export async function deleteMemory(req: Request, params: Record<string, string>): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const r = await db.collection("memories").deleteOne({ uid, memoryId: params.id });
	if (!r.deletedCount) return json({ error: "not found" }, { status: 404 });
	return json({ ok: true });
}

/** POST /api/memories/import — bulk upsert, cap 200, embed best-effort. */
export async function importMemories(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const b = (await req.json().catch(() => null)) as { docs?: Record<string, unknown>[] } | null;
	const docs = Array.isArray(b?.docs) ? b.docs.slice(0, MAX_IMPORT) : [];
	if (!docs.length) return json({ error: "docs required" }, { status: 400 });
	const provider = await embedder(uid);
	const db = await getDb();
	let inserted = 0;
	let skipped = 0;
	for (const d of docs) {
		const content = String(d.content ?? "").slice(0, 500).trim();
		if (!content) {
			skipped++;
			continue;
		}
		const doc: Record<string, unknown> = {
			memoryId: typeof d.memoryId === "string" && d.memoryId ? d.memoryId : randomUUID(),
			uid,
			sessionId: String(d.sessionId ?? "manual"),
			scope: d.scope === "project" ? "project" : "conversation",
			...(typeof d.repo === "string" && d.repo ? { repo: d.repo } : {}),
			...(typeof d.branch === "string" && d.branch ? { branch: d.branch } : {}),
			content,
			origin: { kind: "user" },
			confidence: typeof d.confidence === "number" ? d.confidence : 0.8,
			status: ["candidate", "active", "superseded"].includes(String(d.status)) ? d.status : "active",
			version: 1,
			tags: Array.isArray(d.tags) ? (d.tags as unknown[]).map(String).slice(0, 12) : [],
			createdAt: d.createdAt ? new Date(String(d.createdAt)) : new Date(),
		};
		const embedding = provider ? await embedText(provider, content, "manual-memory-import") : undefined;
		if (embedding) doc.embedding = embedding;
		const r = await db
			.collection("memories")
			.updateOne({ uid, memoryId: doc.memoryId }, { $setOnInsert: doc }, { upsert: true });
		if (r.upsertedCount) inserted++;
		else skipped++;
	}
	return json({ inserted, skipped });
}

/** POST /api/memories/recall — {query, repo?, limit?} → ranked docs w/ scores. */
export async function recallMemories(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const b = (await req.json().catch(() => null)) as { query?: string; repo?: string; limit?: number } | null;
	const query = String(b?.query ?? "").trim();
	const db = await getDb();
	const limit = Math.min(50, Number(b?.limit) || 10);
	if (!query) {
		// No query → most recent active memories (the composer's @memory picker).
		const docs = await db
			.collection("memories")
			.find({ uid, status: "active" })
			.sort({ createdAt: -1 })
			.limit(limit)
			.project({ memoryId: 1, content: 1, scope: 1, repo: 1, branch: 1, status: 1 })
			.toArray();
		return json({ tookMs: 0, embedded: false, docs: docs.map((m) => ({ ...m, _id: undefined, repo: m.repo ?? null, branch: m.branch ?? null, score: null })) });
	}
	const provider = await embedder(uid);
	const t0 = Date.now();
	const docs = await searchMemories(db, uid, "manual-recall", query, provider, b?.repo, undefined, "manual-recall").catch(swallow("memories", "op", []));
	return json({
		tookMs: Date.now() - t0,
		embedded: !!provider,
		docs: (docs ?? []).slice(0, limit).map((m) => ({
			memoryId: m.memoryId,
			content: m.content,
			scope: m.scope,
			repo: m.repo ?? null,
			branch: m.branch ?? null,
			status: m.status,
			score: (m as unknown as { score?: number }).score ?? null,
		})),
	});
}
