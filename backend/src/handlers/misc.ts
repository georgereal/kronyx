import { randomUUID } from "node:crypto";
import { swallow } from "../lib/log";
import type { Db } from "mongodb";
import { getProvider, providers, type ProviderCreds } from "../../../src/sandbox/provider";
import { authenticate } from "../lib/apiKeys";
import { getDb } from "../lib/mongo";
import { fetchModels } from "../lib/models";
import { recordSandboxEvent } from "../lib/sandboxEvents";
import {
	REAP_SCAN_STATES,
	TERMINAL_SANDBOX_STATES,
	isOrphanedSandboxRow,
	owningSession,
	markProviderGone,
	normalizeLegacyInaccessible,
	reapSandbox,
} from "../lib/sandboxCleanup";
import { loadPlan } from "../lib/planStore";
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
				data?: { profiles?: { name?: string; baseUrl?: string; enabled?: boolean }[]; activeProfile?: string };
				secrets?: Record<string, string>;
			};
		}>("users")
		.findOne({ _id: uid });
	const data = doc?.settings?.data ?? {};
	const secrets = doc?.settings?.secrets ?? {};
	const profiles = (data.profiles ?? []).filter((p) => p.baseUrl && p.enabled !== false);
	const keyFor = (name: string) => secrets[`profile.apiKey.${name}`] ?? secrets[name] ?? "";
	// Catalog per configured provider profile, in parallel — the composer only offers providers that can run.
	const groups = await Promise.all(
		profiles.map(async (p) => ({
			profile: p.name ?? "default",
			active: p.name === data.activeProfile,
			models: await fetchModels(p.baseUrl!, keyFor(p.name ?? "")),
		})),
	);
	return json({ groups, activeProfile: data.activeProfile || null });
}

/** GET /api/plans/:id?session=&slug= */
export async function getPlan(req: Request, p: Record<string, string>): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const url = new URL(req.url);
	const sessionId = url.searchParams.get("session") ?? "";
	const slug = url.searchParams.get("slug") ?? "";
	const db = await getDb();
	const plan = p.id !== "_"
		? await db.collection("plans").findOne({ uid, planId: p.id })
		: await loadPlan(db, uid, sessionId, slug);
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
export async function runJanitorSweep(db: Db): Promise<{ users: number; killed: number; paused: number; snapshotsDeleted: number }> {
	const users: { _id: string; settings?: { secrets?: Record<string, string>; data?: Record<string, unknown> } }[] = await db
		.collection("users")
		.find({ "settings.secrets": { $exists: true } })
		.toArray() as unknown as { _id: string; settings?: { secrets?: Record<string, string>; data?: Record<string, unknown> } }[];
	const cutoff = Date.now() - MAX_MINUTES * 60_000;
	// Kill policy: a sandbox that is the session's current VM is never killed
	// for age. Idle running VMs get paused above; attached paused VMs cost no
	// compute and may be resumed months later. Reaps are only for true orphans
	// or explicit reap requests. Mere unreachability is `inaccessible`, not a
	// kill verdict. SESSION_IDLE_KILL_MINUTES / PAUSED_KILL_MINUTES are retired.
	const credsFor = (uid: string): ProviderCreds => {
		const u = users.find((x) => x._id === uid);
		return { secrets: u?.settings?.secrets ?? {}, data: u?.settings?.data ?? {} };
	};
	const providerFor = (row: Record<string, any>) => getProvider(typeof row.provider === "string" ? row.provider : "e2b");

	const IDLE_PAUSE_MIN = Number(process.env.SANDBOX_IDLE_PAUSE_MINUTES || 15);
	const idlePauseCutoff = new Date(Date.now() - IDLE_PAUSE_MIN * 60_000);
	let killed = 0;
	let paused = 0;
	// Never pause a sandbox under a live run — lastActivityAt is only a
	// heartbeat; activeRunId is the ground truth for "work in flight".
	const busySessions = new Set(
		(await db.collection("sessions").find({ activeRunId: { $ne: null } }).project({ sessionId: 1, uid: 1 }).toArray()).map(
			(s) => `${s.uid}:${s.sessionId}`,
		),
	);
	// Live runs also count as busy, so a queued/claimed/stopping run keeps its VM.
	const liveRuns = await db
		.collection("runs")
		.find({ status: { $in: ["queued", "claimed", "running", "stopping"] } }, { projection: { uid: 1, sessionId: 1 } })
		.toArray();
	for (const r of liveRuns) busySessions.add(`${r.uid}:${r.sessionId}`);
	// Idle pause — durable backstop for the in-process timer (dies on restarts).
	const idleRows = await db
		.collection("sandboxes")
		.find({
			state: { $in: ["active", "running"] },
			$or: [{ lastActivityAt: { $lt: idlePauseCutoff } }, { lastActivityAt: { $exists: false }, at: { $lt: idlePauseCutoff } }],
		})
		.toArray();
	for (const row of idleRows) {
		const owner = await owningSession(db, row);
		const ownerSessionId = typeof owner?.sessionId === "string" ? owner.sessionId : undefined;
		if (ownerSessionId && busySessions.has(`${row.uid}:${ownerSessionId}`)) continue;
		const provider = providerFor(row);
		if (!provider.capabilities.pause || !provider.pauseById) continue;
		// Verify actual provider state — the DB row can lag an in-process pause
		// (SandboxCore's idle timer pauses + records independently). Pausing an
		// already-paused VM would double-record the event.
		const info = await provider.getInfoById?.(String(row.sandboxId), credsFor(row.uid)).catch(() => null);
		if (info?.state === "paused") {
			await db.collection("sandboxes").updateOne({ _id: row._id }, { $set: { state: "paused", at: new Date() } });
			continue;
		}
		if (info?.state === "gone") {
			await markProviderGone(db, row);
			continue;
		}
		// Fresh liveness check at the moment of pause — the busy snapshot was
		// taken at sweep start and a run may have started mid-scan.
		if (ownerSessionId) {
			const live =
				(await db.collection("runs").countDocuments({ uid: row.uid, sessionId: ownerSessionId, status: { $in: ["queued", "claimed", "running", "stopping"] } })) > 0 ||
				(await db.collection("sessions").countDocuments({ uid: row.uid, sessionId: ownerSessionId, activeRunId: { $ne: null } })) > 0;
			if (live) continue;
		}
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
	// Policy reaps — true orphans or explicit reap requests only. The scan is
	// deliberately state-based: Mongo `{ sessionId: null }` also matches rows
	// where the field is missing, which previously re-scanned terminal dead rows
	// forever and appended duplicate kill events whenever DELETE 404ed.
	const rows: Record<string, any>[] = await db
		.collection("sandboxes")
		.find({
			$and: [
				{ state: { $nin: [...TERMINAL_SANDBOX_STATES] } },
				{ $or: [{ killPending: true }, { state: { $in: REAP_SCAN_STATES } }, { state: null }, { state: { $exists: false } }] },
			],
		})
		.toArray();
	for (const row of rows) {
		await normalizeLegacyInaccessible(db, row);
		const session = await owningSession(db, row);
		const attached = !!session?.sandboxId && session.sandboxId === row.sandboxId;
		// A stale quota-fallback marker must not kill a healthy attached paused
		// VM under the new policy. Orphaned paused VMs are still reaped below.
		if (row.killPending && row.reason === "quota-fallback" && row.state === "paused" && attached) {
			await db.collection("sandboxes").updateOne({ _id: row._id }, { $set: { killPending: false } });
			row.killPending = false;
		}

		const provider = providerFor(row);
		const canProbe = !!provider.getInfoById;
		const info = canProbe ? await provider.getInfoById!(String(row.sandboxId), credsFor(row.uid)).catch(() => null) : undefined;
		if (info?.state === "gone") {
			await markProviderGone(db, row);
			continue;
		}

		const orphaned = await isOrphanedSandboxRow(db, row);
		const explicitReap = !!row.killPending;
		// Inaccessibility alone is not a reap verdict: while the row is still
		// connected to a session it is retained for audit/recovery. Once it is
		// disconnected (orphaned), the normal disconnected-only cleanup rule
		// applies whether the provider-side VM is running or paused.
		if (!explicitReap && !orphaned) {
			// Resumed underneath us — refresh the row rather than treating a stale
			// paused state as truth on a later sweep.
			if (info?.state === "running" && row.state === "paused") {
				await db.collection("sandboxes").updateOne({ _id: row._id }, { $set: { state: "running", at: new Date() } });
			}
			continue;
		}
		// A probe failure is non-evidence. In particular, E2B DELETE treats 404
		// as success, so using it without a positive provider state would turn a
		// transient inventory failure into a false "killed" terminal row.
		if (canProbe && !info) continue;

		const reason = orphaned ? "orphaned" : (row.reason ?? "reap-requested");
		if (await reapSandbox(db, row, credsFor(row.uid), reason)) {
			console.log(`[janitor] killed ${row.sandboxId} (${reason})`);
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
	// Orphaned repo snapshots: `kronyx-repo-<key>` templates with no owning
	// repo_templates doc (deleted via the templates API, or the doc was lost).
	let snapshotsDeleted = 0;
	for (const u of users) {
		const creds: ProviderCreds = { secrets: u.settings?.secrets ?? {}, data: u.settings?.data ?? {} };
		const owned = new Set(
			(await db.collection("repo_templates").find({ uid: u._id }).project({ key: 1 }).toArray()).map((d) => String(d.key)),
		);
		for (const p of Object.values(providers)) {
			if (!p.listTemplates || !p.deleteSnapshotById || p.validate(creds)) continue;
			const templates = await p.listTemplates(creds).catch(swallow("misc", "op", []));
			for (const t of templates) {
				const key = t.names.map((n) => /^kronyx-repo-(\w+)$/.exec(n)?.[1]).find(Boolean);
				if (!key || owned.has(key)) continue;
				if (await p.deleteSnapshotById(t.id, creds).catch(swallow("misc", "op", false))) {
					console.log(`[janitor] deleted orphaned repo snapshot ${t.id} (${p.name})`);
					snapshotsDeleted++;
				}
			}
		}
	}
	return { users: users.length, killed, paused, snapshotsDeleted };
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
