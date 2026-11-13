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
	await db.collection("run_transcripts").createIndex({ uid: 1, runId: 1 }, { unique: true });
	await db.collection("run_transcripts").createIndex({ uid: 1, sessionId: 1, savedAt: 1 });
	await db.collection("memory_events").createIndex({ uid: 1, at: -1 });
	await db.collection("memories").createIndex({ uid: 1, memoryId: 1 }, { unique: true });
	await db.collection("memories").createIndex({ uid: 1, sessionId: 1, scope: 1, status: 1 });
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
