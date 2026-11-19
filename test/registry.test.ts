import { describe, expect, it } from "vitest";
import { KronyxRegistry } from "../src/agent/registry";

describe("KronyxRegistry", () => {
	it("resolve returns undefined for unprovided seams", () => {
		expect(new KronyxRegistry().resolve("nope")).toBeUndefined();
	});

	it("register/resolve/dispose round-trip", () => {
		const r = new KronyxRegistry();
		const provider = { ok: true };
		const dispose = r.register("seam", provider);
		expect(r.resolve("seam")).toBe(provider);
		dispose();
		expect(r.resolve("seam")).toBeUndefined();
	});

	it("dispose from an older registration doesn't remove a newer provider", () => {
		const r = new KronyxRegistry();
		const d1 = r.register("seam", 1);
		r.register("seam", 2);
		d1();
		expect(r.resolve("seam")).toBe(2);
	});

	it("required throws loud when missing", () => {
		const r = new KronyxRegistry();
		expect(() => r.required("seam")).toThrow(/required seam "seam"/);
		r.register("seam", 1);
		expect(r.required("seam")).toBe(1);
	});
});
