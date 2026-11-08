import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { verifyRequest } from "@/lib/firebaseAdmin";
import { mintApiKey } from "@/lib/apiKeys";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";

/** POST /api/keys { label } — create a key (Firebase-authed). Plaintext returned once. */
export async function POST(req: Request) {
	const uid = await verifyRequest(req);
	if (!uid) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	const body = (await req.json().catch(() => ({}))) as { label?: string };
	const { key, id } = await mintApiKey(uid, String(body.label ?? "").slice(0, 80));
	return NextResponse.json({ key, id });
}

/** GET /api/keys — list the caller's keys, masked. */
export async function GET(req: Request) {
	const uid = await verifyRequest(req);
	if (!uid) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const keys = await db
		.collection("api_keys")
		.find({ uid })
		.sort({ createdAt: -1 })
		.project({ hash: 0 })
		.toArray();
	return NextResponse.json({
		keys: keys.map((k) => ({
			id: k._id.toHexString(),
			label: k.label,
			masked: `${k.prefix}…`,
			createdAt: k.createdAt,
			lastUsedAt: k.lastUsedAt,
		})),
	});
}

/** DELETE /api/keys?id=… — revoke a key. */
export async function DELETE(req: Request) {
	const uid = await verifyRequest(req);
	if (!uid) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	const id = new URL(req.url).searchParams.get("id") ?? "";
	const db = await getDb();
	await db.collection("api_keys").deleteOne({ _id: new ObjectId(id), uid });
	return NextResponse.json({ ok: true });
}
