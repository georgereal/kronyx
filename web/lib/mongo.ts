import { MongoClient, type Db } from "mongodb";

let client: MongoClient | undefined;
let db: Db | undefined;

export async function getDb(): Promise<Db> {
	if (db) return db;
	client ??= new MongoClient(process.env.MONGODB_URI ?? "");
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
	return db;
}
