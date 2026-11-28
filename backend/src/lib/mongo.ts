import { MongoClient, type Db } from "mongodb";

let client: MongoClient | undefined;
let db: Db | undefined;

export async function getDb(): Promise<Db> {
	if (db) return db;
	client ??= new MongoClient(process.env.MONGODB_URI ?? "", {
		// Atlas drops idle sockets (ECONNRESET) — reap ours first so the pool
		// never holds a dead connection when the next query lands.
		maxIdleTimeMS: 30_000,
		serverSelectionTimeoutMS: 10_000,
		connectTimeoutMS: 10_000,
		heartbeatFrequencyMS: 10_000,
		retryWrites: true,
	});
	await client.connect();
	db = client.db("kronyx");
	// Dedupe key: (uid, deviceId, clientRowId) — replays/retries are idempotent.
	// clientRowId is per-machine sqlite rowid, so deviceId must be in the key.
	await db
		.collection("usage_events")
		.createIndex({ uid: 1, deviceId: 1, clientRowId: 1 }, { unique: true, sparse: true });
	await db.collection("usage_events").createIndex({ uid: 1, at: -1 });
	await db.collection("api_keys").createIndex({ hash: 1 }, { unique: true });
	await db.collection("api_keys").createIndex({ uid: 1 });
	await db.collection("runs").createIndex({ uid: 1, runId: 1 }, { unique: true });
	await db.collection("runs").createIndex({ uid: 1, at: -1 });
	await db.collection("run_events").createIndex({ uid: 1, runId: 1, seq: 1 }, { unique: true });
	await db.collection("prs").createIndex({ uid: 1, runId: 1 }, { unique: true });
	await db.collection("sandboxes").createIndex({ uid: 1, at: -1 });
	await db.collection("sessions").createIndex({ uid: 1, sessionId: 1 }, { unique: true });
	await db.collection("sessions").createIndex({ uid: 1, updatedAt: -1 });
	await db.collection("cloud_jobs").createIndex({ status: 1, createdAt: 1 });
	await db.collection("cloud_jobs").createIndex({ uid: 1, jobId: 1 }, { unique: true });
	await db.collection("attachments").createIndex({ uid: 1, sessionId: 1 });
	await db.collection("plans").createIndex({ uid: 1, sessionId: 1, slug: 1 }, { unique: true });
	await db.collection("run_reports").createIndex({ uid: 1, runId: 1 }, { unique: true });
	// Transcripts key on agentIndex too — the old {uid, runId} unique index
	// predates multi-agent slices and silently dropped every slice > 0.
	await db
		.collection("run_transcripts")
		.dropIndex("uid_1_runId_1")
		.catch((err: unknown) => {
			// Missing index = already migrated; anything else must be loud —
			// a failed drop leaves the stale unique key silently eating slices.
			const m = err instanceof Error ? err.message : String(err);
			if (!/IndexNotFound|index not found|ns not found/i.test(m)) console.error("[mongo] run_transcripts index migration failed:", m);
		});
	await db.collection("run_transcripts").createIndex({ uid: 1, runId: 1, agentIndex: 1 }, { unique: true });
	await db.collection("run_transcripts").createIndex({ uid: 1, sessionId: 1, savedAt: 1 });
	await db.collection("memory_events").createIndex({ uid: 1, at: -1 });
	await db.collection("memories").createIndex({ uid: 1, memoryId: 1 }, { unique: true });
	await db.collection("memories").createIndex({ uid: 1, sessionId: 1, scope: 1, status: 1 });
	// Shared knowledge-store shape (mirrors the SQLite knowledge_records/knowledge_chunks tables).
	// Atlas vector search index knowledge_chunks_vector is managed alongside memories_vector:
	// path embedding, cosine similarity, dimensions matching the active embedding model,
	// with scopeKey/lifecycleStatus/type filter fields.
	await db.collection("knowledge_records").createIndex({ scopeKey: 1, knowledgeId: 1 }, { unique: true });
	await db.collection("knowledge_records").createIndex({ scopeKey: 1, type: 1, "lifecycle.status": 1 });
	await db.collection("knowledge_chunks").createIndex({ scopeKey: 1, knowledgeId: 1, chunkIndex: 1 }, { unique: true });
	await db.collection("knowledge_chunks").createIndex({ scopeKey: 1, lifecycleStatus: 1, updatedAt: -1 });
	await db.collection("execution_states").dropIndex("sessionId_1_runId_1").catch(() => undefined);
	await db.collection("execution_states").createIndex({ uid: 1, sessionId: 1, runId: 1 }, { unique: true });
	await db.collection("execution_states").createIndex({ uid: 1, sessionId: 1, eventCursor: -1 });
	await db.collection("harness_events").createIndex({ uid: 1, scope: 1, seq: 1 }, { unique: true });
	await db.collection("harness_events").createIndex({ uid: 1, scope: 1, runId: 1, type: 1 });
	await db.collection("sandboxes").createIndex({ uid: 1, sessionId: 1, at: 1 });
	await db.collection("sandboxes").createIndex({ uid: 1, state: 1 });
	await db.collection("sandbox_events").createIndex({ uid: 1, sandboxId: 1, at: -1 });
	await db.collection("sandbox_events").createIndex({ uid: 1, at: -1 });
	// Backfill: legacy event-log rows predate real state — they're all long dead.
	await db
		.collection("sandboxes")
		.updateMany({ state: { $exists: false } }, { $set: { state: "dead", reason: "legacy-closed" } });
	return db;
}
