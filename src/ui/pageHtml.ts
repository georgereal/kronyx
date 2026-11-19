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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
</head>
<body>
<div id="cloudstatus" class="cloudstatus" hidden></div>
<div id="authbanner" class="authbanner" hidden>
  <span>Connect your Kronyx account to sync usage and settings across devices.</span>
  <button type="button" id="auth-signin">Sign in</button>
  <button type="button" id="auth-dismiss" class="auth-dismiss" title="Dismiss">&times;</button>
</div>
<div id="tabs" class="tabs"><button type="button" id="tab-prev" class="tab-new" title="Previous sessions">▾</button><span id="tab-list" class="tab-list"></span><button type="button" id="tab-right" class="tab-new" title="Scroll to latest tabs" hidden>»</button><button type="button" id="tab-new" class="tab-new" title="New session">+</button></div>
<div id="timeline" class="timeline"><p class="empty">No runs yet. Describe a change below.</p></div>
<div id="composer" class="composer">
  <textarea id="task" rows="3" placeholder="Ask, plan, or describe a change..."></textarea>
  <div id="attachment-previews" class="attachment-previews" hidden></div>
  <div class="composer-bar">
    <button type="button" id="attach" class="icon-btn" title="Add context">+</button>
    <button type="button" id="mention" class="icon-btn context-btn" title="Attach a file"><span class="context-glyph">/</span></button>
    <button type="button" id="mode" class="chip" title="Agent mode"><span class="chip-icon" id="mode-icon">&#9679;</span><span class="chip-text" id="mode-label">Code</span><span class="caret">&#9662;</span></button>
    <button type="button" id="workspace" class="chip workspace-chip" title="Workspace" hidden><span class="folder-glyph" aria-hidden="true"></span><span class="chip-text" id="workspace-label"></span></button>
    <span class="spacer"></span>
    <span id="tokchip" class="tok" title="Tokens in / out" hidden></span>
    <button type="button" id="model" class="chip model-chip" title="Model"><span class="chip-text" id="model-label">Model</span><span class="caret">&#9662;</span></button>
    <span id="activity" class="activity" title="Idle" aria-hidden="true"></span>
    <button type="button" id="microphone" class="icon-btn microphone" title="Voice input coming soon" disabled aria-label="Voice input coming soon"></button>
    <button type="button" id="send" class="send-btn" title="Run (Enter)">&#9166;</button>
    <button type="button" id="stop" class="send-btn stop" title="Stop" hidden>&#9632;</button>
  </div>
</div>
<div id="status" class="status" role="status" aria-live="polite">Idle</div>
<div id="menu" class="menu" hidden></div>
<script nonce="${nonce}" src="${markedJs}"></script>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
