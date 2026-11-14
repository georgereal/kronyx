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

	it("drops scorer hits with out-of-range indices", async () => {
		const scored = createRecallTool({
			scorer: async () => [
				{ idx: 99, score: 0.99 },
				{ idx: 2, score: 0.5 },
			],
		});
		const out = await Promise.resolve(scored.execute({ query: "anything" }, ctxWith(transcript)));
		expect(out).not.toContain("message #99");
		expect(out).toContain("message #2");
		expect(out).toContain("0.50");
	});

	it("falls back to keyword search when every scorer hit is out of range", async () => {
		const scored = createRecallTool({ scorer: async () => [{ idx: 50, score: 0.9 }] });
		const out = await Promise.resolve(scored.execute({ query: "tokenizer" }, ctxWith(transcript)));
		expect(out).toContain("tokenizer code");
		expect(out).not.toContain("message #50");
	});

	it("caps semantic results at the max hit count", async () => {
		const many = Array.from({ length: 12 }, (_, i) => msg("assistant", [{ type: "text", text: `chunk ${i}` }]));
		const scored = createRecallTool({
			scorer: async () => many.map((_, idx) => ({ idx, score: 1 - idx / 100 })),
		});
		const out = await Promise.resolve(scored.execute({ query: "chunk" }, ctxWith(many)));
		expect(out.match(/^--- message #/gm)?.length).toBe(5);
		expect(out).toContain("message #4");
		expect(out).not.toContain("message #5 ");
	});

	it("truncates long semantic snippets to the snippet bound", async () => {
		const long = [msg("assistant", [{ type: "text", text: "x".repeat(5_000) }])];
		const scored = createRecallTool({ scorer: async () => [{ idx: 0, score: 0.7 }] });
		const out = await Promise.resolve(scored.execute({ query: "x" }, ctxWith(long)));
		// body is bounded to 2*SNIPPET_RADIUS + 800 = 1200 chars; header adds a short line
		expect(out).toContain("x".repeat(1_200));
		expect(out).not.toContain("x".repeat(1_201));
	});

	it("renders keyword snippets without JSON escapes", async () => {
		const multi = [msg("assistant", [{ type: "text", text: "first line\nsecond \"quoted\" tokenizer line" }])];
		const out = await Promise.resolve(tool.execute({ query: "tokenizer" }, ctxWith(multi)));
		expect(out).toContain("second \"quoted\" tokenizer line");
		expect(out).not.toContain("\\n");
		expect(out).not.toContain("\\\"");
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
