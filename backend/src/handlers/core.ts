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
	try {
		const user = await getAuth(adminApp()).getUser(uid);
		return json({ uid, email: user.email ?? null, name: user.displayName ?? null });
	} catch {
		return json({ uid });
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

/** GET /api/usage */
export async function usage(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
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
	return json({ calls });
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
	};
	const calls = Array.isArray(body.calls) ? body.calls.slice(0, 500) : [];
	const runs = Array.isArray(body.runs) ? body.runs : [];
	const events = Array.isArray(body.events) ? body.events : [];
	const prs = Array.isArray(body.prs) ? body.prs : [];
	const sandboxes = Array.isArray(body.sandboxes) ? body.sandboxes : [];
	if (calls.length + runs.length + events.length + prs.length + sandboxes.length === 0) return json({ inserted: 0 });
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
	return json({ inserted, runs: runs.length, events: events.length, prs: prs.length, sandboxes: sandboxes.length });
}

export { resolveApiKey };
