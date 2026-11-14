import { randomUUID } from "node:crypto";
import { authenticate } from "../lib/apiKeys";
import { FLAGS, flag } from "../lib/flags";
import { swallow } from "../lib/log";
import { getDb } from "../lib/mongo";
import { json } from "../routes";
import { IMAGE_RECIPES } from "../worker/imageRecipes";
import { loadUserSettings } from "../worker/settings";
import { getProvider, type ProviderCreds } from "../../../src/sandbox/provider";

/** GET /api/templates — baked images + provider templates + recipes + flags. */
export async function listTemplates(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const bakes = await db
		.collection("image_bakes")
		.find({ uid })
		.sort({ bakedAt: -1 })
		.limit(20)
		.toArray();
	// Provider catalog is best-effort — no E2B key configured still lists bakes.
	let templates: { id: string; names: string[]; public: boolean }[] = [];
	const settings = await loadUserSettings(db, uid).catch(swallow("templates", "op", null));
	if (settings) {
		const provider = getProvider("e2b");
		const creds: ProviderCreds = { secrets: settings.secrets, data: settings.data };
		if (!provider.validate(creds) && provider.listTemplates)
			templates = await provider.listTemplates(creds).catch(swallow("templates", "op", []));
	}
	return json({
		bakes,
		templates,
		recipes: Object.entries(IMAGE_RECIPES).map(([key, r]) => ({ key, imageName: r.imageName })),
		flags: { templateBuildApi: await flag(db, { uid }, FLAGS.templateBuildApi) },
	});
}

/** POST /api/templates/bake {recipe} — enqueue a named-snapshot bake job. */
export async function bakeTemplate(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const body = (await req.json().catch(() => ({}))) as { recipe?: string };
	const recipe = IMAGE_RECIPES[String(body.recipe ?? "")];
	if (!recipe) return json({ error: "unknown_recipe" }, { status: 400 });
	const db = await getDb();
	// One bake per image at a time — a queued/running job for it wins.
	const busy = await db.collection("cloud_jobs").findOne({ uid, kind: "bake", recipe: String(body.recipe), status: { $in: ["queued", "claimed", "running"] } });
	if (busy) return json({ ok: true, jobId: busy.jobId, already: true });
	const jobId = `bake-${randomUUID()}`;
	const now = new Date();
	await db.collection("cloud_jobs").insertOne({ jobId, uid, kind: "bake", recipe: String(body.recipe), status: "queued", createdAt: now });
	await db
		.collection("image_bakes")
		.updateOne(
			{ uid, name: recipe.imageName, kind: "bake" },
			{ $set: { status: "baking", recipe: String(body.recipe), jobId, startedAt: now }, $setOnInsert: { createdAt: now } },
			{ upsert: true },
		);
	return json({ ok: true, jobId });
}

/** DELETE /api/templates/:name — remove image_bakes docs for the name plus
 *  their provider artifacts. Snapshots and API-built templates share E2B's
 *  DELETE /templates/{id} endpoint, so snapshotId and templateId clean up the
 *  same way — each doc owns exactly one of them. */
export async function deleteTemplate(req: Request, p: Record<string, string>): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	const docs = await db.collection("image_bakes").find({ uid, name: p.name }).toArray();
	if (!docs.length) return json({ error: "not_found" }, { status: 404 });
	const ids = docs.flatMap((d) => [d.snapshotId, d.templateId].filter((x): x is string => typeof x === "string" && !!x));
	if (ids.length) {
		const settings = await loadUserSettings(db, uid).catch(swallow("templates", "op", null));
		if (settings) {
			const provider = getProvider("e2b");
			const creds: ProviderCreds = { secrets: settings.secrets, data: settings.data };
			if (!provider.validate(creds) && provider.deleteSnapshotById)
				for (const id of ids) await provider.deleteSnapshotById(id, creds).catch(swallow("templates", "op", false));
		}
	}
	await db.collection("image_bakes").deleteMany({ uid, name: p.name });
	return json({ ok: true });
}

/** POST /api/templates/build {name?} — flag-gated real E2B template build. */
export async function buildTemplate(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	if (!(await flag(db, { uid }, FLAGS.templateBuildApi))) return json({ error: "flag_off" }, { status: 403 });
	const body = (await req.json().catch(() => ({}))) as { name?: string };
	const name = String(body.name ?? "kronyx-browser").replace(/[^\w.-]+/g, "-").slice(0, 60) || "kronyx-browser";
	const busy = await db.collection("cloud_jobs").findOne({ uid, kind: "template-build", recipe: name, status: { $in: ["queued", "claimed", "running"] } });
	if (busy) return json({ ok: true, jobId: busy.jobId, already: true });
	const jobId = `build-${randomUUID()}`;
	await db.collection("cloud_jobs").insertOne({ jobId, uid, kind: "template-build", recipe: name, status: "queued", createdAt: new Date() });
	return json({ ok: true, jobId });
}
