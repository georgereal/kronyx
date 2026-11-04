import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function initLog(ch: vscode.OutputChannel): void {
	channel = ch;
}

export function log(scope: string, message: string): void {
	const line = `[kronyx:${scope}] ${message}`;
	channel?.appendLine(line);
	console.log(line);
}

export function logError(scope: string, error: unknown): void {
	const detail = error instanceof Error ? `${error.message}${error.stack ? `\n${error.stack}` : ""}` : String(error);
	const line = `[kronyx:${scope}] ERROR: ${detail}`;
	channel?.appendLine(line);
	channel?.show(true);
	console.error(line);
}