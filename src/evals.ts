import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AgentRunner, type ProviderSettings } from "./agent/runner";

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
	status: string;
	passed: boolean;
	details: string;
	iterations: number;
	durationMs: number;
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

/** Runs each eval case through a fresh AgentRunner (bypass mode, no approvals). */
export async function runSuite(
	root: string,
	settings: ProviderSettings,
	log: (line: string) => void,
): Promise<EvalResult[]> {
	const cases = await loadSuite(root);
	const results: EvalResult[] = [];
	for (const evalCase of cases) {
		log(`Eval "${evalCase.name}" started`);
		const started = Date.now();
		let status = "failed";
		let iterations = 0;
		const runner = new AgentRunner({
			workspaceRoot: root,
			relativePath: (abs) => path.relative(root, abs).split(path.sep).join("/"),
			isDirty: () => false,
			confirmWrite: async () => true,
			currentMode: () => "bypass",
			emit: (event) => {
				if (event.type === "run-finished") {
					status = event.status;
					iterations = event.iterations;
				}
			},
		});
		await runner.run(evalCase.task, settings);
		const details = await verify(root, evalCase);
		results.push({
			name: evalCase.name,
			status,
			passed: status === "completed" && details.length === 0,
			details: details.join("; "),
			iterations,
			durationMs: Date.now() - started,
		});
		log(`Eval "${evalCase.name}" ${results[results.length - 1].passed ? "passed" : "failed"}`);
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
	const passed = results.filter((r) => r.passed).length;
	await fs.writeFile(
		file,
		JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results }, null, 2),
	);
	return file;
}
