import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ProviderSettings, RunnerHost } from "./agent/types";
import type { AgentEngine, EngineKind } from "./agent/engine";
import { resolveShape } from "./harness/adapters/apiShapes";
import { HarnessAgentEngine } from "./harness/agentEngine";
import { MemoryEventLog } from "./harness/core/eventLog";

export interface EvalCase {
	name: string;
	task: string;
	expect?: {
		fileContains?: { path: string; text: string }[];
		commands?: string[];
	};
}

export interface EvalResult {
	name: string;
	model?: string;
	status: string;
	passed: boolean;
	details: string;
	iterations: number;
	durationMs: number;
	engine?: EngineKind;
	inputTokens?: number;
	cachedTokens?: number;
	outputTokens?: number;
	toolCalls?: number;
}

interface EvalSuiteFile {
	cases?: EvalCase[];
}

export function evalSuitePath(root: string): string {
	const configured = vscode.workspace.getConfiguration("kronyx").get<string>("eval.suite", ".kronyx/evals.json");
	return path.isAbsolute(configured) ? configured : path.join(root, configured);
}

export async function loadSuite(root: string): Promise<EvalCase[]> {
	const raw = await fs.readFile(evalSuitePath(root), "utf8");
	const parsed = JSON.parse(raw) as EvalSuiteFile | EvalCase[];
	return Array.isArray(parsed) ? parsed : (parsed.cases ?? []);
}

/**
 * Runs each eval case through a fresh engine per engine kind (bypass mode, no
 * approvals). Passing both kinds gives a like-for-like comparison on the same tasks.
 */
export async function runSuite(
	root: string,
	settings: ProviderSettings,
	log: (line: string) => void,
	engines: EngineKind[] = ["cline"],
): Promise<EvalResult[]> {
	const cases = await loadSuite(root);
	const results: EvalResult[] = [];
	for (const engine of engines) {
		// Same matrix rules as the product path: "auto"/"openai" resolve to the best
		// shape the provider serves; an explicit shape the matrix doesn't support
		// fails loudly instead of running a different protocol than asked.
		const pref = engine === "cline" ? "cline" : engine === "auto" || engine === "openai" || engine === "harness" ? "auto" : engine;
		const resolved = resolveShape(settings.providerId, settings.baseUrl, pref as Parameters<typeof resolveShape>[2]);
		if (!resolved.ok) {
			log(`Eval engine "${engine}": ${resolved.message}`);
			for (const evalCase of cases) {
				results.push({
					name: evalCase.name, model: settings.modelId, engine, status: "failed", passed: false,
					details: resolved.message, iterations: 0, durationMs: 0,
					inputTokens: 0, cachedTokens: 0, outputTokens: 0, toolCalls: 0,
				});
			}
			continue;
		}
		const tag = engine === "auto" || engine === "openai" ? `${engine}:${resolved.shape}` : engine;
		for (const evalCase of cases) {
			log(`Eval "${evalCase.name}" [${tag}] started`);
			const started = Date.now();
			const m = { status: "failed", iterations: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, toolCalls: 0 };
			const host: RunnerHost = {
				ideTools: true,
				workspaceRoot: root,
				relativePath: (abs) => path.relative(root, abs).split(path.sep).join("/"),
				isDirty: () => false,
				approvals: { confirm: async () => true },
				currentMode: () => "bypass",
				planDir: `${root}/.kronyx/plans`,
				emit: (event) => {
					if (event.type === "run-finished") {
						m.status = event.status;
						m.iterations = event.iterations;
					} else if (event.type === "usage") {
						m.inputTokens = event.inputTokens;
						m.cachedTokens = event.cacheReadTokens;
						m.outputTokens = event.outputTokens;
					} else if (event.type === "tool-started") m.toolCalls++;
				},
			};
			const agent: AgentEngine = new HarnessAgentEngine({
				host,
				log: new MemoryEventLog(),
				runId: `eval-${evalCase.name}-${engine}`,
				sessionId: `eval-${evalCase.name}`,
				transport: resolved.shape,
			});
			await agent.run(evalCase.task, settings);
			const details = await verify(root, evalCase);
			const passed = m.status === "completed" && details.length === 0;
			results.push({
				name: evalCase.name,
				model: settings.modelId,
				engine,
				status: m.status,
				passed,
				details: details.join("; "),
				iterations: m.iterations,
				durationMs: Date.now() - started,
				inputTokens: m.inputTokens,
				cachedTokens: m.cachedTokens,
				outputTokens: m.outputTokens,
				toolCalls: m.toolCalls,
			});
			log(`Eval "${evalCase.name}" [${engine}] ${passed ? "passed" : "failed"}`);
		}
	}
	return results;
}

async function verify(root: string, evalCase: EvalCase): Promise<string[]> {
	const failures: string[] = [];
	for (const check of evalCase.expect?.fileContains ?? []) {
		const content = await fs.readFile(path.join(root, check.path), "utf8").catch(() => "");
		if (!content.includes(check.text)) failures.push(`${check.path} does not contain "${check.text.slice(0, 60)}"`);
	}
	for (const command of evalCase.expect?.commands ?? []) {
		const ok = await new Promise<boolean>((resolve) =>
			exec(command, { cwd: root, timeout: 120_000 }, (error) => resolve(!error)),
		);
		if (!ok) failures.push(`command failed: ${command}`);
	}
	return failures;
}

export async function writeReport(root: string, results: EvalResult[]): Promise<string> {
	const file = path.join(root, ".kronyx", "eval-report.json");
	await fs.mkdir(path.dirname(file), { recursive: true });
	const at = Date.now();
	try {
		const { openStore, insertEvalResult } = await import("./store");
		const d = await openStore(root);
		for (const r of results) insertEvalResult(d, { ...r, at }, root);
	} catch { /* eval persistence is best-effort */ }
	const passed = results.filter((r) => r.passed).length;
	await fs.writeFile(
		file,
		JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results }, null, 2),
	);
	return file;
}
