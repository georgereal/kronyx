import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;
const filePaths: string[] = [];

export function initLog(ch: vscode.OutputChannel, logFiles?: string | string[]): void {
	channel = ch;
	for (const f of [logFiles ?? []].flat()) {
		try {
			fs.mkdirSync(path.dirname(f), { recursive: true });
			filePaths.push(f);
		} catch {
			/* skip unwritable log target */
		}
	}
}

const toFile = (line: string) => {
	for (const f of filePaths) {
		try {
			fs.appendFile(f, line + "\n", () => {});
		} catch {
			/* never break on logging */
		}
	}
};

export function log(scope: string, message: string): void {
	const line = `[kronyx:${scope}] ${message}`;
	channel?.appendLine(line);
	toFile(line);
	console.log(line);
}

export function logError(scope: string, error: unknown): void {
	const detail = error instanceof Error ? `${error.message}${error.stack ? `\n${error.stack}` : ""}` : String(error);
	const line = `[kronyx:${scope}] ERROR: ${detail}`;
	channel?.appendLine(line);
	toFile(line);
	channel?.show(true);
	console.error(line);
}
