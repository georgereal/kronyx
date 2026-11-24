/** Shell execution for the command verifier (vscode-free). Exit 0 is a pass. */

import { exec } from "node:child_process";
import type { ExecPort } from "./verifier";

export const shellExec =
	(cwd: string, timeoutMs = 120_000): ExecPort =>
	(command) =>
		new Promise((resolve) => {
			exec(command, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
				resolve({ ok: !error, output: `${stdout}${stderr}`.trim() });
			});
		});
