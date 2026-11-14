import { createHash } from "node:crypto";

/** A building bake older than this is assumed dead (worker crashed mid-bake). */
export const STALE_BUILD_MS = 40 * 60_000;
/** After a failed bake, wait this long before trying again. */
export const FAILED_COOLDOWN_MS = 60 * 60_000;
/** A ready snapshot older than this is re-baked. */
export const READY_TTL_MS = 24 * 3600_000;

/** Dependency manifests that decide whether the install state is reusable. */
export const DEP_FILES = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "package.json"];

export interface WarmDoc {
	status?: string;
	snapshotId?: string;
	depsOk?: boolean;
	updatedAt?: Date | string;
	startedAt?: Date | string;
	failedAt?: Date | string;
}

export type WarmDecision =
	| { action: "use"; snapshotId: string }
	| { action: "bake" }
	| { action: "wait" }
	| { action: "skip"; reason: "cooldown" | "deps_failed" | "building" };

const ms = (t: Date | string | undefined): number | undefined => {
	if (!t) return undefined;
	const n = new Date(t).getTime();
	return Number.isNaN(n) ? undefined : n;
};

/**
 * Decides what a warm-boot lookup should do with the stored repo_templates doc.
 * Pure: the caller supplies `now`, so every state can be tested without a DB.
 */
export function decideWarm(doc: WarmDoc | null | undefined, now: number): WarmDecision {
	if (!doc) return { action: "bake" };
	if (doc.status === "building") {
		const started = ms(doc.startedAt) ?? ms(doc.updatedAt);
		// Fresh build in flight: let it finish. Stale: the worker died, rebake.
		if (started !== undefined && now - started < STALE_BUILD_MS) return { action: "wait" };
		return { action: "bake" };
	}
	if (doc.status === "failed") {
		const failed = ms(doc.failedAt) ?? ms(doc.updatedAt);
		if (failed !== undefined && now - failed < FAILED_COOLDOWN_MS) return { action: "skip", reason: "cooldown" };
		return { action: "bake" };
	}
	if (doc.status === "ready" && typeof doc.snapshotId === "string") {
		// A ready snapshot whose install failed is not a usable warm state.
		if (doc.depsOk === false) return { action: "skip", reason: "deps_failed" };
		const updated = ms(doc.updatedAt);
		if (updated !== undefined && now - updated < READY_TTL_MS) return { action: "use", snapshotId: doc.snapshotId };
		return { action: "bake" };
	}
	return { action: "bake" };
}

/** Short stable fingerprint of the dependency manifests' contents. */
export function depsFingerprint(files: Record<string, string | undefined>): string {
	const h = createHash("sha256");
	for (const name of DEP_FILES) h.update(`${name}\0${files[name] ?? "<missing>"}\0`);
	return h.digest("hex").slice(0, 16);
}

/** Last ~800 chars of install output, for logs. Keeps the failure reason visible. */
export function stderrTail(text: string): string {
	return text.trim().slice(-800);
}
