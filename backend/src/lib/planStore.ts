import { promises as fs } from "node:fs";
import path from "node:path";
import type { Db } from "mongodb";
import { swallow } from "./log";

/**
 * Plans live as files on the backend server — Mongo stays only as the legacy
 * read fallback for docs written before the move. Layout:
 *   <root>/<uid>/<sessionId>/<slug>.md      — the plan markdown
 *   <root>/<uid>/<sessionId>/<slug>.json    — { runId, createdAt, updatedAt }
 */
const ROOT = process.env.PLANS_DIR
	? path.resolve(process.env.PLANS_DIR)
	: path.join(process.cwd(), "data", "plans");

const cleanSlug = (slug: string): string => slug.replace(/[^\w-]+/g, "-").slice(0, 60) || "plan";

const dir = (uid: string, sessionId: string): string => path.join(ROOT, uid, sessionId);

interface PlanMeta {
	runId?: string;
	createdAt?: string;
	updatedAt?: string;
}

export interface StoredPlan {
	slug: string;
	markdown: string;
	runId?: string;
	createdAt?: string;
	updatedAt?: string;
}

export async function savePlanFile(uid: string, sessionId: string, slug: string, markdown: string, runId?: string): Promise<void> {
	const s = cleanSlug(slug);
	const d = dir(uid, sessionId);
	await fs.mkdir(d, { recursive: true });
	const metaPath = path.join(d, `${s}.json`);
	const prev = await fs.readFile(metaPath, "utf8").then((t) => JSON.parse(t) as PlanMeta).catch(() => ({} as PlanMeta));
	const now = new Date().toISOString();
	const meta: PlanMeta = { runId: runId ?? prev.runId, createdAt: prev.createdAt ?? now, updatedAt: now };
	await fs.writeFile(path.join(d, `${s}.md`), markdown, "utf8");
	await fs.writeFile(metaPath, JSON.stringify(meta), "utf8");
}

export async function readPlanFile(uid: string, sessionId: string, slug: string): Promise<StoredPlan | null> {
	const s = cleanSlug(slug);
	const d = dir(uid, sessionId);
	const markdown = await fs.readFile(path.join(d, `${s}.md`), "utf8").catch(() => null);
	if (markdown === null) return null;
	const meta = await fs.readFile(path.join(d, `${s}.json`), "utf8").then((t) => JSON.parse(t) as PlanMeta).catch(() => ({} as PlanMeta));
	return { slug: s, markdown, ...meta };
}

/** File-backed plans first, then legacy Mongo docs for slugs not on disk. */
export async function listPlans(db: Db, uid: string, sessionId: string, limit = 20): Promise<{ slug: string; runId?: string; updatedAt?: string }[]> {
	const d = dir(uid, sessionId);
	const names = await fs.readdir(d).catch(() => [] as string[]);
	const out: { slug: string; runId?: string; updatedAt?: string }[] = [];
	for (const name of names.filter((n) => n.endsWith(".md"))) {
		const slug = name.slice(0, -3);
		const meta = await fs.readFile(path.join(d, `${slug}.json`), "utf8").then((t) => JSON.parse(t) as PlanMeta).catch(() => ({} as PlanMeta));
		out.push({ slug, runId: meta.runId, updatedAt: meta.updatedAt });
	}
	const seen = new Set(out.map((p) => p.slug));
	const legacy = await db
		.collection("plans")
		.find({ uid, sessionId }, { projection: { slug: 1, runId: 1, updatedAt: 1 } })
		.toArray()
		.catch(swallow("planStore", "op", []));
	for (const p of legacy) {
		const slug = String(p.slug ?? "");
		if (slug && !seen.has(slug)) out.push({ slug, runId: p.runId ? String(p.runId) : undefined, updatedAt: p.updatedAt?.toISOString?.() });
	}
	out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
	return out.slice(0, limit);
}

/** Single plan: file first, legacy Mongo doc as fallback. */
export async function loadPlan(db: Db, uid: string, sessionId: string, slug: string): Promise<StoredPlan | null> {
	const file = await readPlanFile(uid, sessionId, slug).catch(() => null);
	if (file) return file;
	const doc = await db
		.collection("plans")
		.findOne({ uid, sessionId, slug: cleanSlug(slug) })
		.catch(swallow("planStore", "op", null));
	if (!doc?.markdown) return null;
	return {
		slug: String(doc.slug),
		markdown: String(doc.markdown),
		runId: doc.runId ? String(doc.runId) : undefined,
		createdAt: doc.createdAt?.toISOString?.(),
		updatedAt: doc.updatedAt?.toISOString?.(),
	};
}
