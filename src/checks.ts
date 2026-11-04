import { exec } from "node:child_process";
import * as vscode from "vscode";

export interface CheckResult {
	command: string;
	ok: boolean;
	output: string;
	durationMs: number;
}

export function checkCommands(): string[] {
	return vscode.workspace.getConfiguration("kronyx").get<string[]>("checks.commands", []);
}

export function checksOnFinish(): boolean {
	return vscode.workspace.getConfiguration("kronyx").get<boolean>("checks.runOnFinish", false);
}

const TIMEOUT = 120_000;
const MAX_OUTPUT = 4000;

export function runChecks(root: string): Promise<CheckResult[]> {
	const commands = checkCommands();
	return Promise.all(
		commands.map(
			(command) =>
				new Promise<CheckResult>((resolve) => {
					const started = Date.now();
					exec(command, { cwd: root, timeout: TIMEOUT }, (error, stdout, stderr) => {
						const output = `${stdout}${stderr}`.trim();
						resolve({
							command,
							ok: !error,
							output: output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}\n... (truncated)` : output,
							durationMs: Date.now() - started,
						});
					});
				}),
		),
	);
}
