import { describe, expect, it } from "vitest";
import type { ModelPort, ModelRequest, ToolPort } from "../../src/harness/core/contracts";
import { MemoryEventLog } from "../../src/harness/core/eventLog";
import { HarnessLoop } from "../../src/harness/core/loop";

const tools: ToolPort = { specs: () => [], execute: async () => ({ ok: true, output: "" }) };

describe("Stop for harness runs", () => {
	it("cancels an in-flight model request and pauses the run as stopped", async () => {
		const controller = new AbortController();
		let received: AbortSignal | undefined;
		const model: ModelPort = {
			complete: (request: ModelRequest) =>
				new Promise((_resolve, reject) => {
					received = request.signal;
					request.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		};
		const loop = new HarnessLoop({ runId: "r", log: new MemoryEventLog(() => 1), model, tools, signal: controller.signal });
		const running = loop.run("long task");
		await new Promise((r) => setTimeout(r, 5));
		controller.abort();
		const outcome = await running;
		expect(received?.aborted).toBe(true);
		expect(outcome).toMatchObject({ status: "paused", reason: "stopped" });
		expect(loop.projection.run).toMatchObject({ status: "paused", reason: "stopped" });
	});

	it("stop() ends the run at the next step without calling the model again", async () => {
		let calls = 0;
		const model: ModelPort = {
			complete: async () => {
				calls++;
				return { text: "", toolCalls: [{ callId: `c${calls}`, name: "noop", input: { n: calls } }] };
			},
		};
		const toolPort: ToolPort = { specs: () => [{ name: "noop", description: "", inputSchema: {} }], execute: async () => ({ ok: true, output: "ok" }) };
		const loop = new HarnessLoop({ runId: "r", log: new MemoryEventLog(() => 1), model, tools: toolPort, limits: { maxTurns: 50 } });
		loop.stop();
		const outcome = await loop.run("x");
		expect(outcome).toMatchObject({ status: "paused", reason: "stopped" });
		expect(calls).toBe(0);
	});

	it("a stopped run can be continued later with a new message on the same log", async () => {
		const log = new MemoryEventLog(() => 1);
		const controller = new AbortController();
		controller.abort();
		await new HarnessLoop({ runId: "r", log, model: { complete: async () => ({ text: "", toolCalls: [] }) }, tools, signal: controller.signal }).run("first");
		const next = new HarnessLoop({ runId: "r", log, model: { complete: async () => ({ text: "done", toolCalls: [] }) }, tools });
		await next.recover();
		expect(await next.run("continue")).toMatchObject({ status: "completed" });
	});
});
