import { describe, expect, it } from "vitest";
import type { ModelPort, Task, ToolPort } from "../../src/harness/core/contracts";
import { CommandVerifier } from "../../src/harness/defaults/verifier";
import { shellExec } from "../../src/harness/tools/exec";
import { SubagentRunner, restrictTools, SUBAGENT_SUMMARY_CAP } from "../../src/harness/tools/subagent";

const task = (acceptance: Task["acceptance"]): Task => ({ id: "t", title: "t", acceptance, dependsOn: [], status: "pending", steps: [], evidence: [] });

describe("command verifier (M8)", () => {
	it("passes when the command exits 0 and fails otherwise", async () => {
		const pass = new CommandVerifier(async () => ({ ok: true, output: "all green" }));
		const fail = new CommandVerifier(async () => ({ ok: false, output: "1 failing" }));
		expect(await pass.check(task({ kind: "command", command: "npm test" }))).toMatchObject({ ok: true });
		expect(await fail.check(task({ kind: "command", command: "npm test" }))).toMatchObject({ ok: false, detail: expect.stringContaining("1 failing") });
	});

	it("runs exactly the command in the task", async () => {
		const seen: string[] = [];
		const v = new CommandVerifier(async (c) => (seen.push(c), { ok: true, output: "" }));
		await v.check(task({ kind: "command", command: "npm run lint" }));
		expect(seen).toEqual(["npm run lint"]);
	});

	it("rejects reviewer acceptance until it is enabled", async () => {
		const v = new CommandVerifier(async () => ({ ok: true, output: "" }));
		expect(await v.check(task({ kind: "reviewer", rubric: "looks good" }))).toMatchObject({ ok: false });
	});

	it("reports an exec that throws as a failed check instead of crashing", async () => {
		const v = new CommandVerifier(async () => {
			throw new Error("spawn ENOENT");
		});
		expect(await v.check(task({ kind: "command", command: "x" }))).toMatchObject({ ok: false, detail: expect.stringContaining("ENOENT") });
	});

	it("caps very long verifier output", async () => {
		const v = new CommandVerifier(async () => ({ ok: false, output: "x".repeat(10_000) }));
		const result = await v.check(task({ kind: "command", command: "x" }));
		expect(result.detail.length).toBeLessThan(4100);
	});
});

const tools: ToolPort = {
	specs: () => [
		{ name: "read", description: "", inputSchema: {} },
		{ name: "write", description: "", inputSchema: {} },
	],
	execute: async (name) => ({ ok: true, output: `ran ${name}` }),
};

describe("subagent contract (M8)", () => {
	it("refuses tools outside the allowlist as results", async () => {
		const restricted = restrictTools(tools, ["read"]);
		expect(restricted.specs().map((s) => s.name)).toEqual(["read"]);
		expect(await restricted.execute("write", {})).toMatchObject({ ok: false });
		expect(await restricted.execute("read", {})).toMatchObject({ ok: true });
	});

	it("runs a bounded child loop and returns a summary and evidence seqs", async () => {
		let turn = 0;
		const model: ModelPort = {
			async complete() {
				turn++;
				return turn === 1 ? { text: "", toolCalls: [{ callId: "r1", name: "read", input: {} }] } : { text: "found it", toolCalls: [] };
			},
		};
		const result = await new SubagentRunner({ model, tools }).run({ objective: "find it", tools: ["read"], maxTurns: 4, maxInputTokens: 10_000 });
		expect(result).toMatchObject({ status: "completed", summary: "found it" });
		expect(result.evidence.length).toBe(1);
	});

	it("caps the summary returned to the parent", async () => {
		const model: ModelPort = { complete: async () => ({ text: "s".repeat(SUBAGENT_SUMMARY_CAP * 3), toolCalls: [] }) };
		const result = await new SubagentRunner({ model, tools }).run({ objective: "x", tools: ["read"], maxTurns: 2, maxInputTokens: 10_000 });
		expect(result.summary.length).toBeLessThanOrEqual(SUBAGENT_SUMMARY_CAP + 20);
	});

	it("is sequential: a second run while one is active is refused", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((r) => (release = r));
		const model: ModelPort = {
			complete: async () => {
				await gate;
				return { text: "", toolCalls: [] };
			},
		};
		const runner = new SubagentRunner({ model, tools });
		const contract = { objective: "x", tools: ["read"], maxTurns: 2, maxInputTokens: 10_000 };
		const first = runner.run(contract);
		await expect(runner.run(contract)).rejects.toThrow(/one subagent/);
		release();
		await first;
	});

	it("a pipeline fails the acceptance check when an early stage fails", async () => {
		const exec = shellExec(process.cwd());
		expect((await exec("false | tail -1")).ok).toBe(false);
		expect((await exec("true | tail -1")).ok).toBe(true);
	});

	it("refuses a subagent with no allowed tools, and refuses nesting", async () => {
		const model: ModelPort = { complete: async () => ({ text: "", toolCalls: [] }) };
		await expect(new SubagentRunner({ model, tools }).run({ objective: "x", tools: [], maxTurns: 2, maxInputTokens: 10 })).rejects.toThrow(/at least one/);
		await expect(new SubagentRunner({ model, tools }, 1).run({ objective: "x", tools: ["read"], maxTurns: 2, maxInputTokens: 10 })).rejects.toThrow(/depth/);
	});
});
