import * as vscode from "vscode";

export function renderPage(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const media = vscode.Uri.joinPath(extensionUri, "media");
	const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "webview.js"));
	const markedJs = webview.asWebviewUri(vscode.Uri.joinPath(media, "marked.js"));
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
<div id="composer" class="composer">
  <textarea id="task" rows="3" placeholder="Ask, plan, or describe a change..."></textarea>
  <div class="composer-bar">
    <button type="button" id="attach" class="icon-btn" title="Add context">+</button>
    <button type="button" id="mode" class="chip" title="Agent mode"><span class="chip-icon" id="mode-icon">&#9679;</span><span class="chip-text" id="mode-label">Code</span><span class="caret">&#9662;</span></button>
    <button type="button" id="model" class="chip" title="Model"><span class="chip-icon">&#10022;</span><span class="chip-text" id="model-label">Model</span><span class="caret">&#9662;</span></button>
    <span id="tokchip" class="tok" title="Tokens in / out" hidden></span>
    <span class="spacer"></span>
    <button type="button" id="newsession" class="icon-btn" title="New session">&#10697;</button>
    <button type="button" id="newtask" class="icon-btn" title="New task">&#9998;</button>
    <button type="button" id="history" class="icon-btn" title="Run history">&#128337;</button>
    <button type="button" id="settings" class="icon-btn" title="Settings">&#9881;</button>
    <button type="button" id="send" class="send-btn" title="Run (Enter)">&#8593;</button>
    <button type="button" id="stop" class="send-btn stop" title="Stop" hidden>&#9632;</button>
  </div>
</div>
<div id="status" class="status">Idle</div>
<div id="menu" class="menu" hidden></div>
<script nonce="${nonce}" src="${markedJs}"></script>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
