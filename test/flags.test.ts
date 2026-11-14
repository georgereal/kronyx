import { beforeEach, describe, expect, it } from "vitest";
import { clearFlagCache, flag, type FlagDoc } from "../backend/src/lib/flags";

/** flag() only reads feature_flags.find().toArray() — a structural stub
 *  avoids a hard mongodb type dep (root and backend pin different copies). */
type DbStub = Parameters<typeof flag>[0];
const db = (docs: FlagDoc[]) =>
	({
		collection: () => ({
			find: () => ({ toArray: async () => docs }),
		}),
	}) as unknown as DbStub;

beforeEach(() => clearFlagCache());

describe("feature flags", () => {
	it("absent key → false", async () => {
		expect(await flag(db([]), { uid: "u1" }, "nope")).toBe(false);
	});

	it("disabled flag → false", async () => {
		expect(await flag(db([{ key: "f", enabled: false }]), { uid: "u1" }, "f")).toBe(false);
	});

	it("enabled with no rollout/targets → true for everyone", async () => {
		expect(await flag(db([{ key: "f", enabled: true }]), { uid: "u1" }, "f")).toBe(true);
	});

	it("enabled + rolloutPct 0 → false", async () => {
		expect(await flag(db([{ key: "f", enabled: true, rolloutPct: 0 }]), { uid: "u1" }, "f")).toBe(false);
	});

	it("enabled + rolloutPct 100 → true", async () => {
		expect(await flag(db([{ key: "f", enabled: true, rolloutPct: 100 }]), { uid: "u1" }, "f")).toBe(true);
	});

	it("targeted uid → true", async () => {
		const doc: FlagDoc = { key: "f", enabled: true, targets: { uids: ["u1"] } };
		expect(await flag(db([doc]), { uid: "u1" }, "f")).toBe(true);
	});

	it("targeted repo → true", async () => {
		const doc: FlagDoc = { key: "f", enabled: true, targets: { repos: ["o/r"] } };
		expect(await flag(db([doc]), { uid: "u1", repo: "o/r" }, "f")).toBe(true);
	});

	it("targets exist but nothing matches → false (no default rollout)", async () => {
		const doc: FlagDoc = { key: "f", enabled: true, targets: { uids: ["other"] } };
		expect(await flag(db([doc]), { uid: "u1" }, "f")).toBe(false);
	});

	it("targeted miss still honors rolloutPct", async () => {
		const doc: FlagDoc = { key: "f", enabled: true, targets: { uids: ["other"] }, rolloutPct: 100 };
		expect(await flag(db([doc]), { uid: "u1" }, "f")).toBe(true);
	});

	it("partial rollout is deterministic per uid", async () => {
		const doc: FlagDoc = { key: "f", enabled: true, rolloutPct: 50 };
		const a = await flag(db([doc]), { uid: "u-stable" }, "f");
		clearFlagCache();
		const b = await flag(db([doc]), { uid: "u-stable" }, "f");
		expect(a).toBe(b);
	});

	it("50% rollout splits a uid population", async () => {
		const doc: FlagDoc = { key: "f", enabled: true, rolloutPct: 50 };
		const d = db([doc]);
		const yes = await Promise.all(Array.from({ length: 40 }, (_, i) => flag(d, { uid: `u${i}` }, "f")));
		expect(yes.some(Boolean)).toBe(true);
		expect(yes.every(Boolean)).toBe(false);
	});

	it("cache: a doc flip is invisible until clearFlagCache", async () => {
		let docs: FlagDoc[] = [{ key: "f", enabled: true }];
		const d = {
			collection: () => ({ find: () => ({ toArray: async () => docs }) }),
		} as unknown as DbStub;
		expect(await flag(d, { uid: "u1" }, "f")).toBe(true);
		docs = [{ key: "f", enabled: false }]; // new doc objects; cached map keeps the old
		expect(await flag(d, { uid: "u1" }, "f")).toBe(true); // cached
		clearFlagCache();
		expect(await flag(d, { uid: "u1" }, "f")).toBe(false);
	});
});
