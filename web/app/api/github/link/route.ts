import { NextResponse } from "next/server";
import { authenticate } from "@/lib/apiKeys";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";

/** POST /api/github/link {installationId} — bind a GitHub App installation to this user. */
export async function POST(req: Request) {
	const uid = await authenticate(req);
	if (!uid) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	const { installationId } = (await req.json().catch(() => ({}))) as { installationId?: number };
	if (!installationId) return NextResponse.json({ error: "installationId required" }, { status: 400 });
	const db = await getDb();
	await db.collection<{ _id: string }>("users").updateOne(
		{ _id: uid },
		{ $set: { githubInstallationId: installationId, githubLinkedAt: new Date() } },
		{ upsert: true },
	);
	return NextResponse.json({ ok: true });
}
