import { describe, expect, it } from "vitest";
import { registerBehaviorProfile, resolveBehaviorProfile } from "../../src/harness/behaviors";
import { defaultBehavior, type HarnessBehavior } from "../../src/harness/core/behavior";
import { MemoryEventLog } from "../../src/harness/core/eventLog";
import { HarnessLoop } from "../../src/harness/core/loop";
import type { ModelPort, ToolPort, ToolSpec } from "../../src/harness/core/contracts";
import type { PlanResult } from "../../src/harness/core/policies/planning";

const noop: ToolSpec = { name: "noop", description: "", inputSchema: {} };
const tools = (): ToolPort => ({ specs: () => [noop], execute: async () => ({ ok: true, output: "ok" }) });
const model = (texts: string[]): ModelPort => {
	const queue = [...texts];
	return { async complete() { return { text: queue.shift() ?? "done", toolCalls: [] }; } };
};

describe("resolveBehaviorProfile", () => {
	it("returns the default composition when no profile matches", () => {
		const behavior = resolveBehaviorProfile({ providerId: "openai", modelId: "m" });
		expect(Object.keys(behavior).sort()).toEqual(["context", "evidence", "loopControl", "planner", "recap", "steering"]);
	});

	it("applies a registered profile's overrides on provider/model match, keeping the rest default", () => {
		const marker = { planner: { plan: async () => ({ tasks: [], continueIds: [] }) } } as unknown as Partial<HarnessBehavior>;
		registerBehaviorProfile({ matches: (d) => d.providerId === "anthropic" && d.modelId.startsWith("claude"), overrides: marker });
		const hit = resolveBehaviorProfile({ providerId: "anthropic", modelId: "claude-9" });
		expect(hit.planner).toBe(marker.planner);
		expect(hit.context).toBe(defaultBehavior().context);
		const miss = resolveBehaviorProfile({ providerId: "openai", modelId: "claude-9" });
		expect(miss.planner).not.toBe(marker.planner);
	});
});

describe("injected behavior", () => {
	it("uses the injected PlanningPolicy instead of the default planner", async () => {
		const planned: PlanResult = {
			tasks: [{ id: "x", title: "Custom task", acceptance: { kind: "none" }, dependsOn: [], status: "pending", steps: [{ id: "s1", text: "do it", status: "pending", callIds: [] }], evidence: [] }],
			continueIds: [],
		};
		const log = new MemoryEventLog(() => 1);
		const behavior: HarnessBehavior = { ...defaultBehavior(), planner: { plan: async () => planned } };
		const loop = new HarnessLoop({ runId: "r1", log, model: model(["done"]), tools: tools(), behavior });
		expect((await loop.run("go", undefined, undefined, { plan: true })).status).toBe("completed");
		expect(loop.projection.ledger.order).toEqual(["t1"]);
		expect(loop.projection.ledger.tasks["t1"]?.title).toBe("Custom task");
	});

	it("uses the injected LoopControlPolicy verdicts — the kernel still records and applies them", async () => {
		const port: ModelPort = {
			async complete() {
				return { text: "", toolCalls: [{ callId: `c${Date.now()}${Math.random()}`, name: "noop", input: {} }] };
			},
		};
		const log = new MemoryEventLog(() => 1);
		const behavior: HarnessBehavior = {
			...defaultBehavior(),
			loopControl: { ...defaultBehavior().loopControl, detect: () => "repeat" },
		};
		const loop = new HarnessLoop({ runId: "r1", log, model: port, tools: tools(), behavior });
		const outcome = await loop.run("go");
		const verdicts = (await log.read()).filter((e) => e.type === "loop.verdict");
		expect(verdicts.length).toBeGreaterThan(0);
		expect(verdicts[0]).toMatchObject({ level: "warn", reason: "repeat" });
		expect(outcome.status).toBe("paused");
	});
});

describe("context-window-derived budget", () => {
	it("scales budgetChars with the model's window; falls back when unknown", async () => {
		const { resolveBehaviorProfile } = await import("../../src/harness/behaviors");
		const big = resolveBehaviorProfile({ providerId: "p", modelId: "m", contextWindow: 128_000 });
		expect(big.context.budgetChars).toBe(Math.floor(128_000 * 0.7) * 4);
		const small = resolveBehaviorProfile({ providerId: "p", modelId: "m", contextWindow: 32_000 });
		expect(small.context.budgetChars).toBe(Math.floor(32_000 * 0.7) * 4);
		const unknown = resolveBehaviorProfile({ providerId: "p", modelId: "m" });
		expect(unknown.context.budgetChars).toBe(120_000);
	});
});
