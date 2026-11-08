import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";

const MAX_MINUTES = Number(process.env.JANITOR_MAX_SANDBOX_MINUTES || 60);

/** GET /api/cron/janitor — pauses/kills orphaned E2B sandboxes past their TTL.
 *  Call hourly (Vercel cron / external scheduler) with `x-cron-secret` header. */
export async function GET(req: Request) {
	if (process.env.CRON_SECRET && req.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}
	const db = await getDb();
	const users = await db.collection<{ _id: string; settings?: { secrets?: { e2bApiKey?: string } } }>("users")
		.find({ "settings.secrets.e2bApiKey": { $exists: true, $ne: "" } })
		.toArray();
	const cutoff = Date.now() - MAX_MINUTES * 60_000;
	let killed = 0;
	for (const u of users) {
		const key = u.settings?.secrets?.e2bApiKey;
		if (!key) continue;
		const res = await fetch("https://api.e2b.app/v2/sandboxes", { headers: { "X-API-KEY": key }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
		if (!res?.ok) continue;
		const sandboxes = (await res.json()) as { sandboxID?: string; sandboxId?: string; startedAt?: string }[];
		for (const s of sandboxes) {
			const id = s.sandboxID ?? s.sandboxId;
			const started = s.startedAt ? new Date(s.startedAt).getTime() : 0;
			if (!id || (started && started > cutoff)) continue;
			await fetch(`https://api.e2b.app/sandboxes/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "X-API-KEY": key } }).catch(() => {});
			killed++;
		}
	}
	return NextResponse.json({ users: users.length, killed });
}
