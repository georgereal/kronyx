import { describe, expect, it } from "vitest";
import {
	FAILED_COOLDOWN_MS,
	READY_TTL_MS,
	STALE_BUILD_MS,
	decideWarm,
	depsFingerprint,
	type WarmDoc,
} from "../backend/src/worker/warmState";

const NOW = 1_000_000_000_000;
const ago = (ms: number) => new Date(NOW - ms);

const ready = (over: Partial<WarmDoc> = {}): WarmDoc => ({
	status: "ready",
	snapshotId: "snap1",
	updatedAt: ago(60_000),
	...over,
});

describe("decideWarm", () => {
	it("bakes when there is no doc", () => {
		expect(decideWarm(null, NOW)).toEqual({ action: "bake" });
		expect(decideWarm(undefined, NOW)).toEqual({ action: "bake" });
	});

	it("uses a fresh ready snapshot", () => {
		expect(decideWarm(ready(), NOW)).toEqual({ action: "use", snapshotId: "snap1" });
	});

	it("rebakes a stale ready snapshot", () => {
		expect(decideWarm(ready({ updatedAt: ago(READY_TTL_MS + 1) }), NOW)).toEqual({ action: "bake" });
	});

	it("rebakes when the stored depsHash differs from the live one", () => {
		expect(decideWarm(ready({ depsHash: "old" }), NOW, "new")).toEqual({ action: "bake" });
	});

	it("treats a missing stored depsHash as a mismatch", () => {
		expect(decideWarm(ready(), NOW, "new")).toEqual({ action: "bake" });
	});

	it("uses the snapshot when the live hash matches", () => {
		expect(decideWarm(ready({ depsHash: "same" }), NOW, "same")).toEqual({ action: "use", snapshotId: "snap1" });
	});

	it("uses the snapshot when the live hash cannot be fetched", () => {
		expect(decideWarm(ready({ depsHash: "any" }), NOW, undefined)).toEqual({ action: "use", snapshotId: "snap1" });
	});

	it("waits on a fresh building bake", () => {
		expect(decideWarm({ status: "building", startedAt: ago(60_000) }, NOW)).toEqual({ action: "wait" });
	});

	it("rebakes a stale building bake (dead worker)", () => {
		expect(decideWarm({ status: "building", startedAt: ago(STALE_BUILD_MS + 1) }, NOW)).toEqual({ action: "bake" });
	});

	it("falls back to updatedAt when building has no startedAt (pre-migration docs)", () => {
		expect(decideWarm({ status: "building", updatedAt: ago(60_000) }, NOW)).toEqual({ action: "wait" });
		expect(decideWarm({ status: "building", updatedAt: ago(STALE_BUILD_MS + 1) }, NOW)).toEqual({ action: "bake" });
	});

	it("skips a failed bake inside the cooldown", () => {
		expect(decideWarm({ status: "failed", failedAt: ago(60_000) }, NOW)).toEqual({ action: "skip", reason: "cooldown" });
	});

	it("rebakes a failed bake after the cooldown", () => {
		expect(decideWarm({ status: "failed", failedAt: ago(FAILED_COOLDOWN_MS + 1) }, NOW)).toEqual({ action: "bake" });
	});

	it("skips a depsOk:false snapshot inside the cooldown", () => {
		expect(decideWarm(ready({ depsOk: false, updatedAt: ago(60_000) }), NOW)).toEqual({ action: "skip", reason: "deps_failed" });
	});

	it("rebakes a depsOk:false snapshot after the cooldown", () => {
		expect(decideWarm(ready({ depsOk: false, updatedAt: ago(FAILED_COOLDOWN_MS + 1) }), NOW)).toEqual({ action: "bake" });
	});

	it("bakes for unknown status or a ready doc without snapshotId", () => {
		expect(decideWarm({ status: "weird" }, NOW)).toEqual({ action: "bake" });
		expect(decideWarm({ status: "ready" }, NOW)).toEqual({ action: "bake" });
	});
});

describe("depsFingerprint", () => {
	it("is stable and order-independent of the input keys", () => {
		const a = depsFingerprint({ "package.json": "{}", "yarn.lock": "abc" });
		const b = depsFingerprint({ "yarn.lock": "abc", "package.json": "{}" });
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{16}$/);
	});

	it("changes when a manifest changes", () => {
		expect(depsFingerprint({ "package.json": "{}" })).not.toBe(depsFingerprint({ "package.json": "{\"a\":1}" }));
	});
});
