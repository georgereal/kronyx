import { errlog, swallow } from "../lib/log";
import { ObjectId } from "mongodb";
import { getAuth } from "firebase-admin/auth";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { authenticate, mintApiKey, resolveApiKey } from "../lib/apiKeys";
import { verifyRequest } from "../lib/firebaseAdmin";
import { getDb } from "../lib/mongo";
import { json } from "../routes";

function adminApp(): App {
	if (getApps().length) return getApps()[0];
	const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
	if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not set");
	return initializeApp({ credential: cert(JSON.parse(raw)) });
}

/** GET /api/me */
export async function me(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const role = await userRole(uid);
	try {
		const user = await getAuth(adminApp()).getUser(uid);
		return json({ uid, email: user.email ?? null, name: user.displayName ?? null, role });
	} catch {
		return json({ uid, role });
	}
}

/** POST /api/keys */
export async function createKey(req: Request): Promise<Response> {
	const uid = await verifyRequest(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const body = (await req.json().catch(swallow("core", "op", ({})))) as { label?: string };
	const { key, id } = await mintApiKey(uid, String(body.label ?? "").slice(0, 80));
	return json({ key, id });
}

/** GET /api/keys */
export async function listKeys(req: Request): Promise<Response> {
	const uid = await verifyRequest(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const keys = await db.collection("api_keys").find({ uid }).sort({ createdAt: -1 }).project({ hash: 0 }).toArray();
	return json({
		keys: keys.map((k) => ({
			id: k._id.toHexString(),
			label: k.label,
			masked: `${k.prefix}…`,
			createdAt: k.createdAt,
			lastUsedAt: k.lastUsedAt,
		})),
	});
}

/** DELETE /api/keys?id= */
export async function deleteKey(req: Request): Promise<Response> {
	const uid = await verifyRequest(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const id = new URL(req.url).searchParams.get("id") ?? "";
	const db = await getDb();
	await db.collection("api_keys").deleteOne({ _id: new ObjectId(id), uid });
	return json({ ok: true });
}

/** GET /api/settings */
export async function getSettings(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const doc = await db
		.collection<{ _id: string; settings?: Record<string, unknown>; devices?: Record<string, unknown> }>("users")
		.findOne({ _id: uid });
	if (!doc?.settings) return json({ error: "not_found" }, { status: 404 });
	return json({ settings: doc.settings, devices: doc.devices ?? {} });
}

/** PUT /api/settings */
export async function putSettings(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const body = (await req.json().catch(swallow("core", "op", ({})))) as {
		version?: number;
		data?: Record<string, unknown>;
		secrets?: Record<string, string | null>;
		device?: { id?: string; name?: string };
	};
	const now = new Date();
	const db = await getDb();
	const device = body.device?.id
		? { id: String(body.device.id).slice(0, 64), name: String(body.device.name ?? "").slice(0, 80) }
		: undefined;
	const set: Record<string, unknown> = {
		"settings.version": body.version ?? 1,
		"settings.updatedAt": now,
		"settings.updatedBy": device?.id ?? "unknown",
		"settings.data": body.data ?? {},
	};
	// Secrets merge over the stored map (clients send only changed keys; a
	// null value explicitly deletes). Never wholesale-replace — blank form
	// fields must not wipe synced secrets.
	if (body.secrets) {
		const doc = await db.collection<{ settings?: { secrets?: Record<string, string> } }>("users").findOne({ _id: uid as never });
		const merged = { ...(doc?.settings?.secrets ?? {}) };
		for (const [k, v] of Object.entries(body.secrets)) {
			if (v === null) delete merged[k];
			else if (v) merged[k] = v;
		}
		set["settings.secrets"] = merged;
	}
	if (device) set[`devices.${device.id}`] = { name: device.name, lastSyncAt: now };
	await db.collection<{ _id: string }>("users").updateOne({ _id: uid }, { $set: set }, { upsert: true });
	return json({ ok: true, updatedAt: now });
}

/** RBAC seed: role lives on the users doc ("admin" gates cross-user views). */
async function userRole(uid: string): Promise<string> {
	const db = await getDb();
	const doc = await db.collection("users").findOne({ _id: uid as never }, { projection: { role: 1 } });
	return typeof doc?.role === "string" ? doc.role : "user";
}

/** GET /api/usage — caller's rows; ?all=1 aggregates across users (admin only). */
export async function usage(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const url = new URL(req.url);
	const all = url.searchParams.get("all") === "1";
	if (all && (await userRole(uid)) !== "admin") return json({ error: "forbidden" }, { status: 403 });
	const filter: Record<string, unknown> = all ? {} : { uid };
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
		.project(all ? { _id: 0 } : { _id: 0, uid: 0 })
		.toArray();
	if (!all) return json({ calls });
	// Admin view: resolve uids → display names so the UI can show people, not ids.
	const users: Record<string, { name: string | null; email: string | null }> = {};
	const auth = getAuth(adminApp());
	for (const u of [...new Set(calls.map((c) => String(c.uid)).filter(Boolean))]) {
		const rec = await auth.getUser(u).catch(swallow("core", "op", null));
		users[u] = { name: rec?.displayName ?? null, email: rec?.email ?? null };
	}
	return json({ calls, users });
}

/** GET /api/compactions — context-compaction history from dedicated
 *  `compaction` run events (emitted by the worker when prepareTurn trims). */
export async function compactions(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const url = new URL(req.url);
	const filter: Record<string, unknown> = { uid, "event.type": "compaction" };
	const since = Number(url.searchParams.get("since"));
	const until = Number(url.searchParams.get("until"));
	if (since || until) {
		filter.ingestedAt = {};
		if (since) (filter.ingestedAt as Record<string, Date>).$gte = new Date(since);
		if (until) (filter.ingestedAt as Record<string, Date>).$lte = new Date(until);
	}
	const limit = Math.min(1000, Number(url.searchParams.get("limit")) || 300);
	const db = await getDb();
	const rows = await db
		.collection("run_events")
		.find(filter)
		.sort({ ingestedAt: -1 })
		.limit(limit)
		.project({ _id: 0, runId: 1, sessionId: 1, ingestedAt: 1, event: 1 })
		.toArray();
	const runIds = [...new Set(rows.map((r) => String(r.runId)))];
	const runs = await db
		.collection("runs")
		.find({ uid, runId: { $in: runIds } })
		.project({ runId: 1, task: 1, modelId: 1, status: 1 })
		.toArray();
	const runMeta = new Map(runs.map((r) => [String(r.runId), r]));
	const items = rows.map((r) => {
		const ev = (r.event ?? {}) as Record<string, unknown>;
		const run = runMeta.get(String(r.runId)) ?? {};
		return {
			at: r.ingestedAt,
			runId: r.runId,
			sessionId: r.sessionId,
			agentIndex: ev.agentIndex ?? 0,
			task: (run as { task?: string }).task,
			model: ev.model ?? (run as { modelId?: string }).modelId,
			provider: ev.provider,
			status: (run as { status?: string }).status,
			forced: ev.forced,
			soft: ev.soft,
			contextBudget: ev.contextBudget,
			contextWindow: ev.contextWindow,
			actualInputTokens: ev.actualInputTokens,
			recap: typeof ev.recap === "string" ? ev.recap.slice(0, 20_000) : undefined,
			estTokensBefore: ev.estTokensBefore,
			estTokensAfter: ev.estTokensAfter,
			stubbed: ev.stubbed,
			clamped: ev.clamped,
			superseded: ev.superseded,
			callsElided: ev.callsElided,
			reasoningPruned: ev.reasoningPruned,
			attachmentsStubbed: ev.attachmentsStubbed,
			summarized: ev.summarized,
		};
	});
	return json({ items });
}

/**
 * GET /api/memory — vector/memory telemetry from three sources:
 *  - worker `memory` run_events (vector vs fallback path, cache hits)
 *  - extension `memory_events` rows uploaded via /api/ingest
 *  - `usage_events` kind=embedding + the `memories` collection itself.
 */
export async function memory(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const url = new URL(req.url);
	const since = Number(url.searchParams.get("since"));
	const until = Number(url.searchParams.get("until"));
	const limit = Math.min(1000, Number(url.searchParams.get("limit")) || 300);
	const range: Record<string, Date> = {};
	if (since) range.$gte = new Date(since);
	if (until) range.$lte = new Date(until);
	const db = await getDb();

	// Cloud-side diagnostics: flat `memory` run_events emitted by the worker.
	const evFilter: Record<string, unknown> = { uid, "event.type": "memory" };
	if (since || until) evFilter.ingestedAt = range;
	const cloudRows = await db
		.collection("run_events")
		.find(evFilter)
		.sort({ ingestedAt: -1 })
		.limit(limit)
		.project({ _id: 0, runId: 1, sessionId: 1, ingestedAt: 1, event: 1 })
		.toArray();
	// Extension-side diagnostics: synced sqlite memory_events.
	const extFilter: Record<string, unknown> = { uid };
	if (since || until) extFilter.at = range;
	const extRows = await db
		.collection("memory_events")
		.find(extFilter)
		.sort({ at: -1 })
		.limit(limit)
		.project({ _id: 0, uid: 0 })
		.toArray();
	const runIds = [...new Set(cloudRows.map((r) => String(r.runId)))];
	const runs = await db
		.collection("runs")
		.find({ uid, runId: { $in: runIds } })
		.project({ runId: 1, task: 1 })
		.toArray();
	const taskOf = new Map(runs.map((r) => [String(r.runId), String((r as { task?: string }).task ?? "")]));

	// Historical recall: every cold-start run stores contextManifest.memoryIdsUsed
	// on its runs doc — that predates live `memory` run_events, so derive recall
	// events from it for runs that have none (deduped by runId below).
	const manifestFilter: Record<string, unknown> = { uid, "contextManifest.memoryIdsUsed.0": { $exists: true } };
	if (since || until) manifestFilter["contextManifest.builtAt"] = range;
	const manifestRuns = await db
		.collection("runs")
		.find(manifestFilter)
		.sort({ "contextManifest.builtAt": -1 })
		.limit(limit)
		.project({ runId: 1, sessionId: 1, task: 1, contextManifest: 1 })
		.toArray()
		.catch(swallow("memory", "op", [] as Record<string, unknown>[]));
	const memIds = [
		...new Set(
			manifestRuns.flatMap((r) => ((r.contextManifest as { memoryIdsUsed?: string[] })?.memoryIdsUsed ?? []).map(String)),
		),
	];
	const memDocs = memIds.length
		? await db
				.collection("memories")
				.find({ uid, memoryId: { $in: memIds } })
				.project({ memoryId: 1, content: 1, scope: 1, status: 1 })
				.toArray()
				.catch(swallow("memory", "op", [] as Record<string, unknown>[]))
		: [];
	const memById = new Map(memDocs.map((m) => [String(m.memoryId), m]));
	const liveRecallRuns = new Set(cloudRows.filter((r) => (r.event as { op?: string })?.op === "memory_recall").map((r) => String(r.runId)));
	const manifestEvents = manifestRuns
		.filter((r) => !liveRecallRuns.has(String(r.runId)))
		.map((r) => {
			const m = (r.contextManifest ?? {}) as { memoryIdsUsed?: string[]; memoryChars?: number; builtAt?: Date };
			const ids = m.memoryIdsUsed ?? [];
			return {
				at: m.builtAt,
				source: "cloud",
				op: "memory_recall",
				path: "cold-start",
				runId: r.runId,
				sessionId: r.sessionId,
				task: r.task ?? taskOf.get(String(r.runId)),
				hits: ids.length,
				chars: m.memoryChars,
				items: ids.map((id) => {
					const d = memById.get(String(id));
					return { scope: d?.scope, status: d?.status, preview: String(d?.content ?? id).slice(0, 120) };
				}),
			};
		});

	const events = [
		...manifestEvents,
		...cloudRows.map((r) => {
			const ev = (r.event ?? {}) as Record<string, unknown>;
			return { at: r.ingestedAt, source: "cloud", runId: r.runId, sessionId: r.sessionId, task: taskOf.get(String(r.runId)), ...ev };
		}),
		...extRows.map((r) => {
			const d = (r.detail ?? {}) as Record<string, unknown>;
			return { at: r.at, source: "ext", session: r.session, runId: r.runId || undefined, workspace: r.workspace, device: r.device, deviceId: r.deviceId, op: r.op, ...d };
		}),
	]
		.sort((a, b) => new Date(String(b.at)).getTime() - new Date(String(a.at)).getTime())
		.slice(0, limit);

	// Embedding-call accounting shared by both tiers.
	const usageFilter: Record<string, unknown> = { uid, kind: "embedding" };
	if (since || until) usageFilter.at = range;
	const byOp = await db
		.collection("usage_events")
		.aggregate([
			{ $match: usageFilter },
			{
				$group: {
					_id: { op: "$op", status: "$status" },
					calls: { $sum: 1 },
					tokensIn: { $sum: "$tokensIn" },
				},
			},
		])
		.toArray();
	const embedUsage: Record<string, { calls: number; tokensIn: number; failed: number }> = {};
	for (const r of byOp) {
		const op = String(r._id?.op || "other");
		const e = (embedUsage[op] ??= { calls: 0, tokensIn: 0, failed: 0 });
		e.calls += Number(r.calls) || 0;
		e.tokensIn += Number(r.tokensIn) || 0;
		if (r._id?.status === "failed") e.failed += Number(r.calls) || 0;
	}

	// The memories store itself: coverage + recency.
	const memAgg = await db
		.collection("memories")
		.aggregate([
			{ $match: { uid } },
			{
				$group: {
					_id: { status: "$status", scope: "$scope" },
					n: { $sum: 1 },
					embedded: { $sum: { $cond: [{ $ifNull: ["$embedding", false] }, 1, 0] } },
				},
			},
		])
		.toArray()
		.catch(swallow("memory", "op", [] as Record<string, unknown>[]));
	const memoryStats = { total: 0, embedded: 0, byStatus: {} as Record<string, number>, byScope: {} as Record<string, number> };
	for (const r of memAgg as { _id?: { status?: string; scope?: string }; n?: number; embedded?: number }[]) {
		const n = Number(r.n) || 0;
		memoryStats.total += n;
		memoryStats.embedded += Number(r.embedded) || 0;
		memoryStats.byStatus[r._id?.status ?? "?"] = (memoryStats.byStatus[r._id?.status ?? "?"] ?? 0) + n;
		memoryStats.byScope[r._id?.scope ?? "?"] = (memoryStats.byScope[r._id?.scope ?? "?"] ?? 0) + n;
	}
	const docs = await db
		.collection("memories")
		.find({ uid })
		.sort({ createdAt: -1 })
		.limit(50)
		.project({ _id: 0, embedding: 0 })
		.toArray()
		.catch(swallow("memory", "op", [] as Record<string, unknown>[]));

	// Atlas-side index/storage info — best effort (denied on some tiers).
	const collStats = await db
		.command({ collStats: "memories" })
		.then((s) => ({ count: s.count, size: s.size, storageSize: s.storageSize }))
		.catch(() => null);
	const searchIndexes = await db
		.collection("memories")
		.aggregate([{ $listSearchIndexes: {} }])
		.toArray()
		.then((rows) => rows.map((r) => ({ name: r.name, status: r.status, queryable: r.queryable })))
		.catch(() => null);

	return json({ events, embedUsage, memoryStats, docs, collStats, searchIndexes });
}

/**
 * GET /api/ide — IDE-tool telemetry: extension `memory_events` rows with
 * op=ide_context (per-call tool/file/latency) or op=diagnostics (per-run
 * error/warning deltas). Rows are written to local SQLite by the extension
 * and pushed here via /api/ingest.
 */
export async function ide(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const url = new URL(req.url);
	const since = Number(url.searchParams.get("since"));
	const until = Number(url.searchParams.get("until"));
	const limit = Math.min(1000, Number(url.searchParams.get("limit")) || 500);
	const filter: Record<string, unknown> = { uid, op: { $in: ["ide_context", "diagnostics"] } };
	if (since || until) {
		filter.at = {};
		if (since) (filter.at as Record<string, Date>).$gte = new Date(since);
		if (until) (filter.at as Record<string, Date>).$lte = new Date(until);
	}
	const db = await getDb();
	const rows = await db
		.collection("memory_events")
		.find(filter)
		.sort({ at: -1 })
		.limit(limit)
		.project({ _id: 0, uid: 0 })
		.toArray();
	const tools: Record<string, { calls: number; tookMs: number; results: number }> = {};
	const events = rows.map((r) => {
		const d = (r.detail ?? {}) as Record<string, unknown>;
		const tool = String(d.tool ?? r.op ?? "");
		const t = (tools[tool] ??= { calls: 0, tookMs: 0, results: 0 });
		t.calls++;
		t.tookMs += Number(d.tookMs) || 0;
		t.results += Number(d.results ?? d.edits ?? 0) || 0;
		return {
			at: r.at,
			op: r.op,
			session: r.session,
			runId: r.runId || undefined,
			workspace: r.workspace,
			device: r.device,
			deviceId: r.deviceId,
			...d,
		};
	});
	return json({ events, tools });
}

interface IncomingCall {
	clientRowId?: number;
	at?: number;
	status?: string;
	provider?: string;
	baseUrl?: string;
	model?: string;
	profile?: string;
	keyLabel?: string;
	device?: string;
	deviceId?: string;
	tokensIn?: number;
	tokensOut?: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoningTokens?: number;
	billedCostUsd?: number;
	iteration?: number;
	contextMsgs?: number;
	kind?: string;
	op?: string;
	costUsd?: number;
	durationMs?: number;
	session?: string;
	task?: string;
	workspace?: string;
	runId?: string;
}

/** POST /api/ingest — burst upload from the extension. */
export async function ingest(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const body = (await req.json().catch(swallow("core", "op", ({})))) as {
		calls?: IncomingCall[];
		runs?: Record<string, unknown>[];
		events?: { runId: string; seq: number }[];
		prs?: Record<string, unknown>[];
		sandboxes?: Record<string, unknown>[];
		memory?: Record<string, unknown>[];
	};
	const calls = Array.isArray(body.calls) ? body.calls.slice(0, 500) : [];
	const runs = Array.isArray(body.runs) ? body.runs : [];
	const events = Array.isArray(body.events) ? body.events : [];
	const prs = Array.isArray(body.prs) ? body.prs : [];
	const sandboxes = Array.isArray(body.sandboxes) ? body.sandboxes : [];
	const memory = Array.isArray(body.memory) ? body.memory.slice(0, 500) : [];
	if (calls.length + runs.length + events.length + prs.length + sandboxes.length + memory.length === 0) return json({ inserted: 0 });
	const db = await getDb();
	const docs = calls
		.filter((c) => typeof c.at === "number" && c.at > 0)
		.map((c) => ({
			uid,
			clientRowId: c.clientRowId,
			at: new Date(c.at!),
			status: c.status === "failed" ? "failed" : "ok",
			provider: c.provider ?? "",
			baseUrl: c.baseUrl ?? "",
			model: c.model ?? "",
			profile: c.profile ?? "",
			keyLabel: c.keyLabel ?? "",
			device: c.device ?? "",
			deviceId: c.deviceId ?? "",
			tokensIn: Number(c.tokensIn) || 0,
			tokensOut: Number(c.tokensOut) || 0,
			cacheRead: Number(c.cacheRead) || 0,
			cacheWrite: Number(c.cacheWrite) || 0,
			reasoningTokens: Number(c.reasoningTokens) || 0,
			billedCostUsd: typeof c.billedCostUsd === "number" ? c.billedCostUsd : null,
			iteration: typeof c.iteration === "number" ? c.iteration : null,
			contextMsgs: typeof c.contextMsgs === "number" ? c.contextMsgs : null,
			kind: c.kind ?? "chat",
			op: c.op ?? "",
			costUsd: typeof c.costUsd === "number" ? c.costUsd : null,
			durationMs: Number(c.durationMs) || 0,
			session: c.session ?? "",
			task: c.task ?? "",
			workspace: c.workspace ?? "",
			runId: c.runId ?? "",
			ingestedAt: new Date(),
		}));
	let inserted = 0;
	if (docs.length) {
		const result = await db.collection("usage_events").insertMany(docs, { ordered: false }).catch((e) => {
			const r = (e as { result?: { nInserted?: number } }).result ?? { nInserted: 0 };
			errlog("ingest", `usage_events bulk insert: ${r.nInserted ?? 0}/${docs.length} inserted`, e);
			return r;
		});
		inserted = "insertedCount" in result ? result.insertedCount : result.nInserted ?? 0;
	}
	const now = new Date();
	if (runs.length) {
		await db.collection("runs").bulkWrite(
			runs.map((r) => ({
				updateOne: {
					filter: { uid, runId: r.runId },
					update: { $set: { uid, ...r, updatedAt: now } },
					upsert: true,
				},
			})),
			{ ordered: false },
		);
	}
	if (events.length) {
		await db.collection("run_events").bulkWrite(
			events.map((e) => ({
				updateOne: {
					filter: { uid, runId: e.runId, seq: e.seq },
					update: { $setOnInsert: { uid, ...e, ingestedAt: now } },
					upsert: true,
				},
			})),
			{ ordered: false },
		);
	}
	if (prs.length) {
		await db.collection("prs").bulkWrite(
			prs.map((p) => ({
				updateOne: {
					filter: { uid, runId: p.runId },
					update: { $set: { uid, ...p, updatedAt: now } },
					upsert: true,
				},
			})),
			{ ordered: false },
		);
	}
	if (sandboxes.length) {
		const docs = sandboxes.map((s) => ({ uid, ...s, at: new Date(Number(s.at) || Date.now()), ingestedAt: now }));
		await db.collection("sandboxes").insertMany(docs, { ordered: false }).catch(swallow("core", "op"));
		await db.collection("sandbox_events").insertMany(docs, { ordered: false }).catch(swallow("core", "op"));
	}
	if (memory.length) {
		const docs = memory.map((m) => ({
			uid,
			clientRowId: m.clientRowId,
			session: m.session ?? "",
			runId: m.runId ?? "",
			at: new Date(Number(m.at) || Date.now()),
			op: m.op ?? "",
			detail: m.detail ?? {},
			device: m.device ?? "",
			deviceId: m.deviceId ?? "",
			workspace: m.workspace ?? "",
			ingestedAt: now,
		}));
		await db.collection("memory_events").insertMany(docs, { ordered: false }).catch(swallow("core", "op"));
	}
	return json({ inserted, runs: runs.length, events: events.length, prs: prs.length, sandboxes: sandboxes.length, memory: memory.length });
}

export { resolveApiKey };
