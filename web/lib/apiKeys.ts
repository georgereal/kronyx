import { createHash, randomBytes } from "node:crypto";
import { getDb } from "@/lib/mongo";
import { verifyRequest } from "@/lib/firebaseAdmin";

const hash = (key: string) => createHash("sha256").update(key).digest("hex");

/** Mint a new API key — plaintext shown once; only the sha256 hash is stored. */
export async function mintApiKey(uid: string, label = ""): Promise<{ key: string; id: string }> {
	const key = `krx_${randomBytes(20).toString("hex")}`;
	const db = await getDb();
	const result = await db.collection("api_keys").insertOne({
		hash: hash(key),
		uid,
		label,
		prefix: key.slice(0, 8),
		createdAt: new Date(),
		lastUsedAt: null,
	});
	return { key, id: result.insertedId.toHexString() };
}

/** Resolve `Authorization: Bearer krx_…` to a uid; updates lastUsedAt. */
export async function resolveApiKey(req: Request): Promise<string | null> {
	const header = req.headers.get("authorization") ?? "";
	const key = header.startsWith("Bearer ") ? header.slice(7) : "";
	if (!key.startsWith("krx_")) return null;
	const db = await getDb();
	const doc = await db.collection("api_keys").findOneAndUpdate(
		{ hash: hash(key) },
		{ $set: { lastUsedAt: new Date() } },
	);
	return doc?.uid ?? null;
}

/**
 * Authenticate a request: extension calls use `Bearer krx_…` API keys;
 * dashboard calls use Firebase ID tokens. Returns uid or null.
 */
export async function authenticate(req: Request): Promise<string | null> {
	return (await resolveApiKey(req)) ?? (await verifyRequest(req));
}
