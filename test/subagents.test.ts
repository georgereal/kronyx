import { describe, expect, it } from "vitest";
import { InProcessSubagent, type SubagentProvider } from "../src/agent/subagents";
import { SEAM_SUBAGENTS } from "../src/agent/seams";

describe("SubagentProvider seam", () => {
	it("exposes the contract + seam key", () => {
		expect(SEAM_SUBAGENTS).toBe("subagents");
		const p: SubagentProvider = new InProcessSubagent({
			settings: { providerId: "p", modelId: "m", apiKey: "k" } as never,
			tools: [],
			systemPrompt: "x",
		});
		for (const m of ["start", "progress", "result", "cancel"] as const) expect(typeof p[m]).toBe("function");
	});

	it("cancelled handles report cancellation", async () => {
		const p = new InProcessSubagent({
			settings: { providerId: "p", modelId: "m", apiKey: "k" } as never,
			tools: [],
			systemPrompt: "x",
		});
		// Start would call the model — forge a handle to exercise the contract path.
		const fake = { id: "sub-x", task: "t", done: new Promise(() => {}), cancelled: false };
		const live = (p as unknown as { live: Map<string, unknown> }).live;
		live.set(fake.id, fake);
		expect(await p.progress(fake)).toBe("running");
		await p.cancel(fake);
		expect(await p.result(fake)).toBe("Subagent cancelled.");
	});
});
