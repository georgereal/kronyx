import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { getDb } from "../lib/mongo";
import { authenticate } from "../lib/apiKeys";
import { swallow } from "../lib/log";
import { githubTask, matchFilter, renderTemplate, verifySignature, type GithubPayload } from "../lib/webhookLib";
import { json } from "../routes";

/**
 * Inbound webhooks → cloud_jobs.
 *
 * Generic rules: `POST /api/webhooks/:ruleId` with an HMAC-SHA256 signature
 * (`x-kronyx-signature: sha256=<hex>`) over the raw body. Rules bind to an
 * existing session (repo/branch/installation come with it) and render
 * `taskTemplate` with `{{dot.path}}` lookups into the payload.
 *
 * GitHub App events: `POST /api/webhooks/github` verifies
 * `X-Hub-Signature-256` against GITHUB_APP_WEBHOOK_SECRET, dedupes on
 * `X-GitHub-Delivery`, and turns `issues.labeled` ("kronyx" label) and
 * `issue_comment.created` ("@kronyx …") into agent runs on the newest
 * session for that repo.
 */

interface WebhookRule {
	ruleId: string;
	uid: string;
	sessionId: string;
	name: string;
	secret: string;
	filter?: Record<string, string>;
	taskTemplate: string;
	mode: string;
	createdAt: Date;
	lastFiredAt?: Date;
}

/** Shared enqueue: runs row + cloud_jobs row + queued run_event (same shape
 *  as sessions.postMessage, minus composer-specific session updates). */
export async function enqueueSessionRun(
	db: Db,
	opts: { uid: string; sessionId: string; task: string; mode: string; kind?: string },
): Promise<string> {
	const runId = `web-${randomUUID()}`;
	const now = new Date();
	// Webhook runs continue the session with its last explicit composer pick; no pick → the worker refuses to run.
	const selection = await db.collection("sessions").findOne({ uid: opts.uid, sessionId: opts.sessionId }, { projection: { modelId: 1, profile: 1 } });
	const modelId = (selection?.modelId as string | undefined) ?? null;
	const profile = (selection?.profile as string | undefined) ?? null;
	await db.collection("runs").insertOne({
		uid: opts.uid,
		runId,
		sessionId: opts.sessionId,
		task: opts.task,
		mode: opts.mode,
		modelId,
		profile,
		status: "queued",
		at: now.getTime(),
		createdAt: now,
		updatedAt: now,
	});
	await db.collection("cloud_jobs").insertOne({
		jobId: runId,
		uid: opts.uid,
		sessionId: opts.sessionId,
		runId,
		task: opts.task,
		mode: opts.mode,
		modelId,
		profile,
		kind: opts.kind ?? "run",
		status: "queued",
		createdAt: now,
	});
	await db.collection("sessions").updateOne(
		{ uid: opts.uid, sessionId: opts.sessionId },
		{ $set: { updatedAt: now, lastTask: opts.task.slice(0, 120), mode: opts.mode } },
	);
	await db.collection("run_events").insertOne({
		uid: opts.uid,
		runId,
		sessionId: opts.sessionId,
		seq: 1,
		event: { type: "cloud-status", text: "Queued — waiting for a worker" },
		ingestedAt: now,
	});
	return runId;
}

// ---------------------------------------------------------------------------
// Rule CRUD (authenticated)
// ---------------------------------------------------------------------------

/** POST /api/webhook-rules — creates a rule; the secret is returned once. */
export async function createRule(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const body = (await req.json().catch(swallow("webhooks", "op", ({})))) as {
		sessionId?: string;
		name?: string;
		filter?: Record<string, string>;
		taskTemplate?: string;
		mode?: string;
	};
	const sessionId = String(body.sessionId ?? "");
	if (!sessionId) return json({ error: "sessionId required" }, { status: 400 });
	const db = await getDb();
	const session = await db.collection("sessions").findOne({ uid, sessionId });
	if (!session) return json({ error: "session not_found" }, { status: 404 });
	const secret = `whsec_${randomUUID().replace(/-/g, "")}`;
	const rule: WebhookRule = {
		ruleId: `whr_${randomUUID()}`,
		uid,
		sessionId,
		name: String(body.name ?? "webhook").slice(0, 80),
		secret,
		filter: body.filter && typeof body.filter === "object" ? body.filter : undefined,
		taskTemplate: String(body.taskTemplate ?? "{{action}} event: {{repository.full_name}}").slice(0, 4000),
		mode: ["ask", "plan", "agent", "multi"].includes(body.mode ?? "") ? body.mode! : "agent",
		createdAt: new Date(),
	};
	await db.collection("webhook_rules").insertOne(rule as never);
	return json({ ruleId: rule.ruleId, secret, urlPath: `/api/webhooks/${rule.ruleId}` }, { status: 201 });
}

/** GET /api/webhook-rules?sessionId= — secrets are never re-returned. */
export async function listRules(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const sessionId = new URL(req.url).searchParams.get("sessionId") ?? "";
	const db = await getDb();
	const rules = await db
		.collection("webhook_rules")
		.find({ uid, ...(sessionId ? { sessionId } : {}) })
		.project({ secret: 0 })
		.sort({ createdAt: -1 })
		.limit(100)
		.toArray();
	return json({ rules: rules.map((r) => ({ ...r, _id: undefined })) });
}

/** DELETE /api/webhook-rules/:id */
export async function deleteRule(req: Request, p: Record<string, string>): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const res = await db.collection("webhook_rules").deleteOne({ uid, ruleId: p.id });
	return res.deletedCount ? json({ ok: true }) : json({ error: "not_found" }, { status: 404 });
}

// ---------------------------------------------------------------------------
// Firing endpoints (unauthenticated — the signature IS the auth)
// ---------------------------------------------------------------------------

/** POST /api/webhooks/:ruleId — generic HMAC-signed fire. */
export async function fireRule(req: Request, p: Record<string, string>): Promise<Response> {
	const raw = await req.text();
	const db = await getDb();
	const rule = (await db.collection("webhook_rules").findOne({ ruleId: p.ruleId })) as WebhookRule | null;
	if (!rule) return json({ error: "not_found" }, { status: 404 });
	if (!verifySignature(rule.secret, raw, req.headers.get("x-kronyx-signature"))) {
		return json({ error: "bad_signature" }, { status: 401 });
	}
	const payload = raw ? (JSON.parse(raw) as unknown) : {};
	if (!matchFilter(rule.filter, payload)) return json({ skipped: "filter" }, { status: 202 });
	const task = renderTemplate(rule.taskTemplate, payload).trim();
	if (!task) return json({ skipped: "empty_task" }, { status: 202 });
	const runId = await enqueueSessionRun(db, { uid: rule.uid, sessionId: rule.sessionId, task, mode: rule.mode, kind: "webhook" });
	await db
		.collection("webhook_rules")
		.updateOne({ ruleId: rule.ruleId }, { $set: { lastFiredAt: new Date() } })
		.catch(swallow("webhooks", "op"));
	return json({ runId });
}

/** POST /api/webhooks/github — GitHub App event receiver. */
export async function githubWebhook(req: Request): Promise<Response> {
	const secret = process.env.GITHUB_APP_WEBHOOK_SECRET ?? process.env.GITHUB_WEBHOOK_SECRET ?? "";
	if (!secret) return json({ error: "webhook_secret_unset" }, { status: 503 });
	const raw = await req.text();
	if (!verifySignature(secret, raw, req.headers.get("x-hub-signature-256"))) {
		return json({ error: "bad_signature" }, { status: 401 });
	}
	const db = await getDb();
	const delivery = req.headers.get("x-github-delivery") ?? "";
	if (delivery) {
		const seen = await db.collection("webhook_deliveries").findOne({ _id: delivery as never });
		if (seen) return json({ duplicate: true });
		await db
			.collection("webhook_deliveries")
			.insertOne({ _id: delivery as never, at: new Date() } as never)
			.catch(swallow("webhooks", "op"));
	}
	const event = req.headers.get("x-github-event") ?? "";
	const payload = (raw ? JSON.parse(raw) : {}) as GithubPayload;
	const task = githubTask(event, payload);
	if (!task) return json({ ignored: event || "unknown" }, { status: 202 });
	const repo = payload.repository?.full_name ?? "";
	if (!repo) return json({ error: "no_repo" }, { status: 400 });
	const installationId = payload.installation?.id ?? null;
	// Newest session for this repo owns the run (uid comes with it).
	const session = await db
		.collection("sessions")
		.find({ repo, ...(installationId ? { installationId } : {}) })
		.sort({ updatedAt: -1 })
		.limit(1)
		.next()
		.catch(swallow("webhooks", "op", null));
	if (!session) return json({ skipped: "no_session_for_repo" }, { status: 202 });
	const runId = await enqueueSessionRun(db, {
		uid: session.uid,
		sessionId: session.sessionId,
		task,
		mode: "agent",
		kind: "webhook",
	});
	return json({ runId, sessionId: session.sessionId });
}
