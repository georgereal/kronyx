import { authenticate } from "../lib/apiKeys";
import { getDb } from "../lib/mongo";
import { json } from "../routes";

/** GET /api/jobs — worker queue state + recent job history for this user. */
export async function listJobs(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const jobs = await db
		.collection("cloud_jobs")
		.find({ uid })
		.sort({ createdAt: -1 })
		.limit(100)
		.toArray();
	const sessionIds = [...new Set(jobs.map((j) => j.sessionId).filter(Boolean))];
	const sessions = await db
		.collection("sessions")
		.find({ uid, sessionId: { $in: sessionIds } }, { projection: { sessionId: 1, title: 1, repo: 1 } })
		.toArray();
	const bySession = new Map(sessions.map((s) => [s.sessionId, s]));
	const now = new Date();
	return json({
		jobs: jobs.map((j) => ({
			jobId: j.jobId,
			runId: j.runId ?? j.jobId,
			kind: j.kind ?? "run",
			mode: j.mode ?? null,
			status: j.status,
			task: j.task ?? j.recipe ?? null,
			sessionId: j.sessionId ?? null,
			session: bySession.get(j.sessionId) ?? null,
			claimedBy: j.claimedBy ?? null,
			claimedAt: j.claimedAt ?? null,
			heartbeatAt: j.heartbeatAt ?? null,
			leaseUntil: j.leaseUntil ?? null,
			createdAt: j.createdAt ?? null,
			finishedAt: j.finishedAt ?? null,
			error: j.error ?? null,
			/** Claimed but past its lease — the owning worker is presumed dead. */
			stale: j.status === "claimed" && !!j.leaseUntil && new Date(j.leaseUntil) < now,
		})),
	});
}

/** POST /api/jobs/:id/requeue — force-requeue a stale claim (mirrors sweepStaleClaims). */
export async function requeueJob(req: Request, p: Record<string, string>): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const job = await db.collection("cloud_jobs").findOne({ uid, jobId: p.id });
	if (!job) return json({ error: "not_found" }, { status: 404 });
	const expired = !!job.leaseUntil && new Date(job.leaseUntil) < new Date();
	if (job.status !== "claimed" || !expired)
		return json({ error: "not_stale", detail: "Only expired claimed jobs can be requeued — the lease may still be live." }, { status: 409 });
	await db.collection("cloud_jobs").updateOne(
		{ uid, jobId: p.id },
		{ $set: { status: "queued", claimedBy: null, claimedAt: null, leaseUntil: null } },
	);
	// updateMany covers multi-slice sibling run docs sharing the runId.
	await db.collection("runs").updateMany(
		{ uid, runId: job.runId ?? p.id, status: { $in: ["queued", "running", "claimed"] } },
		{ $set: { status: "failed", error: "Worker lost — job requeued", finishedAt: new Date() } },
	);
	await db.collection("sessions").updateOne({ uid, sessionId: job.sessionId, activeRunId: job.runId }, { $set: { activeRunId: null } });
	return json({ ok: true });
}
