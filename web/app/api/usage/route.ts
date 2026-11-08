import { NextResponse } from "next/server";
import { authenticate } from "@/lib/apiKeys";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";

/** GET /api/usage?since=&until=&model=&status=&limit= — caller's usage rows. */
export async function GET(req: Request) {
	const uid = await authenticate(req);
	if (!uid) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	const url = new URL(req.url);
	const filter: Record<string, unknown> = { uid };
	const since = Number(url.searchParams.get("since"));
	const until = Number(url.searchParams.get("until"));
	if (since || until) {
		filter.at = {};
		if (since) (filter.at as Record<string, Date>).$gte = new Date(since);
		if (until) (filter.at as Record<string, Date>).$lte = new Date(until);
	}
	const model = url.searchParams.get("model");
	if (model) filter.model = model;
	const status = url.searchParams.get("status");
	if (status) filter.status = status;
	const limit = Math.min(2000, Number(url.searchParams.get("limit")) || 500);
	const db = await getDb();
	const calls = await db
		.collection("usage_events")
		.find(filter)
		.sort({ at: -1 })
		.limit(limit)
		.project({ _id: 0, uid: 0 })
		.toArray();
	return NextResponse.json({ calls });
}
