import { describe, expect, it } from "vitest";
import { capEventForWire, EVENT_WIRE_CAP } from "../src/wireCap";

describe("capEventForWire", () => {
	it("sends a small event unchanged, parsed back from its stored JSON", () => {
		const row = JSON.stringify({ type: "tool-finished", output: "ok" });
		expect(capEventForWire(row)).toEqual({ type: "tool-finished", output: "ok" });
	});

	it("truncates a large event to a preview with a marker and the original size", () => {
		const big = JSON.stringify({ type: "tool-finished", output: "x".repeat(EVENT_WIRE_CAP * 3) });
		const wire = capEventForWire(big) as { truncated: boolean; originalBytes: number; preview: string };
		expect(wire.truncated).toBe(true);
		expect(wire.originalBytes).toBe(Buffer.byteLength(big, "utf8"));
		expect(wire.preview).toHaveLength(EVENT_WIRE_CAP);
	});

	it("keeps the upload per event bounded regardless of the stored size", () => {
		const big = "y".repeat(EVENT_WIRE_CAP * 50);
		expect(JSON.stringify(capEventForWire(big)).length).toBeLessThan(EVENT_WIRE_CAP + 200);
	});

	it("leaves the stored string untouched (the cap is a copy, not a mutation)", () => {
		const stored = JSON.stringify({ output: "z".repeat(EVENT_WIRE_CAP * 2) });
		const before = stored;
		capEventForWire(stored);
		expect(stored).toBe(before);
		expect(stored.length).toBeGreaterThan(EVENT_WIRE_CAP);
	});

	it("treats a missing payload as an empty value", () => {
		expect(capEventForWire(null)).toBe(null);
	});
});
