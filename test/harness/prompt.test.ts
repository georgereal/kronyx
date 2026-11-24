import { describe, expect, it } from "vitest";
import type { ModelRequest } from "../../src/harness/contracts";
import { SYSTEM_INSTRUCTIONS } from "../../src/harness/context";
import { MemoryEventLog } from "../../src/harness/eventLog";
import { HarnessLoop } from "../../src/harness/loop";

const tools = { specs: () => [], execute: async () => ({ ok: true, output: "" }) };

function capture() {
	const requests: ModelRequest[] = [];
	return {
		requests,
		model: {
			complete: async (r: ModelRequest) => {
				requests.push(r);
				return { text: "done", toolCalls: [] };
			},
		},
	};
}

describe("system prompt and per-run context (step 3)", () => {
	it("sends the supplied system prompt on every request", async () => {
		const c = capture();
		const loop = new HarnessLoop({ runId: "r", log: new MemoryEventLog(() => 1), model: c.model, tools, system: "WORKSPACE PROMPT" });
		await loop.run("task one");
		expect(c.requests[0]?.system).toBe("WORKSPACE PROMPT");
	});

	it("falls back to the harness instructions when none is supplied", async () => {
		const c = capture();
		const loop = new HarnessLoop({ runId: "r", log: new MemoryEventLog(() => 1), model: c.model, tools });
		await loop.run("task one");
		expect(c.requests[0]?.system).toBe(SYSTEM_INSTRUCTIONS);
	});

	it("puts per-run context once, at the start of that run's user message, and keeps the system prompt fixed", async () => {
		const c = capture();
		const loop = new HarnessLoop({ runId: "r", log: new MemoryEventLog(() => 1), model: c.model, tools, system: "SYS" });
		await loop.run("do it", "MEMORY BLOCK");
		const first = c.requests[0]!.messages.filter((m) => m.kind === "user");
		expect(first[0]?.kind === "user" && first[0].text).toBe("MEMORY BLOCK\n\ndo it");

		await loop.run("next", "OTHER BLOCK");
		const second = c.requests[1]!.messages.flatMap((m) => (m.kind === "user" ? [m.text] : []));
		expect(second).toEqual(["MEMORY BLOCK\n\ndo it", "OTHER BLOCK\n\nnext"]);
		expect(c.requests[1]!.system).toBe(c.requests[0]!.system);
	});
});
