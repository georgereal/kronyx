import { describe, expect, it, vi } from "vitest";
import { SandboxDeadError, isSandboxDeath } from "../src/sandbox/errors";

describe("isSandboxDeath", () => {
	it("matches known death signatures", () => {
		for (const m of [
			"The sandbox was not found",
			"sandbox not found",
			"connection to sandbox lost",
			"the sandbox was killed or reached its timeout",
			"Sandbox died",
		]) {
			expect(isSandboxDeath(new Error(m)), m).toBe(true);
		}
	});

	it("always matches SandboxDeadError regardless of message", () => {
		expect(isSandboxDeath(new SandboxDeadError("anything"))).toBe(true);
	});

	it("rejects ordinary errors", () => {
		expect(isSandboxDeath(new Error("git failed (push): exit 1"))).toBe(false);
		expect(isSandboxDeath("ENOENT: no such file")).toBe(false);
		expect(isSandboxDeath(undefined)).toBe(false);
	});
});

describe("delegatingHandle death latch", () => {
	it("latches live.dead, stops the slot, and fires onDead on a death rejection", async () => {
		const { delegatingHandle } = await import("../backend/src/worker/executor");
		const err = new Error("sandbox was not found");
		const live: {
			handle?: { id: string; run: () => Promise<never>; readFile: () => Promise<string>; writeFile: () => Promise<void> };
			stopped?: boolean;
			dead?: unknown;
			onDead?: (e: unknown) => void;
		} = {
			handle: {
				id: "sbx-1",
				run: () => Promise.reject(err),
				readFile: () => Promise.reject(err),
				writeFile: () => Promise.reject(err),
			},
		};
		const onDead = vi.fn();
		live.onDead = onDead;
		const h = delegatingHandle(live as never);
		await expect(h.run("ls", { cwd: "/" })).rejects.toBe(err);
		expect(live.dead).toBe(err);
		expect(live.stopped).toBe(true);
		expect(onDead).toHaveBeenCalledWith(err);
	}, 20_000);

	it("does not latch on ordinary errors", async () => {
		const { delegatingHandle } = await import("../backend/src/worker/executor");
		const live = {
			handle: { id: "sbx-1", run: () => Promise.reject(new Error("exit 1")) },
			onDead: vi.fn(),
		};
		const h = delegatingHandle(live as never);
		await expect(h.run("false", { cwd: "/" })).rejects.toThrow("exit 1");
		expect(live).not.toHaveProperty("dead");
		expect(live.onDead).not.toHaveBeenCalled();
	}, 20_000);
});
