import { createHash, randomUUID } from "node:crypto";
import { authenticate } from "../lib/apiKeys";
import { FLAGS, flagOff } from "../lib/flags";
import { swallow } from "../lib/log";
import { getDb } from "../lib/mongo";
import { json } from "../routes";
import { IMAGE_RECIPES } from "../worker/imageRecipes";
import { catalogPart, llmRecipe, mergeParts, scanRepo, scanResult, STACK_CATALOG, toDockerfile, type StackPart } from "../worker/recipeGen";

const EMITTER_KEYS = new Set(STACK_CATALOG.map((c) => c.key));
import { installationToken } from "../lib/githubApp";
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
	const repoTemplates = await db
		.collection("repo_templates")
		.find({ uid })
		.project({ key: 1, repo: 1, status: 1, depsOk: 1, snapshotId: 1, updatedAt: 1, error: 1, template: 1, baseTemplate: 1 })
		.limit(50)
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
		repoTemplates,
		templates,
		recipes: Object.entries(IMAGE_RECIPES).map(([key, r]) => ({
			key,
			imageName: r.imageName,
			base: r.base ?? "stock e2b",
			tools: r.tools ?? [],
			description: r.description ?? "",
		})),
		flags: { templateBuildApi: !(await flagOff(db, FLAGS.templateBuildApi)) },
	});
}

/** POST /api/templates/map {repo, template|null} — bind a durable template to
 *  a repo. Pure repo_templates master data — no rebake. `template: null`
 *  unbinds. Sessions on the repo then prefer this image below warm snapshots
 *  and above session/LLM/settings defaults. */
export async function mapTemplate(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const body = (await req.json().catch(() => ({}))) as { repo?: string; template?: string | null };
	const repo = /^[\w.-]+\/[\w.-]+$/.test(String(body.repo)) ? String(body.repo) : null;
	if (!repo) return json({ error: "repo must be owner/name" }, { status: 400 });
	const name = body.template == null || body.template === "" ? null : String(body.template).trim();
	if (name !== null && !/^[\w./:-]{1,80}$/.test(name)) return json({ error: "invalid template name" }, { status: 400 });
	const db = await getDb();
	const key = createHash("sha256").update(`${uid}:${repo}`).digest("hex").slice(0, 16);
	const now = new Date();
	await db
		.collection("repo_templates")
		.updateOne(
			{ key },
			name === null
				? { $unset: { template: "" }, $set: { uid, repo, updatedAt: now }, $setOnInsert: { createdAt: now } }
				: { $set: { uid, repo, template: name, updatedAt: now }, $setOnInsert: { createdAt: now } },
			{ upsert: true },
		)
		.catch(swallow("templates", "op"));
	return json({ ok: true, key, repo, template: name });
}

/** POST /api/templates/bake {recipe} — enqueue a named-snapshot bake job. */
export async function bakeTemplate(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const body = (await req.json().catch(() => ({}))) as {
		recipe?: string;
		name?: string;
		commands?: string;
		verify?: string;
		timeoutMin?: number;
		repo?: string;
		installationId?: number;
		includeRepo?: boolean;
		description?: string;
		defaultForRepo?: string;
	};
	// Two call shapes: {recipe: builtinKey} or a custom {name, commands, verify?}
	// from the Templates wizard. Same job either way — custom recipes ride on
	// the job doc so bakeImage needs no schema lookup.
	let recipe: { imageName: string; commands: string; verify?: string; timeoutMs?: number } | undefined;
	let recipeLabel = String(body.recipe ?? "");
	if (body.commands) {
		const name = String(body.name ?? "").trim().toLowerCase();
		if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(name)) return json({ error: "invalid_name" }, { status: 400 });
		const commands = String(body.commands).slice(0, 8000).trim();
		if (!commands) return json({ error: "empty_recipe" }, { status: 400 });
		recipe = {
			imageName: name,
			commands,
			verify: body.verify ? String(body.verify).slice(0, 1000) : undefined,
			timeoutMs: Math.min(Math.max(Number(body.timeoutMin) || 20, 5), 45) * 60_000,
		};
		recipeLabel = "custom";
	} else {
		recipe = IMAGE_RECIPES[String(body.recipe ?? "")];
		if (!recipe) return json({ error: "unknown_recipe" }, { status: 400 });
	}
	const db = await getDb();
	// One bake per image at a time — a queued/running job for it wins.
	const busy = await db.collection("cloud_jobs").findOne({
		uid,
		status: { $in: ["queued", "claimed", "running"] },
		$or: [
			{ kind: "bake", imageName: recipe.imageName },
			{ kind: "template-build", recipe: recipe.imageName },
		],
	});
	if (busy) return json({ ok: true, jobId: busy.jobId, already: true });
	const jobId = `bake-${randomUUID()}`;
	const now = new Date();
	const repo = body.includeRepo && /^[\w.-]+\/[\w.-]+$/.test(String(body.repo)) ? String(body.repo) : undefined;

	// Repo → template binding: designate this image as the repo's base so
	// sessions on it boot the toolchain (and warm bakes build on top of it).
	const bindRepo = /^[\w.-]+\/[\w.-]+$/.test(String(body.defaultForRepo)) ? String(body.defaultForRepo) : undefined;
	if (bindRepo) {
		const key = createHash("sha256").update(`${uid}:${bindRepo}`).digest("hex").slice(0, 16);
		await db
			.collection("repo_templates")
			.updateOne({ key }, { $set: { uid, repo: bindRepo, template: recipe.imageName, updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true })
			.catch(swallow("templates", "op"));
	}

	// Non-repo templates → durable E2B template build (default-on; snapshot
	// bake remains the fallback when the flag is explicitly disabled).
	if (!repo && !(await flagOff(db, FLAGS.templateBuildApi))) {
		const dockerfile = toDockerfile(recipe.commands, recipe.verify);
		await db.collection("cloud_jobs").insertOne({
			jobId, uid, kind: "template-build", recipe: recipe.imageName, dockerfile,
			status: "queued", createdAt: now,
		});
		await db
			.collection("image_bakes")
			.updateOne(
				{ uid, name: recipe.imageName, kind: "api-build" },
				{
					$set: {
						status: "building", recipe: recipeLabel, jobId, startedAt: now,
						source: recipeLabel === "custom" ? "custom" : "builtin",
						description: String(body.description ?? "").slice(0, 300) || undefined,
						commands: recipe.commands, verify: recipe.verify, dockerfile,
					},
					$setOnInsert: { createdAt: now },
				},
				{ upsert: true },
			);
		return json({ ok: true, jobId, durable: true });
	}

	await db.collection("cloud_jobs").insertOne({
		jobId, uid, kind: "bake", recipe: recipeLabel, imageName: recipe.imageName,
		customRecipe: recipeLabel === "custom" ? recipe : undefined,
		repo, installationId: repo ? body.installationId : undefined,
		status: "queued", createdAt: now,
	});
	if (repo) {
		const key = createHash("sha256").update(`${uid}:${repo}`).digest("hex").slice(0, 16);
		await db
			.collection("repo_templates")
			.updateOne({ key }, { $set: { status: "building", uid, repo, startedAt: now, updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true })
			.catch(swallow("templates", "op"));
	}
	await db
		.collection("image_bakes")
		.updateOne(
			{ uid, name: recipe.imageName, kind: "bake" },
			{
				$set: { status: "baking", recipe: recipeLabel, jobId, startedAt: now, source: recipeLabel === "custom" ? "custom" : "builtin", description: String(body.description ?? "").slice(0, 300) || undefined, commands: recipe.commands, verify: recipe.verify },
				$setOnInsert: { createdAt: now },
			},
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
	// Repo warm snapshots share the same template namespace under the
	// `kronyx-repo-<key>` name — deleting one must drop its repo_templates doc
	// and provider artifact too, or both are orphaned.
	const repoKey = /^kronyx-repo-(\w+)$/.exec(p.name)?.[1];
	const repoDocs = repoKey ? await db.collection("repo_templates").find({ uid, key: repoKey }).toArray() : [];
	if (!docs.length && !repoDocs.length) return json({ error: "not_found" }, { status: 404 });
	const ids = docs
		.flatMap((d) => [d.snapshotId, d.templateId])
		.concat(repoDocs.map((d) => d.snapshotId))
		.filter((x): x is string => typeof x === "string" && !!x);
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
	if (repoDocs.length) await db.collection("repo_templates").deleteMany({ uid, key: repoKey });
	return json({ ok: true });
}

/**
 * POST /api/templates/scan — two modes:
 *  {repo, installationId?, ref?}  — tree-scan a repo (monorepo-aware), return
 *    per-directory detected projects + a merged draft recipe (rules first,
 *    LLM fallback when nothing is recognized anywhere).
 *  {stacks: ["node",…]}           — catalog mode, no repo: expected manifest
 *    files per stack + a merged generic recipe.
 */
export async function scanTemplate(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const body = (await req.json().catch(() => ({}))) as {
		repo?: string;
		installationId?: number;
		ref?: string;
		stacks?: string[];
		versions?: Record<string, string>;
	};
	const versions = body && typeof body.versions === "object" && body.versions
		? Object.fromEntries(Object.entries(body.versions).filter(([k, v]) => EMITTER_KEYS.has(k) && /^[\d.]{1,10}$/.test(String(v))).map(([k, v]) => [k, String(v)]))
		: undefined;

	// Catalog mode — stack picker.
	if (Array.isArray(body.stacks) && body.stacks.length) {
		const stacks = body.stacks.filter((s) => typeof s === "string" && EMITTER_KEYS.has(s)).slice(0, 6);
		const parts = stacks.map((s) => catalogPart(s, versions)).filter((p): p is StackPart => !!p);
		if (!parts.length) return json({ error: "unknown_stacks" }, { status: 400 });
		const merged = mergeParts(parts);
		return json({
			source: "catalog",
			expected: Object.fromEntries(STACK_CATALOG.filter((c) => stacks.includes(c.key)).map((c) => [c.key, c.expects])),
			recipe: {
				name: `${stacks.slice(0, 2).join("-")}-env`,
				commands: merged.commands,
				verify: merged.verify || undefined,
				tools: merged.tools,
				description: `${merged.tools.join(" + ")} environment.`,
			},
		});
	}

	const repo = String(body.repo ?? "");
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "invalid_repo" }, { status: 400 });
	const ref = /^[\w./-]{1,120}$/.test(String(body.ref ?? "")) ? String(body.ref) : undefined;
	const token = typeof body.installationId === "number" ? await installationToken(body.installationId).catch(swallow("templates", "op", "")) : "";
	const byDir = await scanRepo(repo, token, ref);
	const { projects, recipe: ruled } = scanResult(repo, byDir, versions);
	const found = projects.flatMap((p) => p.found.map((f) => (p.dir ? `${p.dir}/${f}` : f)));
	if (!found.length) return json({ found, projects: [], recipe: null, source: "none" });

	let recipe = ruled;
	if (!recipe) {
		const settings = await loadUserSettings(await getDb(), uid).catch(swallow("templates", "op", null));
		if (settings) {
			const merged = Object.assign({}, ...[...byDir.values()]);
			recipe = await llmRecipe(repo, merged, {
				baseUrl: settings.data.baseUrl as string | undefined,
				apiKey: settings.secrets.providerApiKey,
				modelId: settings.data.modelId as string | undefined,
			});
		}
	}
	return json({
		found,
		source: recipe ? (ruled ? "rules" : "llm") : "none",
		recipe,
		projects: projects.map((p) => ({
			dir: p.dir || ".", stacks: p.stacks, tools: p.tools, found: p.found, needsCustom: p.needsCustom, deps: p.deps, scripts: p.scripts,
			part: { commands: p.parts.flatMap((s) => s.commands), verify: p.parts.map((s) => s.verify).filter(Boolean).join(" && "), tools: p.tools },
		})),
	});
}

/** POST /api/templates/build {name?} — flag-gated real E2B template build. */
export async function buildTemplate(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const db = await getDb();
	if (await flagOff(db, FLAGS.templateBuildApi)) return json({ error: "flag_off" }, { status: 403 });
	const body = (await req.json().catch(() => ({}))) as { name?: string };
	const name = String(body.name ?? "kronyx-browser").replace(/[^\w.-]+/g, "-").slice(0, 60) || "kronyx-browser";
	const busy = await db.collection("cloud_jobs").findOne({ uid, kind: "template-build", recipe: name, status: { $in: ["queued", "claimed", "running"] } });
	if (busy) return json({ ok: true, jobId: busy.jobId, already: true });
	const jobId = `build-${randomUUID()}`;
	await db.collection("cloud_jobs").insertOne({ jobId, uid, kind: "template-build", recipe: name, status: "queued", createdAt: new Date() });
	return json({ ok: true, jobId });
}
