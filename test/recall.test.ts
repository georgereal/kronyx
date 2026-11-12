import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentToolContext } from "@cline/shared";
import { createRecallTool } from "../src/agent/recall";

let seq = 0;
const msg = (role: AgentMessage["role"], content: AgentMessage["content"]): AgentMessage => ({
	id: `m${++seq}`,
	role,
	content,
	createdAt: seq,
});

const transcript: AgentMessage[] = [
	msg("assistant", [{ type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a.ts" } }]),
	msg("tool", [{ type: "tool-result", toolCallId: "c1", toolName: "read_file", output: "FULL-OUTPUT-xyz" }]),
	msg("assistant", [{ type: "text", text: "I looked at the tokenizer code" }]),
];

const ctxWith = (messages: AgentMessage[]) =>
	({ agentId: "t", iteration: 1, snapshot: { messages } }) as unknown as AgentToolContext;

describe("recall_context", () => {
	const tool = createRecallTool({ priorTranscripts: () => [{ label: "run 1", messages: transcript }] });

	it("fetches a stubbed tool result by toolCallId", async () => {
		const out = await Promise.resolve(tool.execute({ toolCallId: "c1" }, ctxWith(transcript)));
		expect(out).toContain("FULL-OUTPUT-xyz");
	});

	it("returns the call input alongside the result", async () => {
		const out = await Promise.resolve(tool.execute({ toolCallId: "c1" }, ctxWith(transcript)));
		expect(out).toContain("call read_file input:");
		expect(out).toContain("a.ts");
	});

	it("reports unknown toolCallId", async () => {
		const out = await Promise.resolve(tool.execute({ toolCallId: "nope" }, ctxWith(transcript)));
		expect(out).toContain("No tool call or result");
	});

	it("keyword-searches the transcript", async () => {
		const out = await Promise.resolve(tool.execute({ query: "tokenizer" }, ctxWith(transcript)));
		expect(out).toContain("tokenizer code");
	});

	it("searches a prior run transcript via runIndex", async () => {
		const out = await Promise.resolve(tool.execute({ toolCallId: "c1", runIndex: 0 }, ctxWith([])));
		expect(out).toContain("FULL-OUTPUT-xyz");
	});

	it("uses the semantic scorer for queries when provided", async () => {
		const scored = createRecallTool({
			scorer: async (_q, chunks) => {
				expect(chunks.length).toBe(transcript.length);
				return [{ idx: 1, score: 0.91 }];
			},
		});
		const out = await Promise.resolve(scored.execute({ query: "read config" }, ctxWith(transcript)));
		expect(out).toContain("message #1");
		expect(out).toContain("0.91");
		expect(out).toContain("FULL-OUTPUT-xyz");
	});

	it("falls back to keyword search when the scorer returns nothing", async () => {
		const noEmbed = createRecallTool({ scorer: async () => undefined });
		const out = await Promise.resolve(noEmbed.execute({ query: "tokenizer" }, ctxWith(transcript)));
		expect(out).toContain("tokenizer code");
		const noHits = createRecallTool({ scorer: async () => [] });
		const out2 = await Promise.resolve(noHits.execute({ query: "tokenizer" }, ctxWith(transcript)));
		expect(out2).toContain("tokenizer code");
	});

	it("falls back to keyword search when the scorer throws", async () => {
		const broken = createRecallTool({
			scorer: async () => {
				throw new Error("embed endpoint down");
			},
		});
		const out = await Promise.resolve(broken.execute({ query: "tokenizer" }, ctxWith(transcript)));
		expect(out).toContain("tokenizer code");
	});

	it("semantic search reaches prior-run transcripts via runIndex", async () => {
		const scored = createRecallTool({
			priorTranscripts: () => [{ label: "run 1", messages: transcript }],
			scorer: async () => [{ idx: 1, score: 0.8 }],
		});
		const out = await Promise.resolve(scored.execute({ query: "config", runIndex: 0 }, ctxWith([])));
		expect(out).toContain("message #1");
		expect(out).toContain("FULL-OUTPUT-xyz");
	});

	it("bounds oversized recall output", async () => {
		const big = [msg("tool", [{ type: "tool-result", toolCallId: "big1", toolName: "read_file", output: "z".repeat(20_000) }])];
		const scored = createRecallTool({ scorer: async () => [{ idx: 0, score: 0.99 }] });
		const out = await Promise.resolve(scored.execute({ query: "anything" }, ctxWith(big)));
		expect(out.length).toBeLessThan(9_000);
		// exact fetch still returns the capped full output
		const exact = await Promise.resolve(scored.execute({ toolCallId: "big1" }, ctxWith(big)));
		expect(exact).toContain("chars elided");
	});
});
