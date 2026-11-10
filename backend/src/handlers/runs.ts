import { authenticate } from "../lib/apiKeys";
import { getDb } from "../lib/mongo";
import { json } from "../routes";

async function e2bKey(uid: string): Promise<string | undefined> {
	const db = await getDb();
	const doc = await db
		.collection<{ _id: string; settings?: { secrets?: { e2bApiKey?: string } } }>("users")
		.findOne({ _id: uid });
	return doc?.settings?.secrets?.e2bApiKey ?? process.env.E2B_API_KEY;
}

/** GET /api/runs */
export async function listRuns(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const runs = await db.collection("runs").find({ uid }).sort({ at: -1 }).limit(50).toArray();
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
	}
	return json({ ok: true });
}

/** GET /api/sandboxes */
export async function listSandboxes(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const history = await db.collection("sandboxes").find({ uid }).sort({ at: -1 }).limit(300).toArray();
	const key = await e2bKey(uid);
	let live: { sandboxId: string; templateId?: string; state?: string; startedAt?: string }[] = [];
	if (key) {
		const res = await fetch("https://api.e2b.app/v2/sandboxes", {
			headers: { "X-API-KEY": key },
			signal: AbortSignal.timeout(10_000),
		}).catch(() => undefined);
		if (res?.ok) live = (await res.json()) as typeof live;
	}
	return json({ live, history: history.map((h) => ({ ...h, _id: undefined })), liveEnabled: !!key });
}

/** DELETE /api/sandboxes/:id — manual kill; row marked dead, session pointer cleared. */
export async function deleteSandbox(req: Request, p: Record<string, string>): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const k = await e2bKey(uid);
	if (!k) return json({ error: "no_e2b_key" }, { status: 400 });
	const res = await fetch(`https://api.e2b.app/sandboxes/${encodeURIComponent(p.id)}`, {
		method: "DELETE",
		headers: { "X-API-KEY": k },
	});
	if (!res.ok && res.status !== 404) return json({ ok: false }, { status: 502 });
	const db = await getDb();
	await db
		.collection("sandboxes")
		.updateOne({ uid, sandboxId: p.id }, { $set: { state: "dead", reason: "manual", killPending: false, deadAt: new Date() } });
	await db.collection("sessions").updateMany({ uid, sandboxId: p.id }, { $set: { sandboxId: null, cloned: false } });
	return json({ ok: true });
}

/** POST /api/sandboxes/:id/pause — manual pause. */
export async function pauseSandbox(req: Request, p: Record<string, string>): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const k = await e2bKey(uid);
	if (!k) return json({ error: "no_e2b_key" }, { status: 400 });
	const res = await fetch(`https://api.e2b.app/sandboxes/${encodeURIComponent(p.id)}/pause`, {
		method: "POST",
		headers: { "X-API-KEY": k },
	});
	if (!res.ok && res.status !== 404) return json({ ok: false }, { status: 502 });
	const db = await getDb();
	await db
		.collection("sandboxes")
		.updateOne({ uid, sandboxId: p.id }, { $set: { state: "paused", reason: "manual", at: new Date() } });
	return json({ ok: true });
}
