import { describe, expect, it } from "vitest";
import { providers, type SandboxHandle, type SandboxProvider } from "../src/sandbox/provider";
import { SandboxCore } from "../src/sandbox/sandboxCore";

const creds = { secrets: {}, data: {} };

const handle = (id: string): SandboxHandle => ({
	id,
	run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
	readFile: async () => "",
	writeFile: async () => {},
});

/** Register a fake provider under a unique name for one test. */
const register = (name: string, p: Partial<SandboxProvider>) => {
	providers[name] = {
		name,
		capabilities: { pause: false, reconnect: false, orphanSweep: false },
		secretKeys: [],
		validate: () => null,
		create: async () => handle("h1"),
		connect: async () => null,
		killById: async () => true,
		...p,
	} as SandboxProvider;
	return providers[name];
};

const boot = async (name: string): Promise<SandboxCore> => {
	const sbx = new SandboxCore();
	await sbx.create({ creds, provider: name });
	return sbx;
};

describe("SandboxCore lifecycle fallbacks", () => {
	it("resume returns null on providers without resume support", async () => {
		register("noLife", {});
		expect(await (await boot("noLife")).resume("x", creds)).toBeNull();
	});

	it("checkpoint returns null without snapshot support", async () => {
		register("noSnap", {});
		expect(await (await boot("noSnap")).checkpoint()).toBeNull();
	});

	it("fork returns [] without fork support", async () => {
		register("noFork", {});
		expect(await (await boot("noFork")).fork(3)).toEqual([]);
	});

	it("resume propagates memory:false (disk-only cold boot)", async () => {
		let seen: { memory?: boolean } | undefined;
		register("withResume", {
			capabilities: { pause: false, reconnect: false, orphanSweep: false, resume: true },
			resume: async (_id, _c, opts) => {
				seen = opts;
				return handle("resumed1");
			},
		});
		const sbx = await boot("withResume");
		const h = await sbx.resume("x", creds, { memory: false });
		expect(h?.id).toBe("resumed1");
		expect(seen).toEqual({ memory: false });
	});

	it("resume returns null (not throw) when the sandbox is gone", async () => {
		register("goneResume", {
			capabilities: { pause: false, reconnect: false, orphanSweep: false, resume: true },
			resume: async () => null,
		});
		expect(await (await boot("goneResume")).resume("x", creds)).toBeNull();
	});

	it("resume swallows provider throws instead of crashing the ladder", async () => {
		register("throwResume", {
			capabilities: { pause: false, reconnect: false, orphanSweep: false, resume: true },
			resume: async () => {
				throw new Error("409 guest unresponsive");
			},
		});
		expect(await (await boot("throwResume")).resume("x", creds)).toBeNull();
	});

	it("checkpoint returns the persisted snapshot id and reports lifecycle", async () => {
		register("withSnap", {
			capabilities: { pause: false, reconnect: false, orphanSweep: false, snapshot: true },
			checkpointById: async () => "snap-abc",
		});
		const sbx = await boot("withSnap");
		const events: string[] = [];
		sbx.onLifecycle = (e) => events.push(e);
		expect(await sbx.checkpoint()).toBe("snap-abc");
		expect(events).toContain("checkpoint");
	});

	it("checkpoint passes mode/name through to the provider", async () => {
		let seen: { mode?: string; name?: string } | undefined;
		register("snapOpts", {
			capabilities: { pause: false, reconnect: false, orphanSweep: false, snapshot: true },
			checkpointById: async (_id, _c, opts) => {
				seen = opts;
				return "snap-1";
			},
		});
		await (await boot("snapOpts")).checkpoint({ mode: "filesystem", name: "kronyx-wip-s1" });
		expect(seen).toEqual({ mode: "filesystem", name: "kronyx-wip-s1" });
	});

	it("deleteSnapshot delegates to the provider", async () => {
		const deleted: string[] = [];
		register("snapDel", {
			deleteSnapshotById: async (id) => {
				deleted.push(id);
				return true;
			},
		});
		const sbx = await boot("snapDel");
		expect(await sbx.deleteSnapshot("snap-old")).toBe(true);
		expect(deleted).toEqual(["snap-old"]);
	});

	it("checkpoint returns null when the provider snapshot fails", async () => {
		register("snapFail", {
			capabilities: { pause: false, reconnect: false, orphanSweep: false, snapshot: true },
			checkpointById: async () => null,
		});
		expect(await (await boot("snapFail")).checkpoint()).toBeNull();
	});

	it("fork returns one handle per successful fork, dropping failures", async () => {
		register("withFork", {
			capabilities: { pause: false, reconnect: false, orphanSweep: false, fork: true },
			forkById: async (_id, _c, count) => Array.from({ length: count }, (_, i) => handle(`fork${i}`)),
		});
		const forks = await (await boot("withFork")).fork(3);
		expect(forks.map((f) => f.id)).toEqual(["fork0", "fork1", "fork2"]);
	});

	it("fork passes timeoutMs through (slice VMs must not die at API default TTL)", async () => {
		let seen: number | undefined;
		register("forkTtl", {
			capabilities: { pause: false, reconnect: false, orphanSweep: false, fork: true },
			forkById: async (_id, _c, _n, timeoutMs) => {
				seen = timeoutMs;
				return [];
			},
		});
		await (await boot("forkTtl")).fork(2, 3_600_000);
		expect(seen).toBe(3_600_000);
	});
});
