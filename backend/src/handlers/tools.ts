import { authenticate } from "../lib/apiKeys";
import { getDb } from "../lib/mongo";
import { json } from "../routes";

/**
 * GET /api/tools/stats?days=7 — tool usage/failure rollup over run_events.
 * tool-finished events carry name/ok/durationMs; older events without a
 * name bucket under "unknown". Drives the tool-improvement loop.
 */
export async function toolStats(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	const db = await getDb();
	const days = Math.min(90, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 7));
	const since = new Date(Date.now() - days * 86_400_000);
	const match = { uid, ingestedAt: { $gte: since }, "event.type": "tool-finished" };
	const byTool = await db
		.collection("run_events")
		.aggregate([
			{ $match: match },
			{
				$group: {
					_id: { $ifNull: ["$event.name", "unknown"] },
					calls: { $sum: 1 },
					failures: { $sum: { $cond: [{ $eq: ["$event.ok", false] }, 1, 0] } },
					totalMs: { $sum: { $ifNull: ["$event.durationMs", 0] } },
				},
			},
			{
				$project: {
					_id: 0,
					name: "$_id",
					calls: 1,
					failures: 1,
					avgMs: { $round: [{ $divide: ["$totalMs", { $max: ["$calls", 1] }] }, 0] },
				},
			},
			{ $sort: { failures: -1, calls: -1 } },
		])
		.toArray();
	const recent = await db
		.collection("run_events")
		.find({ ...match, "event.ok": false })
		.sort({ ingestedAt: -1 })
		.limit(20)
		.project({ sessionId: 1, runId: 1, ingestedAt: 1, "event.name": 1, "event.output": 1 })
		.toArray();
	return json({
		days,
		byTool,
		recentFailures: recent.map((e) => ({
			sessionId: e.sessionId,
			runId: e.runId,
			at: e.ingestedAt,
			tool: e.event?.name ?? "unknown",
			output: String(e.event?.output ?? "").slice(0, 300),
		})),
	});
}
