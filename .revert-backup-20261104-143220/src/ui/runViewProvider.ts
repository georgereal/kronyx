import * as vscode from "vscode";
import type { RunViewEvent } from "../agent/runner";

export type WebviewMessage = { type: "run"; task: string } | { type: "stop" } | { type: "new" } | { type: "setApiKey" };

export class RunViewProvider implements vscode.WebviewViewProvider {
	static readonly viewId = "kronyx.runView";
	private view: vscode.WebviewView | undefined;
	private readonly backlog: RunViewEvent[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly onMessage: (message: WebviewMessage) => void,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const media = vscode.Uri.joinPath(this.extensionUri, "media");
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		view.webview.html = this.html(view.webview, media);
		view.webview.onDidReceiveMessage((message: WebviewMessage) => this.onMessage(message));
		view.onDidDispose(() => {
			this.view = undefined;
		});
		for (const event of this.backlog.splice(0)) void view.webview.postMessage(event);
	}

	post(event: RunViewEvent | { type: "reset" }): void {
		if (this.view) void this.view.webview.postMessage(event);
		else if (event.type !== "reset") this.backlog.push(event);
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "webview.js"));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, "webview.css"));
		const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
</head>
<body>
<div id="timeline" class="timeline"><p class="empty">No runs yet. Describe a change below.</p></div>
<form id="composer" class="composer">
  <textarea id="task" rows="3" placeholder="Describe the change you want..."></textarea>
  <div class="actions">
    <button type="submit" id="run">Run</button>
    <button type="button" id="stop" class="secondary" disabled>Stop</button>
    <button type="button" id="new" class="secondary">New task</button>
  </div>
  <div id="status" class="status">Idle</div>
</form>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}
