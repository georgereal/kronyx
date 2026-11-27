/** Shell execution for the command verifier (vscode-free). Exit 0 is a pass; a pipeline passes only if every stage does. */

import { exec } from "node:child_process";
import type { ExecPort } from "../defaults/verifier";

const shell = process.platform === "win32" ? undefined : "/bin/bash";

export const shellExec =
	(cwd: string, timeoutMs = 120_000): ExecPort =>
	(command) =>
		new Promise((resolve) => {
			const script = shell ? `set -o pipefail; ${command}` : command;
			exec(script, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, shell }, (error, stdout, stderr) => {
				resolve({ ok: !error, output: `${stdout}${stderr}`.trim() });
			});
		});
