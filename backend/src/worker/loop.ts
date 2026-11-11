import { hostname } from "node:os";
import { dbg, swallow } from "../lib/log";
import { getDb } from "../lib/mongo";
import { RunSink } from "./events";
import { saveRunReport } from "../lib/runReport";
import { E2bOrchestratedExecutor, type CloudJob } from "./executor";

try {
	process.loadEnvFile?.(".env");
} catch {}

const WORKER_ID = `${hostname()}-${process.pid}`;
const POLL_MS = 2_000;
const HEARTBEAT_MS = 15_000;
const STOP_CHECK_MS = 3_000;
const LEASE_MS = 10 * 60_000;

const log = (msg: string) => console.log(`[worker ${WORKER_ID}] ${msg}`);
const lease = () => new Date(Date.now() + LEASE_MS);

/** Requeue jobs whose worker died mid-run (lease expired), failing their runs. */
async function sweepStaleClaims(): Promise<void> {
	const db = await getDb();
	const stale = await db
		.collection("cloud_jobs")
		.find({ status: "claimed", leaseUntil: { $lt: new Date() } })
		.toArray();
	for (const j of stale) {
		await db.collection("cloud_jobs").updateOne(
			{ jobId: j.jobId },
			{ $set: { status: "queued", claimedBy: null, claimedAt: null, leaseUntil: null } },
		);
		await db.collection("runs").updateOne(
			{ uid: j.uid, runId: j.runId, status: { $in: ["queued", "running"] } },
			{ $set: { status: "failed", error: "Worker lost — job requeued", finishedAt: new Date() } },
		);
		await db.collection("sessions").updateOne({ uid: j.uid, sessionId: j.sessionId }, { $set: { activeRunId: null } });
		log(`requeued stale job ${j.jobId}`);
		dbg("worker", "requeue", { jobId: j.jobId, claimedBy: j.claimedBy });
	}
}

async function claimNext(): Promise<CloudJob | null> {
	const db = await getDb();
	const job = await db.collection<CloudJob & { status: string }>("cloud_jobs").findOneAndUpdate(
		{ status: "queued" },
		{
			$set: {
				status: "claimed",
				claimedBy: WORKER_ID,
				claimedAt: new Date(),
				heartbeatAt: new Date(),
				leaseUntil: lease(),
			},
		},
		{ sort: { createdAt: 1 }, returnDocument: "after" },
	);
	if (!job) return null;
	// Per-session run lock: sessions are turn-based — one run at a time.
	const locked = await db.collection("sessions").findOneAndUpdate(
		{ uid: job.uid, sessionId: job.sessionId, activeRunId: { $in: [null, undefined] } },
		{ $set: { activeRunId: job.runId } },
		{ returnDocument: "after" },
	);
	if (!locked) {
		// Stale lock? If activeRunId points at a finished/failed run, clear it so
		// the session isn't bricked forever (e.g. handlers that set it at queue time).
		const sess = await db.collection("sessions").findOne({ uid: job.uid, sessionId: job.sessionId });
		const lockRun = sess?.activeRunId
			? await db.collection("runs").findOne({ uid: job.uid, runId: sess.activeRunId })
			: null;
		// activeRunId is only ever set by a worker at claim time — so if it's
		// set but its job is queued-or-dead, the lock is stale, not in flight.
		const lockJob = sess?.activeRunId
			? await db.collection("cloud_jobs").findOne({ jobId: sess.activeRunId })
			: null;
		const stale =
			(sess?.activeRunId && (!lockRun || !["queued", "claimed", "running"].includes(lockRun.status as string))) ||
			(lockJob && !["claimed", "running"].includes(lockJob.status as string));
		if (stale) {
			await db
				.collection("sessions")
				.updateOne({ uid: job.uid, sessionId: job.sessionId }, { $set: { activeRunId: null } });
			console.log(`[worker ${WORKER_ID}] cleared stale session lock ${sess!.sessionId} (run ${sess!.activeRunId})`);
		}
		await db
			.collection("cloud_jobs")
			.updateOne({ jobId: job.jobId }, { $set: { status: "queued", claimedBy: null, claimedAt: null, leaseUntil: null } });
		return null; // another worker holds this session — retry next poll
	}
	return job;
}

async function runJob(job: CloudJob): Promise<void> {
	const db = await getDb();
	const sink = new RunSink(db, job.uid, job.runId, job.sessionId);
	await sink.init();

	const heartbeat = setInterval(() => {
		void db
			.collection("cloud_jobs")
			.updateOne({ jobId: job.jobId }, { $set: { heartbeatAt: new Date(), leaseUntil: lease() } })
			.catch(swallow("loop", "op"));
	}, HEARTBEAT_MS);

	let stopped = false;
	const executor = new E2bOrchestratedExecutor(db, sink);
	const stopCheck = setInterval(() => {
		void (async () => {
			const run = await db.collection("runs").findOne({ uid: job.uid, runId: job.runId });
			if (run?.control === "stop_requested" && !stopped) {
				stopped = true;
				log(`stop requested for ${job.runId}`);
				executor.requestStop();
			}
		})().catch(swallow("loop", "op"));
	}, STOP_CHECK_MS);

	try {
		dbg("worker", "run start", { jobId: job.jobId, runId: job.runId, mode: job.mode, sessionId: job.sessionId });
		const t0 = Date.now();
		await executor.run(job);
		dbg("worker", "run end", { runId: job.runId, ms: Date.now() - t0 });
		const status = stopped ? "stopped" : "completed";
		await sink.patchRun({ status, finishedAt: new Date() });
		await db.collection("cloud_jobs").updateOne({ jobId: job.jobId }, { $set: { status: stopped ? "stopped" : "done", finishedAt: new Date() } });
		log(`job ${job.jobId} ${status}`);
	} catch (error) {
		const message = stopped ? "Stopped by user" : error instanceof Error ? error.message : String(error);
		await sink.emit({ type: "run-failed", error: message }).catch(swallow("loop", "op"));
		await sink.patchRun({ status: stopped ? "stopped" : "failed", error: message, finishedAt: new Date() }).catch(swallow("loop", "op"));
		await db
			.collection("cloud_jobs")
			.updateOne({ jobId: job.jobId }, { $set: { status: stopped ? "stopped" : "failed", error: message, finishedAt: new Date() } })
			.catch(swallow("loop", "op"));
		log(`job ${job.jobId} ${stopped ? "stopped" : "failed"}: ${message}`);
	} finally {
		clearInterval(heartbeat);
		clearInterval(stopCheck);
		// Collated usage+trace report — drain first so all events have landed.
		await sink
			.drain()
			.then(() => saveRunReport(db, job.uid, job.runId))
			.catch(swallow("loop", "op"));
		await db
			.collection("sessions")
			.updateOne({ uid: job.uid, sessionId: job.sessionId, activeRunId: job.runId }, { $set: { activeRunId: null } })
			.catch(swallow("loop", "op"));
	}
}

const JANITOR_MS = 2 * 60_000;

export async function startWorker(): Promise<void> {
	log("started — polling cloud_jobs");
	// Janitor sweep on a timer — the endpoint isn't self-invoking.
	setInterval(() => {
		void getDb()
			.then((db) => import("../handlers/misc").then((m) => m.runJanitorSweep(db)))
			.then((r) => r.killed + r.paused > 0 && log(`janitor: ${JSON.stringify(r)}`))
			.catch(swallow("loop", "op"));
	}, JANITOR_MS);
	for (;;) {
		try {
			await sweepStaleClaims();
			const job = await claimNext();
			if (!job) {
				await new Promise((r) => setTimeout(r, POLL_MS));
				continue;
			}
			log(`claimed job ${job.jobId} (run ${job.runId}, mode ${job.mode})`);
			await runJob(job);
		} catch (error) {
			log(`poll error: ${error instanceof Error ? error.message : error}`);
			await new Promise((r) => setTimeout(r, POLL_MS * 5));
		}
	}
}


