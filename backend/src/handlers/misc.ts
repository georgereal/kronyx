import { randomUUID } from "node:crypto";
import { swallow } from "../lib/log";
import type { Db } from "mongodb";
import { getProvider, providers, type ProviderCreds } from "../../../src/sandbox/provider";
import { authenticate } from "../lib/apiKeys";
import { getDb } from "../lib/mongo";
import { fetchModels } from "../lib/models";
import { recordSandboxEvent } from "../lib/sandboxEvents";
import { json } from "../routes";

const MAX_FILE = 4 * 1024 * 1024;
const MAX_TOTAL = 16 * 1024 * 1024;
const INLINE_LIMIT = 20 * 1024;
const TEXT_EXT = /\.(txt|md|markdown|ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|py|go|rs|java|c|cc|cpp|h|hpp|cs|rb|php|sh|css|html|xml|sql|env|ini|cfg|log)$/i;

/** POST /api/attachments — multipart uploads. */
export async function attachments(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const form = await req.formData().catch(swallow("misc", "op", null));
	if (!form) return json({ error: "multipart body required" }, { status: 400 });
	const sessionId = String(form.get("sessionId") ?? "");
	const files = form.getAll("files").filter((f): f is File => f instanceof File);
	if (!files.length) return json({ error: "no files" }, { status: 400 });
	if (files.length > 20) return json({ error: "max 20 files" }, { status: 400 });
	let total = 0;
	const docs = [];
	for (const f of files) {
		if (f.size > MAX_FILE) return json({ error: `${f.name} exceeds 4 MB` }, { status: 400 });
		total += f.size;
		if (total > MAX_TOTAL) return json({ error: "attachments exceed 16 MB total" }, { status: 400 });
		const buf = Buffer.from(await f.arrayBuffer());
		const isText = (f.type.startsWith("text/") || TEXT_EXT.test(f.name)) && !buf.includes(0);
		docs.push({
			uid,
			sessionId: sessionId || null,
			attachmentId: randomUUID(),
			filename: f.name.slice(0, 200),
			mime: f.type || "application/octet-stream",
			size: f.size,
			text: isText && buf.length <= INLINE_LIMIT ? buf.toString("utf8") : undefined,
			data: buf,
			createdAt: new Date(),
		});
	}
	const db = await getDb();
	await db.collection("attachments").insertMany(docs);
	return json({
		attachments: docs.map((d) => ({ attachmentId: d.attachmentId, filename: d.filename, size: d.size, inline: !!d.text })),
	});
}

/** GET /api/models */
export async function models(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const doc = await db
		.collection<{
			_id: string;
			settings?: {
				data?: { profiles?: { name?: string; baseUrl?: string; enabled?: boolean }[]; activeProfile?: string; baseUrl?: string };
				secrets?: Record<string, string>;
			};
		}>("users")
		.findOne({ _id: uid });
	const data = doc?.settings?.data ?? {};
	const secrets = doc?.settings?.secrets ?? {};
	const profiles = (data.profiles ?? []).filter((p) => p.baseUrl && p.enabled !== false);
	const keyFor = (name?: string) =>
		name ? (secrets[`profile.apiKey.${name}`] ?? secrets[name] ?? "") : (secrets.providerApiKey ?? "");
	// Catalog per provider profile, in parallel. Ungrouped fallback = flat provider.*.
	const groups = await Promise.all(
		profiles.map(async (p) => ({
			profile: p.name ?? "default",
			active: p.name === (data.activeProfile ?? profiles[0]?.name),
			models: await fetchModels(p.baseUrl!, keyFor(p.name)),
		})),
	);
	if (!groups.length && data.baseUrl) {
		groups.push({ profile: "default", active: true, models: await fetchModels(data.baseUrl, keyFor()) });
	}
	return json({ groups, activeProfile: (data.activeProfile ?? profiles[0]?.name) || null });
}

/** GET /api/plans/:id?session=&slug= */
export async function getPlan(req: Request, p: Record<string, string>): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const url = new URL(req.url);
	const sessionId = url.searchParams.get("session") ?? "";
	const slug = url.searchParams.get("slug") ?? "";
	const db = await getDb();
	const plan = await db.collection("plans").findOne(p.id !== "_" ? { uid, planId: p.id } : { uid, sessionId, slug });
	if (!plan) return json({ error: "not_found" }, { status: 404 });
	return json({ plan: { ...plan, _id: undefined } });
}

const MAX_MINUTES = Number(process.env.JANITOR_MAX_SANDBOX_MINUTES || 60);

/** GET /api/cron/janitor — kills orphaned E2B sandboxes past their TTL. */
export async function janitor(req: Request): Promise<Response> {
	if (process.env.CRON_SECRET && req.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
		return json({ error: "unauthorized" }, { status: 401 });
	}
	const db = await getDb();
	return json(await runJanitorSweep(db));
}

/** Shared janitor sweep — also run by the worker on a timer. */
export async function runJanitorSweep(db: Db): Promise<{ users: number; killed: number; paused: number }> {
	const users: { _id: string; settings?: { secrets?: Record<string, string>; data?: Record<string, unknown> } }[] = await db
		.collection("users")
		.find({ "settings.secrets": { $exists: true } })
		.toArray() as unknown as { _id: string; settings?: { secrets?: Record<string, string>; data?: Record<string, unknown> } }[];
	const cutoff = Date.now() - MAX_MINUTES * 60_000;
	const SESSION_IDLE_KILL_MIN = Number(process.env.SESSION_IDLE_KILL_MINUTES || 24 * 60);
	const PAUSED_KILL_MIN = Number(process.env.PAUSED_KILL_MINUTES || 48 * 60);
	const idleCutoff = new Date(Date.now() - SESSION_IDLE_KILL_MIN * 60_000);
	const pausedCutoff = new Date(Date.now() - PAUSED_KILL_MIN * 60_000);
	const credsFor = (uid: string): ProviderCreds => {
		const u = users.find((x) => x._id === uid);
		return { secrets: u?.settings?.secrets ?? {}, data: u?.settings?.data ?? {} };
	};
	const providerFor = (row: Record<string, any>) => getProvider(typeof row.provider === "string" ? row.provider : "e2b");
	const kill = async (uid: string, id: string, providerName?: string): Promise<boolean> => {
		try {
			return await getProvider(providerName).killById(id, credsFor(uid));
		} catch {
			return false;
		}
	};

	const IDLE_PAUSE_MIN = Number(process.env.SANDBOX_IDLE_PAUSE_MINUTES || 15);
	const idlePauseCutoff = new Date(Date.now() - IDLE_PAUSE_MIN * 60_000);
	let killed = 0;
	let paused = 0;
	// Idle pause — durable backstop for the in-process timer (dies on restarts).
	const idleRows = await db
		.collection("sandboxes")
		.find({
			state: { $in: ["active", "running"] },
			$or: [{ lastActivityAt: { $lt: idlePauseCutoff } }, { lastActivityAt: { $exists: false }, at: { $lt: idlePauseCutoff } }],
		})
		.toArray();
	for (const row of idleRows) {
		const provider = providerFor(row);
		if (!provider.capabilities.pause || !provider.pauseById) continue;
		const ok = await provider.pauseById(String(row.sandboxId), credsFor(row.uid)).catch(swallow("misc", "op", false));
		if (ok) {
			await db
				.collection("sandboxes")
				.updateOne({ _id: row._id }, { $set: { state: "paused", reason: `idle-${IDLE_PAUSE_MIN}m`, at: new Date() } });
			await recordSandboxEvent(db, {
				uid: row.uid, sandboxId: String(row.sandboxId), sessionId: row.sessionId,
				provider: provider.name, event: "pause", state: "paused", reason: `idle-${IDLE_PAUSE_MIN}m`,
			});
			paused++;
		}
	}
	// Policy kills — only driven by session inactivity, paused age, or a pending
	// replacement kill. Never killed while a session is merely resting.
	const rows: Record<string, any>[] = await db
		.collection("sandboxes")
		.find({ $or: [{ killPending: true }, { state: { $in: ["active", "running", "paused"] } }] })
		.toArray();
	for (const row of rows) {
		const session = row.sessionId
			? await db.collection("sessions").findOne({ uid: row.uid, sessionId: row.sessionId })
			: null;
		const sessionIdle = !session?.updatedAt || new Date(session.updatedAt) < idleCutoff;
		const pausedLong = row.state === "paused" && row.at && new Date(row.at) < pausedCutoff;
		if (!row.killPending && !sessionIdle && !pausedLong) continue;
		const reason = row.reason ?? (row.killPending ? "unreachable" : pausedLong ? "paused-48h" : "session-idle");
		if (await kill(row.uid, String(row.sandboxId), typeof row.provider === "string" ? row.provider : undefined)) {
			console.log(`[janitor] killed ${row.sandboxId} (${reason})`);
			await db
				.collection("sandboxes")
				.updateOne({ _id: row._id }, { $set: { killPending: false, state: "dead", reason, deadAt: new Date() } });
			await recordSandboxEvent(db, {
				uid: row.uid, sandboxId: String(row.sandboxId), sessionId: row.sessionId,
				provider: typeof row.provider === "string" ? row.provider : "e2b", event: "kill", state: "dead", reason,
			});
			killed++;
		}
	}
	const knownIds = new Set(rows.map((r) => String(r.sandboxId)));
	// Orphans: live provider sandboxes we have no record of, past the base TTL.
	for (const u of users) {
		const creds: ProviderCreds = { secrets: u.settings?.secrets ?? {}, data: u.settings?.data ?? {} };
		for (const p of Object.values(providers)) {
			if (!p.capabilities.orphanSweep || !p.listLive || p.validate(creds)) continue;
			const sandboxes = await p.listLive(creds).catch(swallow("misc", "op", []));
			for (const s of sandboxes) {
				const started = s.startedAt ? new Date(s.startedAt).getTime() : 0;
				if (knownIds.has(s.id) || (started && started > cutoff)) continue;
				if (await p.killById(s.id, creds).catch(swallow("misc", "op", false))) {
					console.log(`[janitor] killed orphan ${s.id} (${p.name}, orphan-ttl)`);
					await recordSandboxEvent(db, {
						uid: u._id, sandboxId: s.id, provider: p.name, event: "kill", state: "dead", reason: "orphan-ttl",
					});
					killed++;
				}
			}
		}
	}
	return { users: users.length, killed, paused };
}

/** GET/POST /api/mcp — connector stubs; execution comes later. */
export async function mcp(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	if (req.method === "GET") {
		const items = await db.collection("mcp_connectors").find({ uid }).toArray();
		return json({ connectors: items.map((c) => ({ ...c, _id: undefined })) });
	}
	if (req.method === "POST") {
		const body = (await req.json().catch(swallow("misc", "op", ({})))) as { name?: string; url?: string };
		const name = String(body.name ?? "").slice(0, 80);
		const url = String(body.url ?? "").slice(0, 300);
		if (!name || !url) return json({ error: "name and url required" }, { status: 400 });
		const id = randomUUID();
		await db.collection("mcp_connectors").insertOne({ uid, id, name, url, enabled: false, createdAt: new Date() });
		return json({ id });
	}
	return json({ error: "method" }, { status: 405 });
}
