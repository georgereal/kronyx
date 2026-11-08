import { NextResponse } from "next/server";
import { authenticate } from "@/lib/apiKeys";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";

/** GET /api/settings — caller's settings doc (or 404). */
export async function GET(req: Request) {
	const uid = await authenticate(req);
	if (!uid) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const doc = await db.collection<{ _id: string; settings?: Record<string, unknown>; devices?: Record<string, unknown> }>("users").findOne({ _id: uid });
	if (!doc?.settings) return NextResponse.json({ error: "not_found" }, { status: 404 });
	return NextResponse.json({ settings: doc.settings, devices: doc.devices ?? {} });
}

/** PUT /api/settings — upsert settings + record the calling device. */
export async function PUT(req: Request) {
	const uid = await authenticate(req);
	if (!uid) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	const body = (await req.json().catch(() => ({}))) as {
		version?: number;
		data?: Record<string, unknown>;
		secrets?: Record<string, string>;
		device?: { id?: string; name?: string };
	};
	const now = new Date();
	const db = await getDb();
	const device = body.device?.id
		? { id: String(body.device.id).slice(0, 64), name: String(body.device.name ?? "").slice(0, 80) }
		: undefined;
	// Granular $set — a push without secrets must not erase keys synced by another device.
	const set: Record<string, unknown> = {
		"settings.version": body.version ?? 1,
		"settings.updatedAt": now,
		"settings.updatedBy": device?.id ?? "unknown",
		"settings.data": body.data ?? {},
	};
	if (body.secrets) set["settings.secrets"] = body.secrets;
	if (device) set[`devices.${device.id}`] = { name: device.name, lastSyncAt: now };
	await db.collection<{ _id: string }>("users").updateOne({ _id: uid }, { $set: set }, { upsert: true });
	return NextResponse.json({ ok: true, updatedAt: now });
}
