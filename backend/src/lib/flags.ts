import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { swallow } from "../../../src/lib/errlog";

/**
 * LaunchDarkly-style feature flags, Mongo-backed — dynamic gating for risky
 * sandbox behavior (fork slices, warm templates, disk resumes) without a
 * redeploy. A flag doc: { key, enabled, rolloutPct, targets: { uids, repos,
 * templates } }. Evaluation is deterministic: enabled && (targeted or bucketed
 * by sha256(key+uid) % 100 < rolloutPct). Cached 60s in-process.
 *
 * Flags are managed directly in Mongo (no UI v1). Unknown/absent keys → false.
 */
export interface FlagDoc {
	key: string;
	enabled?: boolean;
	rolloutPct?: number; // 0-100
	targets?: { uids?: string[]; repos?: string[]; templates?: string[] };
	updatedAt?: Date;
}

export interface FlagCtx {
	uid?: string;
	repo?: string;
	template?: string;
	sessionId?: string;
}

let cache: { docs: Map<string, FlagDoc>; at: number } | undefined;

async function loadFlags(db: Db): Promise<Map<string, FlagDoc>> {
	if (cache && Date.now() - cache.at < 60_000) return cache.docs;
	const docs = await db
		.collection("feature_flags")
		.find({})
		.toArray()
		.catch(swallow("flags", "op", [] as FlagDoc[]));
	const map = new Map<string, FlagDoc>();
	for (const d of docs as unknown as (FlagDoc & { _id: unknown })[]) map.set(d.key, d);
	cache = { docs: map, at: Date.now() };
	return map;
}

const bucket = (key: string, salt: string) =>
	parseInt(createHash("sha256").update(`${key}:${salt}`).digest("hex").slice(0, 8), 16) % 100;

/** Evaluate `key` for `ctx`; absent/disabled → false. */
export async function flag(db: Db, ctx: FlagCtx, key: string): Promise<boolean> {
	const doc = (await loadFlags(db)).get(key);
	if (!doc?.enabled) return false;
	const t = doc.targets;
	if (t) {
		if (ctx.uid && t.uids?.includes(ctx.uid)) return true;
		if (ctx.repo && t.repos?.includes(ctx.repo)) return true;
		if (ctx.template && t.templates?.includes(ctx.template)) return true;
		// Targets exist but nothing matched — fall through to rollout so a
		// targeted flag can still have a percentage rollout for everyone else.
	}
	const pct = doc.rolloutPct ?? (t ? 0 : 100);
	if (pct >= 100) return true;
	if (pct <= 0) return false;
	return bucket(key, ctx.uid ?? ctx.sessionId ?? "anon") < pct;
}

/** Flag keys used by the worker sandbox lifecycle. */
export const FLAGS = {
	sandboxAutoPause: "sandboxAutoPause",
	sandboxDiskResume: "sandboxDiskResume",
	sliceFork: "sliceFork",
	warmTemplates: "warmTemplates",
	snapshotCheckpoints: "snapshotCheckpoints",
	templateBuildApi: "templateBuildApi",
} as const;

/** Test/debug helper: drop the in-memory cache. */
export function clearFlagCache(): void {
	cache = undefined;
}
