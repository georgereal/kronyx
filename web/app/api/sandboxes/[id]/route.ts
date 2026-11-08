import { NextResponse } from "next/server";
import { authenticate } from "@/lib/apiKeys";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";

async function key(uid: string): Promise<string | undefined> {
	const db = await getDb();
	const doc = await db.collection<{ _id: string; settings?: { secrets?: { e2bApiKey?: string } } }>("users").findOne({ _id: uid });
	return doc?.settings?.secrets?.e2bApiKey ?? process.env.E2B_API_KEY;
}

/** DELETE /api/sandboxes/[id] — kill the VM via the user's synced E2B key. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const uid = await authenticate(req);
	if (!uid) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	const { id } = await params;
	const k = await key(uid);
	if (!k) return NextResponse.json({ error: "no_e2b_key" }, { status: 400 });
	const res = await fetch(`https://api.e2b.app/sandboxes/${encodeURIComponent(id)}`, {
		method: "DELETE",
		headers: { "X-API-KEY": k },
	});
	return NextResponse.json({ ok: res.ok }, { status: res.ok ? 200 : 502 });
}
