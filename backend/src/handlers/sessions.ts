import { randomUUID } from "node:crypto";
import { errlog, swallow } from "../lib/log";
import { authenticate } from "../lib/apiKeys";
import { verifyIdToken } from "../lib/firebaseAdmin";
import { getDb } from "../lib/mongo";
import { installationRepos, installationToken, listInstallations } from "../lib/githubApp";
import { getProvider, providers } from "../../../src/sandbox/provider";
import { githubPat, loadUserSettings, resolveProvider } from "../worker/settings";
import { json } from "../routes";

/** GET /api/sessions */
export async function listSessions(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const sessions = await db.collection("sessions").find({ uid }).sort({ updatedAt: -1 }).limit(50).toArray();
	const ids = sessions.map((s) => s.sessionId);
	const runs = await db
		.collection("runs")
		.find({ uid, sessionId: { $in: ids } })
		.sort({ createdAt: -1 })
		.project({ sessionId: 1, status: 1 })
		.toArray();
	const lastStatus = new Map<string, string>();
	for (const r of runs) {
		const sid = String(r.sessionId);
		if (!lastStatus.has(sid)) lastStatus.set(sid, String(r.status ?? ""));
	}
	return json({ sessions: sessions.map((s) => ({ ...s, _id: undefined, lastStatus: lastStatus.get(String(s.sessionId)) ?? null })) });
}

/** POST /api/sessions */
export async function createSession(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const body = (await req.json().catch(swallow("sessions", "op", ({})))) as {
		repo?: string;
		base?: string;
		mode?: string;
		modelId?: string;
		profile?: string;
		title?: string;
		template?: string;
		extraRepos?: string[];
		securityProfile?: string;
		provider?: string;
		startRef?: string;
	};
	const repo = String(body.repo ?? "").trim();
	const mode = ["ask", "plan", "agent"].includes(body.mode ?? "") ? body.mode! : "agent";
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
		if (mode !== "ask") return json({ error: "repo must be owner/name" }, { status: 400 });
	}
	const extraRepos = (body.extraRepos ?? []).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r) && r !== repo).slice(0, 5);
	const sessionId = randomUUID();
	let installationId: number | undefined;
	let base = body.base ?? "";
	const installationIds: Record<string, number> = {};
	try {
		for (const inst of await listInstallations()) {
			const repos = await installationRepos(inst.id);
			for (const r of repos) installationIds[r.fullName] = inst.id;
			const hit = repos.find((r) => r.fullName === repo);
			if (hit) {
				installationId = inst.id;
				if (!base) base = hit.defaultBranch;
			}
		}
	} catch (e) {
		errlog("sessions", "listInstallations — repo detection skipped", e);
	}
	const db = await getDb();
	const userDoc = await db
		.collection<{ settings?: { data?: { sandboxProvider?: string; e2bTemplate?: string; modelDefaults?: Record<string, string> } } }>("users")
		.findOne({ _id: uid as never }, { projection: { "settings.data.sandboxProvider": 1, "settings.data.e2bTemplate": 1, "settings.data.modelDefaults": 1 } })
		.catch(swallow("sessions", "op", null));
	const requested = String(body.provider ?? userDoc?.settings?.data?.sandboxProvider ?? "e2b");
	const provider = requested in providers ? requested : "e2b";
	// Composer template wins; otherwise the user's default applies. When both
	// are unset the worker's LLM pick chooses from the live E2B template list.
	const template = body.template?.slice(0, 80) || userDoc?.settings?.data?.e2bTemplate?.slice(0, 80) || null;
	const defaultModel = userDoc?.settings?.data?.modelDefaults?.[mode] ?? null;
	// startRef: the ref to check out at clone time (feature branch or
	// pull/<n>/head); base stays the rebase/PR target.
	const startRef = /^[\w./-]{1,200}$/.test(String(body.startRef ?? "")) ? String(body.startRef) : "";
	const doc = {
		uid,
		sessionId,
		title: body.title?.slice(0, 120) || repo || "New session",
		repo: repo || null,
		base: base || "main",
		startRef: startRef || base || "main",
		branch: null,
		sandboxId: null,
		installationId: installationId ?? null,
		extraRepos: extraRepos.map((r) => ({ repo: r, installationId: installationIds[r] ?? null })),
		template,
		provider,
		securityProfile: body.securityProfile === "bypass" ? "bypass" : body.securityProfile === "controlled" ? "controlled" : "agent",
		cloned: false,
		mode,
		modelId: body.modelId ?? defaultModel,
		profile: body.profile ?? null,
		prUrl: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	await db.collection("sessions").insertOne(doc);
	return json({ session: { ...doc, _id: undefined } });
}

/** GET /api/sessions/:id */
export async function getSession(req: Request, p: Record<string, string>): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const [session, runs, plans] = await Promise.all([
		db.collection("sessions").findOne({ uid, sessionId: p.id }),
		db.collection("runs").find({ uid, sessionId: p.id }).sort({ createdAt: 1 }).limit(100).toArray(),
		db.collection("plans").find({ uid, sessionId: p.id }).sort({ createdAt: -1 }).limit(20).toArray(),
	]);
	if (!session) return json({ error: "not_found" }, { status: 404 });
	return json({
		session: { ...session, _id: undefined },
		runs: runs.map((r) => ({ ...r, _id: undefined })),
		plans: plans.map((pl) => ({ ...pl, _id: undefined, markdown: undefined })),
	});
}

/** POST /api/sessions/:id/messages */
export async function postMessage(req: Request, p: Record<string, string>): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const body = (await req.json().catch(swallow("sessions", "op", ({})))) as {
		task?: string;
		mode?: string;
		modelId?: string;
		profile?: string;
		attachmentIds?: string[];
		planSlug?: string;
	};
	const task = String(body.task ?? "").trim();
	if (!task && !body.planSlug) return json({ error: "task required" }, { status: 400 });
	const db = await getDb();
	const session = await db.collection("sessions").findOne({ uid, sessionId: p.id });
	if (!session) return json({ error: "not_found" }, { status: 404 });
	const mode = ["ask", "plan", "agent"].includes(body.mode ?? "") ? body.mode! : (session.mode ?? "agent");
	const runId = `web-${randomUUID()}`;
	const now = new Date();
	const doc = {
		uid,
		runId,
		sessionId: p.id,
		task,
		mode,
		modelId: body.modelId ?? session.modelId ?? null,
		profile: body.profile ?? session.profile ?? null,
		attachmentIds: (body.attachmentIds ?? []).slice(0, 20),
		planSlug: body.planSlug ?? null,
		status: "queued",
		at: now.getTime(),
		createdAt: now,
		updatedAt: now,
	};
	await db.collection("runs").insertOne(doc);
	await db.collection("cloud_jobs").insertOne({
		jobId: runId,
		uid,
		sessionId: p.id,
		runId,
		task,
		mode,
		modelId: doc.modelId,
		profile: doc.profile,
		attachmentIds: doc.attachmentIds,
		planSlug: doc.planSlug,
		kind: "run",
		status: "queued",
		createdAt: now,
	});
	await db
		.collection("sessions")
		.updateOne({ uid, sessionId: p.id }, { $set: { updatedAt: now, lastTask: task.slice(0, 120) } });
	// First event lands immediately — the timeline shows "Queued" instead of blank.
	await db.collection("run_events").insertOne({
		uid, runId, sessionId: p.id, seq: 1,
		event: { type: "cloud-status", text: "Queued — waiting for a worker" },
		ingestedAt: now,
	});
	return json({ runId });
}

/** POST /api/sessions/:id/plans/:slug/push */
export async function pushPlan(req: Request, p: Record<string, string>): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const [session, plan] = await Promise.all([
		db.collection("sessions").findOne({ uid, sessionId: p.id }),
		db.collection("plans").findOne({ uid, sessionId: p.id, slug: p.slug }),
	]);
	if (!session || !plan) return json({ error: "not_found" }, { status: 404 });
	const runId = `web-${randomUUID()}`;
	const now = new Date();
	await db.collection("runs").insertOne({
		uid,
		runId,
		sessionId: p.id,
		task: `Push plan ${p.slug} to branch`,
		mode: "agent",
		status: "queued",
		at: now.getTime(),
		createdAt: now,
		updatedAt: now,
	});
	await db.collection("cloud_jobs").insertOne({
		jobId: runId,
		uid,
		sessionId: p.id,
		runId,
		task: `Push plan ${p.slug}`,
		mode: "agent",
		kind: "push-plan",
		planSlug: p.slug,
		status: "queued",
		createdAt: now,
	});
	return json({ runId });
}

/** POST /api/sessions/:id/pr — queue an open-pr job on the session branch. */
export async function openSessionPr(req: Request, p: Record<string, string>): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const session = await db.collection("sessions").findOne({ uid, sessionId: p.id });
	if (!session?.branch) return json({ error: "no_branch" }, { status: 400 });
	const runId = `web-${randomUUID()}`;
	const now = new Date();
	await db.collection("runs").insertOne({
		uid, runId, sessionId: p.id, task: `Open PR for ${session.branch}`, mode: "agent",
		status: "queued", at: now.getTime(), createdAt: now, updatedAt: now,
	});
	await db.collection("cloud_jobs").insertOne({
		jobId: runId, uid, sessionId: p.id, runId,
		task: `Open PR for ${session.branch}`, mode: "agent", kind: "open-pr",
		status: "queued", createdAt: now,
	});
	// Don't set activeRunId — the worker's session lock needs it null to claim.
	await db.collection("sessions").updateOne({ uid, sessionId: p.id }, { $set: { updatedAt: now } });
	await db.collection("run_events").insertOne({
		uid, runId, sessionId: p.id, seq: 1,
		event: { type: "cloud-status", text: `PR run queued for ${session.branch}` },
		ingestedAt: now,
	});
	return json({ runId });
}

/**
 * GET /api/sessions/:id/usage — session-scoped usage aggregate for the
 * context meter + history modal: per-request points per run, compaction /
 * handoff markers from run_events, session totals, context window.
 */
export async function sessionUsage(req: Request, p: Record<string, string>): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const rows = await db
		.collection("usage_events")
		.find({ uid, session: p.id, kind: "chat" })
		.sort({ at: 1 })
		.project({ runId: 1, task: 1, model: 1, tokensIn: 1, tokensOut: 1, cacheRead: 1, cacheWrite: 1, reasoningTokens: 1, costUsd: 1, billedCostUsd: 1, iteration: 1, contextMsgs: 1, contextWindow: 1, at: 1 })
		.limit(20_000)
		.toArray();
	const compaction = await db
		.collection("run_events")
		.find({ uid, sessionId: p.id, "event.meta.kind": "context_compaction" })
		.sort({ seq: 1 })
		.project({ runId: 1, seq: 1, "event.text": 1, "event.meta": 1, ingestedAt: 1 })
		.limit(500)
		.toArray();
	const handoffs = await db
		.collection("run_events")
		.find({ uid, sessionId: p.id, "event.type": "info", "event.text": /^New task — carried/ })
		.sort({ seq: 1 })
		.project({ runId: 1, "event.text": 1, ingestedAt: 1 })
		.limit(200)
		.toArray();

	const runMap = new Map<string, { runId: string; task: string; model: string; points: unknown[] }>();
	let contextWindow = 0;
	const totals = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, costUsd: 0 };
	for (const r of rows) {
		const runId = String(r.runId ?? "");
		let run = runMap.get(runId);
		if (!run) runMap.set(runId, (run = { runId, task: String(r.task ?? ""), model: String(r.model ?? ""), points: [] }));
		if (r.task && !run.task) run.task = String(r.task);
		if (r.model && !run.model) run.model = String(r.model);
		contextWindow = Number(r.contextWindow) || contextWindow;
		run.points.push({
			iteration: r.iteration ?? null,
			requestTokens: r.tokensIn ?? 0,
			tokensOut: r.tokensOut ?? 0,
			contextMsgs: r.contextMsgs ?? null,
			cacheRead: r.cacheRead ?? 0,
			cacheWrite: r.cacheWrite ?? 0,
			reasoningTokens: r.reasoningTokens ?? 0,
			costUsd: r.billedCostUsd ?? r.costUsd ?? null,
			at: r.at,
		});
		totals.tokensIn += Number(r.tokensIn ?? 0);
		totals.tokensOut += Number(r.tokensOut ?? 0);
		totals.cacheRead += Number(r.cacheRead ?? 0);
		totals.cacheWrite += Number(r.cacheWrite ?? 0);
		totals.reasoningTokens += Number(r.reasoningTokens ?? 0);
		totals.costUsd += Number(r.billedCostUsd ?? r.costUsd ?? 0);
	}
	return json({
		contextWindow: contextWindow || null,
		runs: [...runMap.values()],
		compactions: compaction.map((c) => ({ runId: c.runId, text: c.event?.text ?? "", meta: c.event?.meta ?? {}, at: c.ingestedAt })),
		handoffs: handoffs.map((h) => ({ runId: h.runId, text: h.event?.text ?? "", at: h.ingestedAt })),
		totals,
	});
}

/** POST /api/sessions/:id/preflight — readiness checks for the session header. */
export async function preflight(req: Request, p: Record<string, string>): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const session = await db.collection("sessions").findOne({ uid, sessionId: p.id });
	if (!session) return json({ error: "not_found" }, { status: 404 });
	const settings = (await loadUserSettings(db, uid).catch(swallow("sessions", "op", null))) ?? { data: {}, secrets: {} };

	const checks: { name: string; ok: boolean; detail: string }[] = [];

	// GitHub auth source
	const token = session.installationId ? await installationToken(session.installationId).catch(swallow("sessions", "op", "")) : githubPat(settings);
	checks.push({ name: "GitHub auth", ok: !!token, detail: session.installationId ? `installation ${session.installationId}` : token ? "PAT" : "no token" });

	// Repo access
	if (session.repo) {
		const res = token
			? await fetch(`https://api.github.com/repos/${session.repo}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } }).catch(swallow("sessions", "op", null))
			: null;
		checks.push({ name: "Repo", ok: !!res && res.status === 200, detail: res?.status === 200 ? session.repo : res ? `${session.repo} — HTTP ${res.status}` : `${session.repo} — unreachable` });
	} else {
		checks.push({ name: "Repo", ok: false, detail: "none connected" });
	}

	// Sandbox
	const sbxRow = await db
		.collection("sandboxes")
		.find({ uid, sessionId: p.id, state: { $nin: ["killed", "dead", "terminated"] } })
		.sort({ createdAt: -1 })
		.limit(1)
		.next();
	checks.push({
		name: "Sandbox",
		ok: !!sbxRow && sbxRow.state !== "unreachable",
		detail: sbxRow ? `${sbxRow.sandboxId} (${sbxRow.state})` : "none — will create on first run",
	});

	// Provider
	const res = resolveProvider(settings, {});
	checks.push({ name: "Model", ok: !res.error, detail: res.error ?? `${res.settings!.modelId} · ${res.settings!.profile ?? "default"}` });

	// Sandbox provider credentials
	const sbxProvider = getProvider(typeof session.provider === "string" ? session.provider : "e2b");
	const credErr = sbxProvider.validate({ secrets: settings.secrets, data: settings.data });
	checks.push({ name: `Sandbox (${sbxProvider.name})`, ok: !credErr, detail: credErr ?? "credentials set" });

	const ready = checks.every((c) => c.ok || (c.name === "Sandbox" && !sbxRow));
	return json({ ready, checks });
}

/** GET /api/sessions/:id/events?run=<runId>&after=<seq>[&stream=1] */
export async function sessionEvents(req: Request, p: Record<string, string>): Promise<Response> {
	const url = new URL(req.url);
	const uid = (await authenticate(req)) ?? (await verifyIdToken(url.searchParams.get("token") ?? ""));
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const after = Number(url.searchParams.get("after")) || 0;
	const before = Number(url.searchParams.get("before")) || 0;
	const stream = url.searchParams.get("stream") === "1";
	const db = await getDb();
	const runId =
		url.searchParams.get("run") ??
		((
			await db
				.collection("runs")
				.find({ uid, sessionId: p.id })
				.sort({ createdAt: -1 })
				.limit(1)
				.next()
		)?.runId as string | undefined);
	if (!runId) return json({ run: null, events: [] });

	const tail = async (seq: number) =>
		db
			.collection("run_events")
			.find({ uid, runId, ...(seq ? { seq: { $gt: seq } } : {}) })
			.sort({ seq: 1 })
			.limit(500)
			.toArray();
	// Reverse paging: `before` → the 2000 events just older; absent → newest window.
	const back = async (seq: number) => {
		const docs = await db
			.collection("run_events")
			.find({ uid, runId, ...(seq ? { seq: { $lt: seq } } : {}) })
			.sort({ seq: -1 })
			.limit(2000)
			.toArray();
		return docs.reverse();
	};
	const runDoc = () => db.collection("runs").findOne({ uid, runId });
	const prDoc = () => db.collection("prs").findOne({ uid, runId });

	if (!stream) {
		const [run, pr, events] = await Promise.all([
			runDoc(),
			prDoc(),
			before ? back(before) : after ? tail(after) : back(0),
		]);
		if (!run && events.length === 0) return json({ run: null, events: [] });
		return json({
			run: run ? { ...run, _id: undefined } : null,
			pr: pr ? { ...pr, _id: undefined } : null,
			events: events.map((e) => ({ seq: e.seq, event: e.event })),
			hasMore: events.length === 2000 && Number(events[0]?.seq) > 1,
		});
	}

	// SSE: replay then tail every 1s until the run reaches a terminal state.
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			let seq = after;
			const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
			try {
				const run = await runDoc();
				send({ type: "meta", run: run ? { ...run, _id: undefined } : null, pr: (await prDoc()) ?? null });
				for (;;) {
					const events = await tail(seq);
					for (const e of events) {
						seq = Math.max(seq, e.seq as number);
						send({ type: "event", seq: e.seq, event: e.event });
					}
					const r = await runDoc();
					const status = String(r?.status ?? "");
					if (["completed", "failed", "stopped"].includes(status)) {
						send({ type: "meta", run: r ? { ...r, _id: undefined } : null, pr: (await prDoc()) ?? null });
						break;
					}
					controller.enqueue(encoder.encode(`: ping\n\n`));
					await new Promise((r2) => setTimeout(r2, 1000));
				}
			} catch {
				// client disconnected or db error — end stream
			}
			controller.close();
		},
	});
	return new Response(body, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			// Defeat proxy buffering (Next rewrite / nginx) — without this events
			// arrive in one flush when the stream ends.
			"x-accel-buffering": "no",
		},
	});
}
