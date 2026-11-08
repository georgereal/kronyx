import { NextResponse } from "next/server";
import { authenticate } from "@/lib/apiKeys";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";

/** GET /api/runs/[id]?after=<seq> — run meta + event stream tail. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const uid = await authenticate(req);
	if (!uid) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	const { id } = await params;
	const after = Number(new URL(req.url).searchParams.get("after")) || 0;
	const db = await getDb();
	const [run, pr, events] = await Promise.all([
		db.collection("runs").findOne({ uid, runId: id }),
		db.collection("prs").findOne({ uid, runId: id }),
		db.collection("run_events")
			.find({ uid, runId: id, ...(after ? { seq: { $gt: after } } : {}) })
			.sort({ seq: 1 })
			.limit(500)
			.toArray(),
	]);
	if (!run && events.length === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
	return NextResponse.json({
		run: run ? { ...run, _id: undefined } : null,
		pr: pr ? { ...pr, _id: undefined } : null,
		events: events.map((e) => ({ seq: e.seq, event: e.event })),
	});
}
