/**
 * Command verifier (vscode-free). A task's acceptance is a shell command; it
 * passes when the command exits 0. Execution is injected, so the harness never
 * imports VS Code or the process layer. Reviewer acceptance is not enabled.
 */

import type { Task, VerifierPort } from "../core/contracts";

export interface ExecResult {
	ok: boolean;
	output: string;
}

export type ExecPort = (command: string) => Promise<ExecResult>;

export const VERIFIER_OUTPUT_CAP = 4000;

const cap = (text: string): string => (text.length > VERIFIER_OUTPUT_CAP ? `${text.slice(0, VERIFIER_OUTPUT_CAP)}\n...[truncated]` : text);

export class CommandVerifier implements VerifierPort {
	constructor(private readonly exec: ExecPort) {}

	async check(task: Task): Promise<{ ok: boolean; detail: string }> {
		if (task.acceptance.kind !== "command") {
			return { ok: false, detail: "reviewer acceptance is not enabled; use a command check" };
		}
		const { command } = task.acceptance;
		try {
			const result = await this.exec(command);
			return { ok: result.ok, detail: cap(`${result.ok ? "passed" : "failed"}: ${command}\n${result.output}`.trim()) };
		} catch (err) {
			return { ok: false, detail: `could not run ${command}: ${err instanceof Error ? err.message : String(err)}` };
		}
	}
}
