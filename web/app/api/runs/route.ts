import { NextResponse } from "next/server";
import { authenticate } from "@/lib/apiKeys";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";

/** GET /api/runs — recent cloud runs + their PRs. */
export async function GET(req: Request) {
	const uid = await authenticate(req);
	if (!uid) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const runs = await db.collection("runs").find({ uid }).sort({ at: -1 }).limit(50).toArray();
	const prs = await db.collection("prs").find({ uid }).toArray();
	const prByRun = new Map(prs.map((p) => [String(p.runId), p]));
	return NextResponse.json({
		runs: runs.map((r) => ({ ...r, _id: undefined, pr: prByRun.get(String(r.runId)) ?? null })),
	});
}
