import { describe, expect, it } from "vitest";
import { reduceResponses } from "../src/agent/openaiWire";

function sse(lines: object[]): AsyncIterable<{ event: string; data: string }> {
	return (async function* () {
		for (const l of lines) yield { event: "message", data: JSON.stringify(l) };
	})();
}

const reasoningItem = { type: "reasoning", id: "rs_1", content: [{ type: "reasoning_text", text: "assessing the board state" }] };
const messageItem = { type: "message", id: "m1", content: [{ type: "output_text", text: "Let me check." }] };

describe("reduceResponses reasoning", () => {
	it("surfaces reasoning delivered only as a completed item — no streamed deltas (qwen via gateways)", async () => {
		const deltas: string[] = [];
		const out = await reduceResponses(
			sse([
				{ type: "response.created", response: { id: "r1" } },
				{ type: "response.output_item.done", item: reasoningItem },
				{ type: "response.output_text.delta", delta: "Let me check." },
				{ type: "response.output_item.done", item: messageItem },
				{ type: "response.completed", response: { id: "r1", output: [reasoningItem, messageItem] } },
			]),
			{ onText: () => {}, onReasoning: (t) => deltas.push(t) },
		);
		expect(out.reasoning).toContain("assessing the board state");
		expect(deltas).toHaveLength(1);
	});

	it("does not double-fire when reasoning streamed as deltas", async () => {
		const deltas: string[] = [];
		const out = await reduceResponses(
			sse([
				{ type: "response.created", response: { id: "r1" } },
				{ type: "response.reasoning_text.delta", delta: "assessing the board state" },
				{ type: "response.output_item.done", item: reasoningItem },
				{ type: "response.output_text.delta", delta: "Let me check." },
				{ type: "response.completed", response: { id: "r1", output: [reasoningItem, messageItem] } },
			]),
			{ onText: () => {}, onReasoning: (t) => deltas.push(t) },
		);
		expect(out.reasoning).toBe("assessing the board state");
		expect(deltas).toHaveLength(1);
	});

	it("completion-time fallback: reasoning present only in the final output array", async () => {
		const deltas: string[] = [];
		const out = await reduceResponses(
			sse([
				{ type: "response.created", response: { id: "r1" } },
				{ type: "response.output_text.delta", delta: "Let me check." },
				{ type: "response.completed", response: { id: "r1", output: [reasoningItem, messageItem] } },
			]),
			{ onText: () => {}, onReasoning: (t) => deltas.push(t) },
		);
		expect(out.reasoning).toContain("assessing the board state");
		expect(deltas).toHaveLength(1);
	});
});
