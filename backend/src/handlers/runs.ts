import { getProvider, providers, type ProviderCreds } from "../../../src/sandbox/provider";
import { swallow } from "../lib/log";
import { authenticate } from "../lib/apiKeys";
import { getDb } from "../lib/mongo";
import { recordSandboxEvent } from "../lib/sandboxEvents";
import { buildRunReport } from "../lib/runReport";
import { json } from "../routes";

async function userCreds(uid: string): Promise<ProviderCreds> {
	const db = await getDb();
	const doc = await db
		.collection<{ _id: string; settings?: { secrets?: Record<string, string>; data?: Record<string, unknown> } }>("users")
		.findOne({ _id: uid });
	return { secrets: doc?.settings?.secrets ?? {}, data: doc?.settings?.data ?? {} };
}

/** GET /api/runs */
export async function listRuns(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	// Sub-run docs (multi-agent slices/coordinator) stay fetchable by id but
	// hidden from the flat list — the parent run represents them.
	const runs = await db.collection("runs").find({ uid, kind: { $nin: ["slice", "coordinator"] } }).sort({ at: -1 }).limit(50).toArray();
	const prs = await db.collection("prs").find({ uid }).toArray();
	const prByRun = new Map(prs.map((p) => [String(p.runId), p]));
	return json({ runs: runs.map((r) => ({ ...r, _id: undefined, pr: prByRun.get(String(r.runId)) ?? null })) });
}

/** GET /api/runs/:id?after=<seq> */
export async function getRun(req: Request, p: Record<string, string>): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const after = Number(new URL(req.url).searchParams.get("after")) || 0;
	const db = await getDb();
	const [run, pr, events] = await Promise.all([
		db.collection("runs").findOne({ uid, runId: p.id }),
		db.collection("prs").findOne({ uid, runId: p.id }),
		db.collection("run_events")
			.find({ uid, runId: p.id, ...(after ? { seq: { $gt: after } } : {}) })
			.sort({ seq: 1 })
			.limit(500)
			.toArray(),
	]);
	if (!run && events.length === 0) return json({ error: "not_found" }, { status: 404 });
	return json({
		run: run ? { ...run, _id: undefined } : null,
		pr: pr ? { ...pr, _id: undefined } : null,
		events: events.map((e) => ({ seq: e.seq, event: e.event })),
	});
}

/** GET /api/runs/:id/report — collated usage+trace JSON; builds on demand when missing. */
export async function runReport(req: Request, p: Record<string, string>): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	if (new URL(req.url).searchParams.get("refresh") !== "1") {
		const doc = await db.collection("run_reports").findOne({ uid, runId: p.id }, { projection: { _id: 0 } });
		if (doc) return json({ report: doc });
	}
	const report = await buildRunReport(db, uid, p.id);
	if (!report) return json({ error: "not_found" }, { status: 404 });
	await db
		.collection("run_reports")
		.updateOne({ uid, runId: p.id }, { $set: report }, { upsert: true })
		.catch(swallow("runs", "op"));
	return json({ report });
}

/** POST /api/runs/:id/stop */
export async function stopRun(req: Request, p: Record<string, string>): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const run = await db.collection("runs").findOne({ uid, runId: p.id });
	if (!run) return json({ error: "not_found" }, { status: 404 });
	await db.collection("runs").updateOne({ uid, runId: p.id }, { $set: { control: "stop_requested", updatedAt: new Date() } });
	// Queued jobs never read control — kill them outright + release the session.
	const job = await db.collection("cloud_jobs").findOneAndUpdate(
		{ jobId: p.id, status: "queued" },
		{ $set: { status: "stopped", finishedAt: new Date() } },
	);
	if (job) {
		await db.collection("runs").updateOne(
			{ uid, runId: p.id },
			{ $set: { status: "stopped", error: "Cancelled while queued", finishedAt: new Date(), updatedAt: new Date() } },
		);
		await db
			.collection("sessions")
			.updateOne({ uid, sessionId: run.sessionId, activeRunId: p.id }, { $set: { activeRunId: null, updatedAt: new Date() } });
	} else {
		// Claimed/running: worker's stopCheck reads `control` — show progress meanwhile.
		await db
			.collection("runs")
			.updateOne({ uid, runId: p.id, status: { $in: ["running", "claimed"] } }, { $set: { status: "stopping", updatedAt: new Date() } });
	}
	return json({ ok: true });
}

/** POST /api/runs/:id/permissions/:permId — resolves a pending worker approval. */
export async function decidePermission(req: Request, p: Record<string, string>): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const body = (await req.json().catch(() => ({}))) as { decision?: string };
	const decision = body.decision === "allow" ? "allow" : "deny";
	const db = await getDb();
	const res = await db
		.collection("runs")
		.updateOne(
			{ uid, runId: p.id, [`permissions.${p.permId}.status`]: "pending" },
			{
				$set: {
					[`permissions.${p.permId}.decision`]: decision,
					[`permissions.${p.permId}.status`]: "decided",
					[`permissions.${p.permId}.decidedAt`]: new Date(),
				},
			},
		);
	if (!res.matchedCount) return json({ error: "not_found" }, { status: 404 });
	return json({ ok: true, decision });
}

/** GET /api/sandboxes */
export async function listSandboxes(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const history = await db.collection("sandboxes").find({ uid }).sort({ at: -1 }).limit(300).toArray();
	const events = await db.collection("sandbox_events").find({ uid }).sort({ at: -1 }).limit(500).toArray();
	const creds = await userCreds(uid);
	// Per-provider config status — the UI shows "not configured" and
	// unconfigured providers are never probed.
	const providerStatus = Object.values(providers).map((p) => {
		const err = p.validate(creds);
		return err ? { name: p.name, configured: false, reason: err } : { name: p.name, configured: true };
	});
	let live: { sandboxId: string; provider?: string; startedAt?: string }[] = [];
	for (const p of Object.values(providers)) {
		if (!p.listLive || p.validate(creds)) continue;
		const items = await p.listLive(creds).catch(swallow("runs", "op", []));
		live = live.concat(items.map((s) => ({ sandboxId: s.id, provider: p.name, startedAt: s.startedAt })));
	}
	return json({
		live,
		providers: providerStatus,
		history: history.map((h) => ({ ...h, _id: undefined })),
		events: events.map((e) => ({ ...e, _id: undefined })),
		liveEnabled: true,
	});
}

/** Provider for a sandbox row (defaults to e2b for pre-provider rows). */
async function rowProvider(uid: string, id: string) {
	const db = await getDb();
	const row = await db.collection("sandboxes").findOne({ uid, sandboxId: id }, { sort: { at: -1 } });
	return { db, provider: getProvider(typeof row?.provider === "string" ? row.provider : "e2b") };
}

/** DELETE /api/sandboxes/:id — manual kill; row marked dead, session pointer cleared. */
export async function deleteSandbox(req: Request, p: Record<string, string>): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const { db, provider } = await rowProvider(uid, p.id);
	const creds = await userCreds(uid);
	const err = provider.validate(creds);
	if (err) return json({ error: "no_credentials", detail: err }, { status: 400 });
	if (!(await provider.killById(p.id, creds).catch(swallow("runs", "op", false)))) return json({ ok: false }, { status: 502 });
	await db
		.collection("sandboxes")
		.updateOne({ uid, sandboxId: p.id }, { $set: { state: "dead", reason: "manual", killPending: false, deadAt: new Date() } });
	await recordSandboxEvent(db, { uid, sandboxId: p.id, provider: provider.name, event: "kill", state: "dead", reason: "manual" });
	await db.collection("sessions").updateMany({ uid, sandboxId: p.id }, { $set: { sandboxId: null, cloned: false } });
	return json({ ok: true });
}

/** POST /api/sandboxes/:id/pause — manual pause. */
export async function pauseSandbox(req: Request, p: Record<string, string>): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const { db, provider } = await rowProvider(uid, p.id);
	if (!provider.capabilities.pause || !provider.pauseById) return json({ error: "pause_unsupported", provider: provider.name }, { status: 400 });
	const creds = await userCreds(uid);
	const err = provider.validate(creds);
	if (err) return json({ error: "no_credentials", detail: err }, { status: 400 });
	if (!(await provider.pauseById(p.id, creds).catch(swallow("runs", "op", false)))) return json({ ok: false }, { status: 502 });
	await db
		.collection("sandboxes")
		.updateOne({ uid, sandboxId: p.id }, { $set: { state: "paused", reason: "manual", at: new Date() } });
	await recordSandboxEvent(db, { uid, sandboxId: p.id, provider: provider.name, event: "pause", state: "paused", reason: "manual" });
	return json({ ok: true });
}
