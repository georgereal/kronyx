/**
 * Pure decision logic for the per-repo warm snapshot (repo_templates doc).
 * Kept free of DB and provider calls so the state rules can be unit-tested.
 */
import { createHash } from "node:crypto";

export const WARM_TTL_MS = 24 * 3600_000;
/** A `building` doc older than this is treated as a crashed bake and re-baked. */
export const BUILD_STALE_MS = 40 * 60_000;
/** After a failed bake, wait this long before trying again. */
export const FAIL_COOLDOWN_MS = 3600_000;

export type WarmDoc = {
	status?: string;
	snapshotId?: string;
	updatedAt?: Date;
	startedAt?: Date;
	failedAt?: Date;
	depsOk?: boolean;
	depsHash?: string;
} | null | undefined;

export type WarmDecision =
	| { action: "use"; snapshotId: string }
	| { action: "wait" }
	| { action: "skip" }
	| { action: "bake" };

const at = (d: Date | undefined): number => (d ? new Date(d).getTime() : NaN);

/**
 * Decide what a run should do with the repo's warm snapshot.
 *  - ready + fresh + deps healthy (install passed, hash recorded) → use it
 *  - building, not stale → wait (another bake is in flight)
 *  - building, stale → crashed bake, re-bake
 *  - failed inside cooldown → skip (do not start another VM)
 *  - anything else → bake
 */
export function decideWarm(doc: WarmDoc, now: number): WarmDecision {
	if (!doc) return { action: "bake" };
	if (doc.status === "ready" && typeof doc.snapshotId === "string") {
		const fresh = now - at(doc.updatedAt) < WARM_TTL_MS;
		// depsOk must be explicitly true and the hash recorded; a bake without either is unusable.
		const depsHealthy = doc.depsOk === true && !!doc.depsHash;
		if (fresh && depsHealthy) return { action: "use", snapshotId: doc.snapshotId };
		return { action: "bake" };
	}
	if (doc.status === "building") {
		const started = at(doc.startedAt ?? doc.updatedAt);
		return now - started < BUILD_STALE_MS ? { action: "wait" } : { action: "bake" };
	}
	if (doc.status === "failed") {
		const failed = at(doc.failedAt ?? doc.updatedAt);
		return now - failed < FAIL_COOLDOWN_MS ? { action: "skip" } : { action: "bake" };
	}
	return { action: "bake" };
}

/** Lockfiles and manifests that decide the installed dependency set. */
export const DEP_FILES = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "package.json"] as const;

/**
 * Fingerprint of the dependency manifests, from the concatenated file contents
 * the bake reads. Same contents → same hash; an empty read gives a distinct hash.
 */
export function depsFingerprint(concatenated: string): string {
	return createHash("sha256").update(concatenated).digest("hex").slice(0, 32);
}


