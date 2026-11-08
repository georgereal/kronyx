import { NextResponse } from "next/server";
import { authenticate } from "@/lib/apiKeys";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";

/** GET /api/sandboxes — live E2B list (if synced key) merged with history rows. */
export async function GET(req: Request) {
	const uid = await authenticate(req);
	if (!uid) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const history = await db.collection("sandboxes").find({ uid }).sort({ at: -1 }).limit(300).toArray();
	const doc = await db.collection<{ _id: string; settings?: { secrets?: { e2bApiKey?: string } } }>("users").findOne({ _id: uid });
	const key = doc?.settings?.secrets?.e2bApiKey ?? process.env.E2B_API_KEY;
	let live: { sandboxId: string; templateId?: string; state?: string; startedAt?: string }[] = [];
	if (key) {
		const res = await fetch("https://api.e2b.app/v2/sandboxes", {
			headers: { "X-API-KEY": key },
			signal: AbortSignal.timeout(10_000),
		}).catch(() => undefined);
		if (res?.ok) live = (await res.json()) as typeof live;
	}
	return NextResponse.json({ live, history: history.map((h) => ({ ...h, _id: undefined })), liveEnabled: !!key });
}
