import { describe, expect, it } from "vitest";
import type { ModelPort, ToolPort } from "../../src/harness/core/contracts";
import { MemoryEventLog } from "../../src/harness/core/eventLog";
import { HarnessLoop } from "../../src/harness/core/loop";

const noopSpec = { name: "noop", description: "test tool", inputSchema: { type: "object" } };

function model(): ModelPort {
	let turn = 0;
	return {
		identity: { providerId: "test-provider", modelId: "test-model", contextWindow: 128_000 },
		async complete() {
			turn++;
			if (turn === 1) return { text: "", toolCalls: [{ callId: "c1", name: "noop", input: { value: 1 } }] };
			return { text: "done", toolCalls: [] };
		},
	};
}

const tools: ToolPort = {
	specs: () => [noopSpec],
	execute: async () => ({ ok: true, output: "exit 0\nall good" }),
};

describe("context pipeline integration", () => {
	it("writes tool-result envelopes on durable tool.finished events", async () => {
		const log = new MemoryEventLog(() => 1);
		const outcome = await new HarnessLoop({ runId: "r", log, model: model(), tools }).run("go");
		expect(outcome.status).toBe("completed");
		const finished = (await log.read()).find((e) => e.type === "tool.finished" && e.callId === "c1");
		expect(finished).toMatchObject({
			type: "tool.finished",
			output: "exit 0\nall good",
			evidenceRef: "execution://tool/c1/full-output",
			envelope: {
				toolExecutionId: "c1",
				toolName: "noop",
				status: "completed",
				rawChars: "exit 0\nall good".length,
				retentionClass: "active",
			},
		});
	});

	it("emits a durable context manifest for every model invocation", async () => {
		const log = new MemoryEventLog(() => 1);
		await new HarnessLoop({ runId: "r", sessionId: "session-a", log, model: model(), tools }).run("go");
		const events = await log.read();
		const manifests = events.filter((e) => e.type === "context.manifest");
		const responses = events.filter((e) => e.type === "model.response");
		expect(manifests).toHaveLength(responses.length);
		expect(manifests.length).toBeGreaterThanOrEqual(2);
		for (const event of manifests) {
			if (event.type !== "context.manifest") continue;
			expect(event.manifest).toMatchObject({
				schemaVersion: 1,
				sessionId: "session-a",
				runId: "r",
				providerId: "test-provider",
				modelId: "test-model",
				payloadMode: "full",
				estimationMethod: "tokenizer",
			});
			expect(event.manifest.tokenBreakdown.totalInput).toBeGreaterThan(0);
			expect(event.manifest.componentVersions).toMatchObject({ planVersion: expect.any(Number), toolResultVersion: expect.any(Number) });
		}
		const firstManifestSeq = manifests[0]!.seq;
		const firstResponseSeq = responses[0]!.seq;
		expect(firstManifestSeq).toBeLessThan(firstResponseSeq);
	});

	it("emits a planning-purpose manifest for the planner's auxiliary model call", async () => {
		const log = new MemoryEventLog(() => 1);
		await new HarnessLoop({ runId: "r-plan", sessionId: "session-a", log, model: model(), tools }).run("implement the thing", undefined, undefined, { plan: true });
		const manifests = (await log.read()).filter((e) => e.type === "context.manifest");
		expect(manifests.some((e) => e.type === "context.manifest" && e.manifest.purpose === "planning")).toBe(true);
		const planner = manifests.find((e) => e.type === "context.manifest" && e.manifest.purpose === "planning");
		expect(planner?.type === "context.manifest" && planner.manifest.tokenBreakdown.totalInput).toBeGreaterThan(0);
	});

	it("closes out a completed work run and the next run inherits the compact handoff", async () => {
		const log = new MemoryEventLog(() => 1);
		await new HarnessLoop({ runId: "run-one", sessionId: "session-a", log, model: model(), tools }).run("implement the thing");
		const events = await log.read();
		const closeout = events.find((e) => e.type === "context.closeout");
		expect(closeout).toMatchObject({ record: { outcome: "completed", runId: "run-one", validation: { status: "not-run" } } });
		const recap = events.find((e) => e.type === "context.recap");
		expect(recap?.type === "context.recap" && recap.text).toContain("Closeout of prior run");
		expect(events.some((e) => e.type === "context.compaction" && e.record.scope === "task_closeout")).toBe(true);

		let firstRequest: readonly unknown[] = [];
		const secondModel: ModelPort = {
			async complete(request) {
				firstRequest = request.messages;
				return { text: "next answer", toolCalls: [] };
			},
		};
		const second = new HarnessLoop({ runId: "run-two", sessionId: "session-a", log, model: secondModel, tools });
		await second.recover();
		await second.run("do the next thing");
		const text = JSON.stringify(firstRequest);
		expect(text).toContain("Closeout of prior run");
		expect(text).not.toContain("exit 0\nall good");
	});

	it("closes out a failed work run as reusable debugging knowledge", async () => {
		const log = new MemoryEventLog(() => 1);
		const failing: ModelPort = {
			async complete() {
				throw new Error("provider exploded");
			},
		};
		const outcome = await new HarnessLoop({ runId: "run-fail", sessionId: "session-a", log, model: failing, tools }).run("implement the thing");
		expect(outcome.status).toBe("failed");
		const events = await log.read();
		const closeout = events.find((e) => e.type === "context.closeout");
		// A provider failure before any work is not meaningful execution knowledge; use a work-bearing failure instead.
		expect(closeout).toBeUndefined();

		const workThenFail: ModelPort = (() => {
			let turn = 0;
			return {
				async complete() {
					turn++;
					if (turn === 1) return { text: "", toolCalls: [{ callId: "c1", name: "noop", input: {} }] };
					throw new Error("provider exploded");
				},
			};
		})();
		const log2 = new MemoryEventLog(() => 1);
		const outcome2 = await new HarnessLoop({ runId: "run-fail-work", sessionId: "session-a", log: log2, model: workThenFail, tools }).run("implement the thing");
		expect(outcome2.status).toBe("failed");
		const closeout2 = (await log2.read()).find((e) => e.type === "context.closeout");
		expect(closeout2).toMatchObject({ record: { outcome: "failed", runId: "run-fail-work" } });
	});

});
