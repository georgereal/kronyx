import { authenticate } from "../lib/apiKeys";
import { getDb } from "../lib/mongo";
import { fetchModels, type ModelOption } from "../lib/models";
import { swallow } from "../lib/log";
import { json } from "../routes";
import { activeProviderCreds, loadUserSettings } from "../worker/settings";

const TTL_MS = 60 * 60_000;
const cache = new Map<string, { at: number; models: ModelOption[] }>();

/** GET /api/models/pricing — the provider's published rate card, per-1M-token USD. */
export async function modelPricing(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const settings = await loadUserSettings(db, uid).catch(swallow("models", "op", null));
	const creds = settings ? activeProviderCreds(settings) : undefined;
	if (!creds) return json({ pricing: {} });
	const { baseUrl, apiKey } = creds;
	const key = `${uid}|${baseUrl}`;
	const hit = cache.get(key);
	const models = hit && Date.now() - hit.at < TTL_MS ? hit.models : await fetchModels(baseUrl, apiKey).catch(() => [] as ModelOption[]);
	if (!hit || Date.now() - hit.at >= TTL_MS) cache.set(key, { at: Date.now(), models });
	const pricing: Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }> = {};
	for (const m of models) {
		if (!m.pricing) continue;
		pricing[m.id] = Object.fromEntries(
			Object.entries(m.pricing)
				.filter(([, v]) => typeof v === "number")
				.map(([k, v]) => [k, (v as number) * 1e6]),
		);
	}
	return json({ pricing });
}

/**
 * POST /api/models/test — live connectivity check for a provider profile.
 * Body: { name?, baseUrl, apiKey? }. A typed (unsaved) apiKey wins; otherwise
 * the stored secret for the profile name is used. Reports HTTP status + model
 * count so the settings page can show a real pass/fail, not just "no models".
 */
export async function testProvider(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const body = (await req.json().catch(() => ({}))) as { name?: string; baseUrl?: string; apiKey?: string };
	const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
	if (!baseUrl) return json({ error: "baseUrl required" }, { status: 400 });
	let key = typeof body.apiKey === "string" && body.apiKey ? body.apiKey : undefined;
	if (key === undefined && body.name) {
		const db = await getDb();
		const doc = await db.collection("users").findOne({ _id: uid as never }, { projection: { "settings.secrets": 1 } });
		const secrets = (doc?.settings?.secrets ?? {}) as Record<string, string>;
		key = secrets[`profile.apiKey.${body.name}`] ?? secrets[body.name] ?? "";
	}
	const t0 = Date.now();
	try {
		const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
			headers: key ? { Authorization: `Bearer ${key}` } : {},
			signal: AbortSignal.timeout(10_000),
		});
		const ms = Date.now() - t0;
		if (!res.ok) return json({ ok: false, status: res.status, error: `HTTP ${res.status}`, ms });
		const b = (await res.json()) as { data?: unknown[]; models?: unknown[] };
		return json({ ok: true, status: res.status, models: (b.data ?? b.models ?? []).length, keySet: !!key, ms });
	} catch (e) {
		return json({ ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 });
	}
}
