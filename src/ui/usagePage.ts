import * as vscode from "vscode";
import { listApiCalls, openStore, type ApiCallFilter } from "../store";

let panel: vscode.WebviewPanel | undefined;

type UsageMessage = { type: "query"; filter?: ApiCallFilter } | { type: "ready" } | { type: "openDashboard" };

/** Vercel/OpenRouter-style per-request usage log, served from the local api_calls ledger. */
export function openUsagePage(context: vscode.ExtensionContext): void {
	if (panel) {
		panel.reveal();
		return;
	}
	panel = vscode.window.createWebviewPanel("kronyx.usage", "Kronyx Usage", vscode.ViewColumn.Active, {
		enableScripts: true,
	});
	panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "kronyx.svg");
	const media = vscode.Uri.joinPath(context.extensionUri, "media");
	panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
	const js = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "usage.js"));
	const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "usage.css"));
	panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Kronyx Usage</title>
</head>
<body>
<header>
  <div class="title-row">
    <h1>AI Usage</h1>
    <div class="filters">
      <select id="range">
        <option value="3600000">Last hour</option>
        <option value="86400000" selected>Last 24h</option>
        <option value="604800000">Last 7d</option>
        <option value="0">All time</option>
      </select>
      <select id="model"><option value="">All models</option></select>
      <select id="status">
        <option value="">All statuses</option>
        <option value="ok">ok</option>
        <option value="failed">failed</option>
      </select>
      <button id="refresh" title="Refresh">⟳</button>
      <button id="dashboard" title="Open the cloud dashboard">Dashboard ↗</button>
    </div>
  </div>
  <canvas id="chart" height="48"></canvas>
  <div class="totals" id="totals"></div>
</header>
<table>
  <thead>
    <tr>
      <th>Time</th><th>Status</th><th>Model</th><th>Provider</th>
      <th class="num">Usage</th><th class="num">Cost <span class="est">est.</span></th>
      <th class="num">Duration</th><th>Key</th>
    </tr>
  </thead>
  <tbody id="rows"></tbody>
</table>
<div id="empty" hidden>No API calls recorded yet. Run a task to see per-request usage.</div>
<script src="${js}"></script>
</body>
</html>`;
	panel.onDidDispose(() => {
		panel = undefined;
	});
	panel.webview.onDidReceiveMessage((m: UsageMessage) => void handle(m));
	void import("../auth").then(({ webAppUrl }) => {
		if (!webAppUrl()) void panel?.webview.postMessage({ type: "noDashboard" });
	});
}

async function handle(message: UsageMessage): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const d = root ? await openStore(root) : undefined;
	switch (message.type) {
		case "openDashboard": {
			const { webAppUrl } = await import("../auth");
			const url = webAppUrl();
			if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
			break;
		}
		case "ready":
		case "query": {
			const filter = message.type === "query" ? (message.filter ?? {}) : {};
			const calls = listApiCalls(d, { limit: 2000, ...filter });
			const models = [...new Set(calls.map((c) => String(c.model)).filter(Boolean))].sort();
			void panel?.webview.postMessage({ type: "calls", calls, models });
			break;
		}
	}
}
