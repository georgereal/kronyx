import { describe, expect, it } from "vitest";
import type { ModelPort, ToolPort } from "../../src/harness/contracts";
import { MemoryEventLog } from "../../src/harness/eventLog";
import { HarnessLoop } from "../../src/harness/loop";

describe("batch execution on the harness (step 4)", () => {
	it("runs adjacent parallel read tools concurrently", async () => {
		let active = 0;
		let peak = 0;
		const tools: ToolPort = {
			specs: () => [
				{ name: "read", description: "", inputSchema: {}, parallel: true },
				{ name: "write", description: "", inputSchema: {} },
			],
			execute: async (name) => {
				if (name === "read") {
					active++;
					peak = Math.max(peak, active);
					await new Promise((r) => setTimeout(r, 15));
					active--;
				}
				return { ok: true, output: name };
			},
		};
		let turn = 0;
		const model: ModelPort = {
			complete: async () => {
				turn++;
				if (turn === 1) {
					return {
						text: "",
						toolCalls: [
							{ callId: "a", name: "read", input: { p: 1 } },
							{ callId: "b", name: "read", input: { p: 2 } },
							{ callId: "c", name: "read", input: { p: 3 } },
						],
					};
				}
				return { text: "done", toolCalls: [] };
			},
		};
		const loop = new HarnessLoop({ runId: "r", log: new MemoryEventLog(() => 1), model, tools });
		expect(await loop.run("x")).toMatchObject({ status: "completed" });
		expect(peak).toBe(3);
	});

	it("keeps a write as an ordered boundary between parallel reads", async () => {
		const order: string[] = [];
		const tools: ToolPort = {
			specs: () => [
				{ name: "read", description: "", inputSchema: {}, parallel: true },
				{ name: "write", description: "", inputSchema: {} },
			],
			execute: async (name, input) => {
				order.push(`${name}:${(input as { p: number }).p}`);
				return { ok: true, output: "" };
			},
		};
		let turn = 0;
		const model: ModelPort = {
			complete: async () => {
				turn++;
				if (turn === 1) {
					return {
						text: "",
						toolCalls: [
							{ callId: "r1", name: "read", input: { p: 1 } },
							{ callId: "w", name: "write", input: { p: 2 } },
							{ callId: "r2", name: "read", input: { p: 3 } },
						],
					};
				}
				return { text: "done", toolCalls: [] };
			},
		};
		await new HarnessLoop({ runId: "r", log: new MemoryEventLog(() => 1), model, tools }).run("x");
		expect(order).toEqual(["read:1", "write:2", "read:3"]);
	});

	it("records a call to a tool the port does not offer as a refused result", async () => {
		const tools: ToolPort = {
			specs: () => [],
			execute: async (name) => {
				// Mirrors the real tool port: a name it does not offer is refused, not run.
				return { ok: false, output: `Unknown or unavailable tool ${name}.` };
			},
		};
		let turn = 0;
		const model: ModelPort = {
			complete: async () => {
				turn++;
				return turn === 1 ? { text: "", toolCalls: [{ callId: "x", name: "hidden_write", input: {} }] } : { text: "done", toolCalls: [] };
			},
		};
		const loop = new HarnessLoop({ runId: "r", log: new MemoryEventLog(() => 1), model, tools });
		await loop.run("x");
		expect(loop.projection.messages.find((m) => m.kind === "tool" && m.callId === "x")).toMatchObject({ ok: false });
	});
});
