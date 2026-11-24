import { beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "@cline/agents";
import { AgentRunner, type ProviderSettings, type RunViewEvent, type RunnerHost } from "../src/agent/runner";

type Step = (agent: unknown, input?: unknown) => unknown;

vi.mock("@cline/agents", () => {
	class Agent {
		static script: Step[] = [];
		static instances: Agent[] = [];
		calls: [string, unknown][] = [];
		constructor(readonly config: { maxIterations: number }) {
			Agent.instances.push(this as unknown as Agent);
		}
		async run(input: unknown) {
			this.calls.push(["run", input]);
			return Agent.script.shift()!(this, input);
		}
		async continue(input?: unknown) {
			this.calls.push(["continue", input]);
			return Agent.script.shift()!(this, input);
		}
		snapshot() {
			return { messages: [] };
		}
		abort() {}
	}
	return { Agent };
});

const ScriptedAgent = Agent as unknown as { script: Step[]; instances: Agent[] };

const capped = {
	status: "failed",
	error: new Error("Agent runtime exceeded maxIterations (40)"),
	iterations: 40,
	outputText: "halfway through the refactor",
	messages: [],
};
const completed = { status: "completed", iterations: 3, outputText: "all done", messages: [] };

describe("AgentRunner step-cap pause", () => {
	let events: RunViewEvent[];
	let runner: AgentRunner;
	const host = (): RunnerHost => ({
		workspaceRoot: process.cwd(),
		isDirty: () => false,
		relativePath: (p) => p,
		currentMode: () => "code",
		emit: (e) => events.push(e),
	});
	const settings: ProviderSettings = {
		providerId: "openrouter",
		baseUrl: "https://example.test/v1",
		modelId: "test-model",
		apiKey: "k",
		maxIterations: 40,
	};
	const types = () => events.map((e) => e.type);

	beforeEach(() => {
		events = [];
		ScriptedAgent.script = [];
		ScriptedAgent.instances = [];
		runner = new AgentRunner(host());
	});

	it("pauses at the step cap instead of failing, and keeps the agent", async () => {
		ScriptedAgent.script = [() => capped];
		await runner.run("refactor the module", settings);
		expect(types()).toContain("run-paused");
		expect(types()).not.toContain("run-failed");
		expect(runner.isPaused).toBe(true);
		expect(events.find((e) => e.type === "run-paused")).toMatchObject({ iterations: 40, limit: 40 });
	});

	it("continues the same agent without injecting a message", async () => {
		ScriptedAgent.script = [() => capped, () => completed];
		await runner.run("refactor the module", settings);
		await runner.resume(settings);
		const agent = ScriptedAgent.instances[0];
		expect((agent as unknown as { calls: [string, unknown][] }).calls).toEqual([
			["run", "refactor the module"],
			["continue", undefined],
		]);
		expect(ScriptedAgent.instances).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "run-finished", status: "completed" });
		expect(runner.isPaused).toBe(false);
	});

	it("stop while paused finalizes as a deliberate stop with the summary", async () => {
		ScriptedAgent.script = [() => capped];
		await runner.run("refactor the module", settings);
		runner.stop();
		expect(events.at(-1)).toMatchObject({ type: "run-finished", status: "stopped", text: "halfway through the refactor" });
		expect(runner.isPaused).toBe(false);
	});

	it("keeps non-cap failures as run-failed", async () => {
		ScriptedAgent.script = [() => ({ ...capped, error: new Error("provider 500"), iterations: 2 })];
		await runner.run("refactor the module", settings);
		expect(types()).toContain("run-failed");
		expect(types()).not.toContain("run-paused");
		expect(runner.isPaused).toBe(false);
	});

	it("maps an aborted run to a stopped finish", async () => {
		ScriptedAgent.script = [() => ({ ...completed, status: "aborted" })];
		await runner.run("refactor the module", settings);
		expect(events.at(-1)).toMatchObject({ type: "run-finished", status: "stopped" });
	});

	it("resume with nothing paused emits a visible failure", async () => {
		await runner.resume(settings);
		expect(events.at(-1)).toMatchObject({ type: "run-failed" });
	});
});

describe("AgentRunner transcript repair", () => {
	const settings: ProviderSettings = {
		providerId: "openrouter",
		baseUrl: "https://example.test/v1",
		modelId: "test-model",
		apiKey: "k",
		maxIterations: 40,
	};
	const toolCallMsg = { id: "m", role: "assistant", content: [{ type: "tool-call" }], createdAt: 0 };
	const interrupted = [
		{ id: "u1", role: "user", content: [{ type: "text", text: "task" }], createdAt: 1 },
		{ id: "a1", role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a.ts" } }], createdAt: 2 },
	];
	const runnerWith = (events: RunViewEvent[], resumeLog: () => Promise<unknown[]>) =>
		new AgentRunner({
			workspaceRoot: process.cwd(),
			isDirty: () => false,
			relativePath: (p: string) => p,
			currentMode: () => "code",
			emit: (e: RunViewEvent) => events.push(e),
			events: { record: (e: unknown) => events.push(e as RunViewEvent) },
			resume: { resumeLog },
		} as unknown as RunnerHost);

	beforeEach(() => {
		ScriptedAgent.script = [];
		ScriptedAgent.instances = [];
	});

	it("seeds a resumed agent with the dangling tool call answered by a synthetic error result", async () => {
		const events: RunViewEvent[] = [];
		ScriptedAgent.script = [() => ({ ...completed, messages: [toolCallMsg] })];
		await runnerWith(events, async () => interrupted).run("continue", settings);
		const { config } = ScriptedAgent.instances[0] as unknown as { config: { initialMessages: { role: string; content: Record<string, unknown>[] }[] } };
		expect(config.initialMessages.at(-1)?.role).toBe("tool");
		expect(config.initialMessages.at(-1)?.content[0]).toMatchObject({ type: "tool-result", toolCallId: "c1", isError: true });
		expect(events.find((e) => (e as { type: string }).type === "resumed-from-log")).toMatchObject({ repaired: 1 });
	});

	it("retries once with the transcript repaired when a tool result is reported missing", async () => {
		const events: RunViewEvent[] = [];
		ScriptedAgent.script = [
			() => ({ ...completed, status: "failed", error: new Error("Tool result is missing for tool call call_x."), messages: [] }),
			() => ({ ...completed, messages: [toolCallMsg] }),
		];
		await runnerWith(events, async () => []).run("refactor the module", settings);
		const agent = ScriptedAgent.instances[0] as unknown as { calls: [string, unknown][] };
		expect(agent.calls.map((c) => c[0])).toEqual(["run", "continue"]);
		expect(events.some((e) => e.type === "info" && /interrupted/.test(String((e as { text?: string }).text)))).toBe(true);
		expect(events.some((e) => e.type === "run-failed")).toBe(false);
		expect(events.at(-1)).toMatchObject({ type: "run-finished", status: "completed" });
	});
});
