import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { FileEventLog } from "../harness/core/eventLog";
import { buildHarnessReport, type HarnessReport } from "../harness/report/report";
import { openStore, upsertHarnessReport } from "../store";

let panel: vscode.WebviewPanel | undefined;

type HarnessMessage =
	| { type: "list" }
	| { type: "report"; session: string; runId?: string }
	| { type: "upload"; session: string; runId: string };

/**
 * Live harness report: tails the session JSONL logs under .kronyx/harness/
 * and renders what the harness is planning, intervening on, spending, and
 * executing — while the run is still going. Works for every run in the log.
 */
export function openHarnessPage(context: vscode.ExtensionContext): void {
	if (panel) {
		panel.reveal();
		return;
	}
	panel = vscode.window.createWebviewPanel("kronyx.harnessReport", "Kronyx Harness Report", vscode.ViewColumn.Active, {
		enableScripts: true,
	});
	panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "kronyx.svg");
	const media = vscode.Uri.joinPath(context.extensionUri, "media");
	panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
	const js = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "harness.js"));
	const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "harness.css"));
	panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Kronyx Harness Report</title>
</head>
<body>
<header>
  <div class="title-row">
    <h1>Harness report <span id="live" class="live-badge" hidden>● live</span></h1>
    <div class="filters">
      <select id="session"><option value="">Select a session…</option></select>
      <select id="run"><option value="">All runs</option></select>
      <button id="refresh" title="Reload">⟳</button>
      <button id="upload" title="Queue this run's report for the dashboard (uploads on the next sync flush)">Queue ↗</button>
    </div>
  </div>
  <div class="hint" id="hint">Pick a session to see what the harness did.</div>
</header>
<main id="report"></main>
<script src="${js}"></script>
</body>
</html>`;
	panel.onDidDispose(() => {
		panel = undefined;
	});
	panel.webview.onDidReceiveMessage((m: HarnessMessage) => void handle(m));
	void panel.webview.postMessage({ type: "list" });
}

function harnessDir(): string | undefined {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	return root ? path.join(root, ".kronyx", "harness") : undefined;
}

/** Open logs keyed by file path — sync() tails only new lines on each poll. */
const openLogs = new Map<string, FileEventLog>();

async function logFor(file: string): Promise<FileEventLog> {
	let log = openLogs.get(file);
	if (!log) {
		log = await FileEventLog.open(file);
		openLogs.set(file, log);
	}
	return log;
}

async function listSessions(): Promise<{ name: string; file: string; at: number }[]> {
	const dir = harnessDir();
	if (!dir) return [];
	const entries = await fs.readdir(dir).catch(() => [] as string[]);
	const out: { name: string; file: string; at: number }[] = [];
	for (const file of entries.filter((f) => f.endsWith(".jsonl"))) {
		const stat = await fs.stat(path.join(dir, file)).catch(() => undefined);
		out.push({ name: file.slice(0, -".jsonl".length), file, at: stat?.mtimeMs ?? 0 });
	}
	return out.sort((a, b) => b.at - a.at);
}

async function readReport(session: string, runId?: string): Promise<{ report?: HarnessReport; error?: string }> {
	const dir = harnessDir();
	if (!dir) return { error: "No workspace folder open." };
	const file = path.join(dir, `${session.replace(/[^\w-]+/g, "-")}.jsonl`);
	try {
		const log = await logFor(file);
		await log.sync();
		return { report: buildHarnessReport(await log.read(), { runId }) };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

async function handle(message: HarnessMessage): Promise<void> {
	if (!panel) return;
	switch (message.type) {
		case "list": {
			const sessions = await listSessions();
			void panel.webview.postMessage({ type: "sessions", sessions });
			break;
		}
		case "report": {
			const { report, error } = await readReport(message.session, message.runId);
			void panel.webview.postMessage(error ? { type: "error", text: error } : { type: "report", report, runId: message.runId ?? "" });
			break;
		}
		case "upload": {
			const dir = harnessDir();
			const file = dir ? path.join(dir, `${message.session.replace(/[^\w-]+/g, "-")}.jsonl`) : "";
			try {
				const log = await logFor(file);
				await log.sync();
				const report = buildHarnessReport(await log.read(), { runId: message.runId });
				const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
				upsertHarnessReport(await openStore(root), { runId: message.runId, session: message.session, report }, root);
				void panel.webview.postMessage({ type: "queued", runId: message.runId });
			} catch (err) {
				void panel.webview.postMessage({ type: "error", text: `Queue failed: ${err instanceof Error ? err.message : String(err)}` });
			}
			break;
		}
	}
}
