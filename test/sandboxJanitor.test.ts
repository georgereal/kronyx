import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runJanitorSweep } from "../backend/src/handlers/misc";
import { isSandboxConcurrencyQuotaError, markInaccessible, runningQuotaCleanupCandidates } from "../backend/src/lib/sandboxCleanup";
import { providers, type SandboxProvider } from "../src/sandbox/provider";
import { e2bProvider } from "../src/sandbox/providers/e2b";

type BackendDb = Parameters<typeof runJanitorSweep>[0];
type Doc = Record<string, any>;

const getPath = (doc: Doc, path: string) => path.split(".").reduce((v, k) => (v == null ? undefined : v[k]), doc as any);
const cmp = (a: any, b: any) => (a instanceof Date ? a.getTime() : a) - (b instanceof Date ? b.getTime() : b);

function matchValue(value: any, cond: any): boolean {
	if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
		const keys = Object.keys(cond);
		if (keys.some((k) => k.startsWith("$"))) {
			if ("$in" in cond && !cond.$in.includes(value)) return false;
			if ("$nin" in cond && cond.$nin.includes(value)) return false;
			if ("$ne" in cond && (value ?? null) === cond.$ne) return false;
			if ("$exists" in cond && (value !== undefined) !== cond.$exists) return false;
			if ("$lt" in cond && !(value !== undefined && cmp(value, cond.$lt) < 0)) return false;
			return true;
		}
	}
	if (cond === null) return value == null;
	return value === cond;
}

function matches(doc: Doc, query: Doc = {}): boolean {
	for (const [key, cond] of Object.entries(query)) {
		if (key === "$and") {
			if (!(cond as Doc[]).every((q) => matches(doc, q))) return false;
		} else if (key === "$or") {
			if (!(cond as Doc[]).some((q) => matches(doc, q))) return false;
		} else if (!matchValue(getPath(doc, key), cond)) return false;
	}
	return true;
}

const applySet = (doc: Doc, set: Doc) => {
	for (const [k, v] of Object.entries(set)) {
		const parts = k.split(".");
		let cur = doc;
		for (const p of parts.slice(0, -1)) cur = cur[p] ??= {};
		cur[parts[parts.length - 1]] = v;
	}
};

function makeDb(seed: Record<string, Doc[]>) {
	const data = new Map<string, Doc[]>(Object.entries(seed).map(([k, v]) => [k, v.map((d) => ({ ...d }))]));
	const collection = (name: string) => {
		const docs = data.get(name) ?? data.set(name, []).get(name)!;
		const queryChain = (query: Doc = {}) => {
			let out = docs.filter((d) => matches(d, query));
			const chain: any = {
				project(projection: Doc) {
					out = out.map((d) => {
						const o: Doc = {};
						for (const [k, include] of Object.entries(projection)) if (include) o[k] = d[k];
						return { ...o, _id: d._id };
					});
					return chain;
				},
				sort(spec: Doc) {
					const [key, dir] = Object.entries(spec)[0] ?? [];
					if (key) out = out.slice().sort((a, b) => cmp(a[key], b[key]) * (dir === -1 ? -1 : 1));
					return chain;
				},
				limit(n: number) {
					out = out.slice(0, n);
					return chain;
				},
				async toArray() {
					return out;
				},
				async next() {
					return out[0] ?? null;
				},
			};
			return chain;
		};
		return {
			find: (query?: Doc, _opts?: any) => queryChain(query),
			findOne: async (query: Doc) => docs.find((d) => matches(d, query)) ?? null,
			countDocuments: async (query: Doc) => docs.filter((d) => matches(d, query)).length,
			insertOne: async (doc: Doc) => {
				docs.push({ ...doc, _id: doc._id ?? `${name}-${docs.length + 1}` });
				return { acknowledged: true };
			},
			updateOne: async (filter: Doc, update: Doc, opts?: Doc) => {
				let doc = docs.find((d) => matches(d, filter));
				let inserted = false;
				if (!doc && opts?.upsert) {
					doc = { ...Object.fromEntries(Object.entries(filter).filter(([, v]) => v == null || typeof v !== "object")) };
					docs.push(doc);
					inserted = true;
				}
				if (!doc) return { matchedCount: 0, modifiedCount: 0 };
				if (update.$set) applySet(doc, update.$set);
				if (inserted && update.$setOnInsert) applySet(doc, update.$setOnInsert);
				return { matchedCount: 1, modifiedCount: 1 };
			},
		};
	};
	return { db: { collection } as unknown as BackendDb, docs: (name: string) => data.get(name)! };
}

const oldProviders = { ...providers };
const states = new Map<string, "running" | "paused" | "gone" | null>();
const kills: string[] = [];
const listed: { id: string; startedAt?: string; state?: "running" | "paused" }[] = [];

const installTestProvider = () => {
	for (const key of Object.keys(providers)) delete providers[key];
	providers.testp = {
		name: "testp",
		capabilities: { pause: true, reconnect: true, orphanSweep: true, resume: true },
		secretKeys: [],
		validate: () => null,
		create: async () => { throw new Error("unused"); },
		connect: async () => null,
		pauseById: async () => true,
		killById: async (id) => {
			kills.push(id);
			return true;
		},
		getInfoById: async (id) => {
			const state = states.get(id);
			if (state === "gone") return { state: "gone" };
			if (state === "running" || state === "paused") return { state };
			return null;
		},
		listLive: async () => listed,
	} as SandboxProvider;
};

const baseSeed = (sandboxes: Doc[], sessions: Doc[] = []) => ({
	users: [{ _id: "u1", settings: { secrets: { token: "x" }, data: {} } }],
	sessions,
	runs: [] as Doc[],
	sandboxes,
	sandbox_events: [],
	repo_templates: [],
});

beforeEach(() => {
	states.clear();
	kills.length = 0;
	listed.length = 0;
	installTestProvider();
});

afterAll(() => {
	for (const key of Object.keys(providers)) delete providers[key];
	Object.assign(providers, oldProviders);
});

const row = (id: string, extra: Doc = {}) => ({
	_id: `row-${id}`,
	uid: "u1",
	sandboxId: id,
	provider: "testp",
	state: "paused",
	at: new Date(Date.now() - 10 * 24 * 60 * 60_000),
	createdAt: new Date(Date.now() - 10 * 24 * 60 * 60_000),
	...extra,
});

describe("janitor sandbox lifecycle policy", () => {
	it("never re-scans or re-kills terminal rows with missing sessionId", async () => {
		states.set("dead1", "running");
		const { db, docs } = makeDb(baseSeed([row("dead1", { state: "dead", reason: "provider-gone" })]));
		await runJanitorSweep(db);
		expect(kills).toEqual([]);
		expect(docs("sandbox_events")).toEqual([]);
	});

	it("preserves an attached paused sandbox indefinitely", async () => {
		states.set("paused1", "paused");
		const { db, docs } = makeDb(baseSeed(
			[row("paused1", { sessionId: "s1" })],
			[{ uid: "u1", sessionId: "s1", sandboxId: "paused1" }],
		));
		await runJanitorSweep(db);
		expect(kills).toEqual([]);
		expect(docs("sandboxes")[0].state).toBe("paused");
	});

	it("marks attached paused provider-gone exactly once", async () => {
		states.set("gone1", "gone");
		const seed = baseSeed(
			[row("gone1", { sessionId: "s1" })],
			[{ uid: "u1", sessionId: "s1", sandboxId: "gone1" }],
		);
		const { db, docs } = makeDb(seed);
		await runJanitorSweep(db);
		await runJanitorSweep(db);
		const sb = docs("sandboxes")[0];
		expect(sb.state).toBe("dead");
		expect(sb.reason).toBe("provider-gone");
		expect(kills).toEqual([]);
		expect(docs("sandbox_events").filter((e) => e.event === "provider-gone")).toHaveLength(1);
	});

	it("reaps an orphaned paused sandbox", async () => {
		states.set("orphan1", "paused");
		const { db, docs } = makeDb(baseSeed([row("orphan1", { sessionId: "s1" })]));
		await runJanitorSweep(db);
		expect(kills).toEqual(["orphan1"]);
		expect(docs("sandboxes")[0]).toMatchObject({ state: "dead", reason: "orphaned", killPending: false });
	});

	it("retains a session-connected inaccessible sandbox on a normal sweep", async () => {
		states.set("inacc1", "running");
		const { db, docs } = makeDb(baseSeed(
			[row("inacc1", { state: "inaccessible", sessionId: "s1" })],
			[{ uid: "u1", sessionId: "s1", sandboxId: "inacc1" }],
		));
		await runJanitorSweep(db);
		expect(kills).toEqual([]);
		expect(docs("sandboxes")[0].state).toBe("inaccessible");
	});

	it("reaps a disconnected inaccessible sandbox even when paused", async () => {
		states.set("inacc-disconnected", "paused");
		const { db, docs } = makeDb(baseSeed([row("inacc-disconnected", { state: "inaccessible", sessionId: "s1" })]));
		await runJanitorSweep(db);
		expect(kills).toEqual(["inacc-disconnected"]);
		expect(docs("sandboxes")[0]).toMatchObject({ state: "dead", reason: "orphaned" });
	});

	it("transitions inaccessible provider-gone to dead without a remote kill", async () => {
		states.set("inacc2", "gone");
		const { db, docs } = makeDb(baseSeed([row("inacc2", { state: "inaccessible" })]));
		await runJanitorSweep(db);
		expect(kills).toEqual([]);
		expect(docs("sandboxes")[0]).toMatchObject({ state: "dead", reason: "provider-gone" });
	});

	it("normalizes connected legacy replaced unreachable rows instead of killing them", async () => {
		states.set("legacy1", "running");
		const { db, docs } = makeDb(baseSeed(
			[row("legacy1", { state: "replaced", reason: "unreachable", killPending: true, sessionId: "s1" })],
			[{ uid: "u1", sessionId: "s1", sandboxId: "legacy1" }],
		));
		await runJanitorSweep(db);
		expect(kills).toEqual([]);
		expect(docs("sandboxes")[0]).toMatchObject({ state: "inaccessible", killPending: false });
	});

	it("uses the session current sandboxId, not historical row sessionId, for ownership", async () => {
		states.set("hist1", "paused");
		const { db } = makeDb(baseSeed(
			[row("hist1", { sessionId: "s1" })],
			[{ uid: "u1", sessionId: "s1", sandboxId: "current2" }],
		));
		await runJanitorSweep(db);
		expect(kills).toEqual(["hist1"]);
	});

	it("keeps legacy rows with missing state out of provider-side orphan cleanup", async () => {
		states.set("legacy-missing-state", "paused");
		listed.push({ id: "legacy-missing-state", startedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(), state: "paused" });
		const legacy: Doc = row("legacy-missing-state");
		delete legacy.state;
		delete legacy.sessionId;
		const { db } = makeDb(baseSeed(
			[legacy],
			[{ uid: "u1", sessionId: "s1", sandboxId: "legacy-missing-state" }],
		));
		await runJanitorSweep(db);
		expect(kills).toEqual([]);
	});

	it("reaps untracked provider-side running and paused orphans after the TTL", async () => {
		listed.push(
			{ id: "provider-old-run", startedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(), state: "running" },
			{ id: "provider-old-paused", startedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(), state: "paused" },
			{ id: "provider-new", startedAt: new Date().toISOString(), state: "running" },
		);
		const { db } = makeDb(baseSeed([]));
		await runJanitorSweep(db);
		expect(kills.sort()).toEqual(["provider-old-paused", "provider-old-run"]);
	});
});

describe("sandbox cleanup helpers", () => {
	it("never rewrites a terminal row as inaccessible", async () => {
		const { db, docs } = makeDb(baseSeed([row("terminal1", { state: "dead", reason: "provider-gone" })]));
		await markInaccessible(db, { uid: "u1", sandboxId: "terminal1", sessionId: "s1", provider: "testp", reason: "unreachable" });
		expect(docs("sandboxes")[0]).toMatchObject({ state: "dead", reason: "provider-gone" });
		expect(docs("sandbox_events")).toEqual([]);
	});
});

describe("quota cleanup policy", () => {
	it("classifies only explicit concurrency quota messages", () => {
		expect(isSandboxConcurrencyQuotaError(new Error("maximum number of concurrent E2B sandboxes reached"))).toBe(true);
		expect(isSandboxConcurrencyQuotaError(new Error("template not found"))).toBe(false);
		expect(isSandboxConcurrencyQuotaError(new Error("429 rate limit"))).toBe(false);
		expect(isSandboxConcurrencyQuotaError(new Error("network timeout"))).toBe(false);
	});

	it("treats old non-current rows as orphans during a live run but protects live slice forks", async () => {
		states.set("old-main", "running");
		states.set("slice-fork", "running");
		const seed = baseSeed(
			[
				row("old-main", { state: "running", sessionId: "s1" }),
				row("slice-fork", { state: "running", sessionId: "s1", reason: "slice-2-fork" }),
			],
			[{ uid: "u1", sessionId: "s1", sandboxId: "current-main" }],
		);
		seed.runs.push({ uid: "u1", sessionId: "s1", status: "running" });
		const { db } = makeDb(seed);
		const candidates = await runningQuotaCleanupCandidates(db, "u1", "testp", { secrets: {}, data: {} });
		expect(candidates.map((r) => r.sandboxId)).toEqual(["old-main"]);
	});

	it("includes legacy e2b rows with no provider field in quota candidates", async () => {
		states.set("legacy-e2b", "running");
		providers.e2b = { ...providers.testp, name: "e2b" };
		const legacy: Doc = row("legacy-e2b", { state: "running" });
		delete legacy.provider;
		const { db } = makeDb(baseSeed([legacy]));
		const candidates = await runningQuotaCleanupCandidates(db, "u1", "e2b", { secrets: {}, data: {} });
		expect(candidates.map((r) => r.sandboxId)).toEqual(["legacy-e2b"]);
	});

	it("orders inaccessible, disconnected, then oldest idle attached running VMs; paused and busy VMs are never candidates", async () => {
		states.set("inacc-run", "running");
		states.set("orphan-run", "running");
		states.set("attached-paused", "paused");
		states.set("idle-attached", "running");
		states.set("idle-attached-newer", "running");
		states.set("busy-attached", "running");
		const seed = baseSeed(
			[
				row("inacc-run", { state: "inaccessible", sessionId: "s1" }),
				row("orphan-run", { state: "running" }),
				row("attached-paused", { state: "paused", sessionId: "s1" }),
				row("idle-attached", { state: "running", sessionId: "s2", lastActivityAt: new Date(Date.now() - 5 * 60 * 60_000) }),
				row("idle-attached-newer", { state: "running", sessionId: "s4", lastActivityAt: new Date(Date.now() - 30 * 60_000) }),
				row("busy-attached", { state: "running", sessionId: "s3" }),
			],
			[
				{ uid: "u1", sessionId: "s1", sandboxId: "attached-paused" },
				{ uid: "u1", sessionId: "s2", sandboxId: "idle-attached" },
				{ uid: "u1", sessionId: "s4", sandboxId: "idle-attached-newer" },
				{ uid: "u1", sessionId: "s3", sandboxId: "busy-attached", activeRunId: "r3" },
			],
		);
		const { db } = makeDb(seed);
		const candidates = await runningQuotaCleanupCandidates(db, "u1", "testp", { secrets: {}, data: {} });
		expect(candidates.map((r) => r.sandboxId)).toEqual(["inacc-run", "orphan-run", "idle-attached", "idle-attached-newer"]);
		expect(candidates.map((r) => r.quotaAction)).toEqual(["kill", "kill", "pause", "pause"]);
	});
});

describe("e2b provider inventory", () => {
	it("listLive parses state and follows pagination", async () => {
		const calls: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (input: any) => {
			const url = String(input);
			calls.push(url);
			const page2 = url.includes("nextToken=two");
			return {
				ok: true,
				headers: { get: (name: string) => (!page2 && name.toLowerCase() === "x-next-token" ? "two" : null) },
				json: async () => page2
					? [{ sandboxID: "b", startedAt: "2025-01-02T00:00:00Z", state: "paused" }]
					: [{ sandboxID: "a", startedAt: "2025-01-01T00:00:00Z", state: "running" }],
			};
		}));
		try {
			const out = await e2bProvider.listLive!({ secrets: { e2bApiKey: "key" }, data: {} });
			expect(out).toEqual([
				{ id: "a", startedAt: "2025-01-01T00:00:00Z", state: "running" },
				{ id: "b", startedAt: "2025-01-02T00:00:00Z", state: "paused" },
			]);
			expect(calls).toHaveLength(2);
			expect(calls[1]).toContain("nextToken=two");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
