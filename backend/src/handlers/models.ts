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
