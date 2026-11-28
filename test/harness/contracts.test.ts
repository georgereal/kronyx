import { describe, expect, it } from "vitest";
import { DEFAULT_LOOP_DETECTOR, parseLoopDetectorConfig, parseSessionEvent, parseTask, SchemaError, type SessionEvent } from "../../src/harness/core/contracts";

const meta = { seq: 1, at: 1_700_000_000_000, runId: "run-1" };
const task = { id: "t1", title: "Add parser", acceptance: { kind: "command", command: "npm test" }, dependsOn: [], status: "pending", steps: [{ id: "s1", text: "write it", status: "pending", callIds: [] }], evidence: [] };


const componentVersions = { taskSummaryVersion: 1, planVersion: 2, decisionSetVersion: 0, repositoryContextVersion: 0, fileChangeVersion: 1, toolResultVersion: 3, validationVersion: 1, compactionVersion: 0, capabilityVersion: 1 };
const tokenBreakdown = { totalInput: 100, effectiveInput: 100, wireInput: 40, outputReserve: 8000, byComponent: { system_instructions: 20, interaction_tail: 80 }, estimationMethod: "tokenizer" };
const manifest = {
	schemaVersion: 1,
	invocationId: "inv-1",
	sessionId: "session-1",
	runId: "run-1",
	turn: 1,
	purpose: "implementation",
	providerId: "openai",
	modelId: "gpt-5",
	payloadMode: "full",
	contextVersion: 3,
	componentVersions,
	includedEvents: ["execution://seq/1-3"],
	includedToolResults: ["c1"],
	retrievedRepositoryItems: [],
	compactionApplied: false,
	compactionAuthority: "none",
	compactionRecords: [],
	inputTokenCount: 100,
	effectiveInputTokenCount: 100,
	wireInputTokenCount: 100,
	tokenBreakdown,
	outputTokenReservation: 8000,
	estimationMethod: "tokenizer",
	omittedContent: [{ reference: "execution://tool/c1/full-output", reason: "digest included" }],
	truncationApplied: true,
	createdAt: "2026-01-01T00:00:00.000Z",
};
const compactionRecord = {
	schemaVersion: 1,
	compactionId: "cmp-1",
	scope: "interaction_history",
	sourceEventRange: { from: 1, to: 8 },
	summaryRef: "execution://seq/9",
	preservedReferences: ["execution://seq/3"],
	createdAt: "2026-01-01T00:00:00.000Z",
	version: 1,
	componentVersions,
	modelGenerated: true,
};
const envelope = {
	schemaVersion: 1,
	toolExecutionId: "c1",
	toolName: "run_command",
	status: "completed",
	summary: "run_command exit 0",
	structuredResult: { exitCode: 0 },
	evidenceRef: "execution://tool/c1/full-output",
	truncated: true,
	rawChars: 5000,
	rawSha256: "abc123",
	retentionClass: "critical",
	provenance: { source: "tool_execution", verification: "observed" },
};

const samples: Array<Record<string, unknown>> = [
	{ type: "user.input", text: "hi" },
	{ type: "model.response", turn: 1, text: "ok", toolCalls: [{ callId: "c1", name: "task_create", input: { id: "t1" } }], usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 4 } },
	{ type: "model.response", turn: 2, text: "", toolCalls: [] },
	{ type: "tool.requested", callId: "c1", name: "read_file", input: { path: "a.ts" } },
	{ type: "tool.finished", callId: "c1", name: "read_file", ok: false, output: "missing" },
	{ type: "tool.finished", callId: "c1", name: "run_command", ok: true, output: "exit 0", envelope, evidenceRef: envelope.evidenceRef },
	{ type: "context.manifest", manifest },
	{ type: "context.compaction", record: compactionRecord },
	{ type: "execution.state_snapshotted", stateVersion: 2, eventCursor: 10, stateHash: "hash", storeRef: "state://x" },
	{ type: "task.created", task },
	{ type: "task.updated", id: "t1", to: "in_progress", reason: "started" },
	{ type: "task.removed", id: "t1" },
	{ type: "verifier.result", taskId: "t1", ok: true, detail: "suite green" },
	{ type: "stop.refused", openTaskIds: ["t1"] },
	{ type: "budget.warning", kind: "input_tokens", used: 800, limit: 1000 },
	{ type: "run.status", status: "paused", reason: "max_turns" },
	{ type: "step.added", taskId: "t1", step: { id: "s2", text: "test it", status: "pending", callIds: [] } },
	{ type: "step.updated", taskId: "t1", stepId: "s1", to: "done", callIds: ["c1"] },
	{ type: "steer.note", rule: "loop.warn", text: "try something else" },
	{ type: "loop.verdict", level: "warn", fingerprint: "read_file:{}", reason: "repeat" },
];

describe("session event contract", () => {
	it.each(samples.map((s) => [s.type, s] as const))("round-trips %s through JSON", (_type, body) => {
		const event = { ...body, ...meta } as SessionEvent;
		const parsed = parseSessionEvent(JSON.parse(JSON.stringify(event)));
		expect(parsed).toEqual(event);
	});

	it("rejects an unknown event type", () => {
		expect(() => parseSessionEvent({ ...meta, type: "something.else" })).toThrow(SchemaError);
	});

	it("rejects a missing field with its path", () => {
		expect(() => parseSessionEvent({ ...meta, type: "tool.finished", callId: "c1", name: "x", output: "" })).toThrow(/event\.ok/);
	});

	it("rejects malformed context manifests with a nested path", () => {
		const bad = JSON.parse(JSON.stringify(manifest));
		delete bad.componentVersions.planVersion;
		expect(() => parseSessionEvent({ ...meta, type: "context.manifest", manifest: bad })).toThrow(/componentVersions\.planVersion/);
	});

	it("rejects malformed tool envelopes with a nested path", () => {
		const bad = JSON.parse(JSON.stringify(envelope));
		delete bad.provenance.verification;
		expect(() => parseSessionEvent({ ...meta, type: "tool.finished", callId: "c1", name: "run_command", ok: true, output: "x", envelope: bad })).toThrow(/provenance\.verification/);
	});

	it("rejects a task status outside the allowed set", () => {
		expect(() => parseTask({ ...task, status: "finished" })).toThrow(/status/);
	});

	it("rejects a sequence number below 1", () => {
		expect(() => parseSessionEvent({ ...meta, seq: 0, type: "user.input", text: "x" })).toThrow(/seq/);
	});

	it("rejects a budget warning for an unknown kind", () => {
		expect(() => parseSessionEvent({ ...meta, type: "budget.warning", kind: "money", used: 1, limit: 2 })).toThrow(/kind/);
	});
});

describe("loop detector config", () => {
	it("accepts the defaults", () => {
		expect(parseLoopDetectorConfig(DEFAULT_LOOP_DETECTOR)).toEqual(DEFAULT_LOOP_DETECTOR);
	});

	it("rejects an alternation threshold that cannot fit in the window", () => {
		expect(() => parseLoopDetectorConfig({ ...DEFAULT_LOOP_DETECTOR, window: 4, alternationThreshold: 3 })).toThrow(/window/);
	});
});

describe("task_step_update input aliases", () => {
	it("accepts id as the task when stepId is explicit — the task_update generalization", async () => {
		const { parseTaskStepUpdateInput } = await import("../../src/harness/core/taskLedger");
		// The exact shape Session 12's model produced four times in a row.
		const parsed = parseTaskStepUpdateInput({ id: "t1", stepId: "s1", status: "done" });
		expect(parsed.taskId).toBe("t1");
		expect(parsed.stepId).toBe("s1");
	});

	it("accepts id as the step when taskId is explicit", async () => {
		const { parseTaskStepUpdateInput } = await import("../../src/harness/core/taskLedger");
		const parsed = parseTaskStepUpdateInput({ taskId: "t2", id: "s3", status: "done" });
		expect(parsed.taskId).toBe("t2");
		expect(parsed.stepId).toBe("s3");
	});

	it("a bare id with neither field errors with a teaching message", async () => {
		const { parseTaskStepUpdateInput } = await import("../../src/harness/core/taskLedger");
		expect(() => parseTaskStepUpdateInput({ id: "t1", status: "done" })).toThrow(/taskId: "t1", stepId: "s1"/);
	});

	it("a step close using the id alias mutates the board end-to-end", async () => {
		const { MemoryEventLog } = await import("../../src/harness/core/eventLog");
		const { HarnessLoop } = await import("../../src/harness/core/loop");
		const { project } = await import("../../src/harness/core/projections");
		const log = new MemoryEventLog(() => 1);
		let calls = 0;
		const model = {
			complete: async () => {
				calls++;
				return calls === 1
					? { text: "", toolCalls: [{ callId: "c1", name: "task_step_update", input: { id: "t1", stepId: "s1", status: "done" } }], usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } }
					: { text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
			},
		};
		const tools = { specs: () => [], execute: async () => ({ ok: true, output: "" }) };
		const loop = new HarnessLoop({ runId: "r1", log, model: model as never, tools: tools as never });
		await loop.run("x", undefined, undefined, { seed: [{ title: "A", steps: ["s one"] }] });
		const state = project(await log.read());
		expect(state.ledger.tasks.t1?.steps[0]?.status).toBe("done");
	});
});

describe("run_command signal matching (token subsequence)", () => {
	it("matches flag/pipe variations of the signaled command", async () => {
		const { signalHits } = await import("../../src/harness/core/taskLedger");
		const sig = { tool: "run_command", path: "mvn test" };
		expect(signalHits(sig, { name: "run_command", input: { command: "cd /x && mvn test 2>&1" } })).toBe(true);
		expect(signalHits(sig, { name: "run_command", input: { command: "cd /x && mvn clean test 2>&1 | tail -60" } })).toBe(true);
		expect(signalHits(sig, { name: "run_command", input: { command: "mvn -q test" } })).toBe(true);
	});

	it("does not match different or partial commands", async () => {
		const { signalHits } = await import("../../src/harness/core/taskLedger");
		const sig = { tool: "run_command", path: "mvn test" };
		expect(signalHits(sig, { name: "run_command", input: { command: "mvn verify" } })).toBe(false);
		expect(signalHits(sig, { name: "run_command", input: { command: "npm test" } })).toBe(false);
		expect(signalHits(sig, { name: "run_command", input: { command: "mvn" } })).toBe(false);
	});
});
