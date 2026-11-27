import * as vscode from "vscode";

declare const __BUILD_ID__: string;

export function renderPage(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const media = vscode.Uri.joinPath(extensionUri, "media");
	const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "webview.js"));
	const queueJs = webview.asWebviewUri(vscode.Uri.joinPath(media, "eventQueue.js"));
	const markedJs = webview.asWebviewUri(vscode.Uri.joinPath(media, "marked.js"));
	const highlightJs = webview.asWebviewUri(vscode.Uri.joinPath(media, "highlight.js"));
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
<div id="phase" class="phase" hidden><span class="phase-dot"></span><span id="phase-text"></span></div>
<div id="composer" class="composer">
  <textarea id="task" rows="1" placeholder="Ask, plan, or describe a change..."></textarea>
  <div id="attachment-previews" class="attachment-previews" hidden></div>
  <div class="composer-bar">
    <button type="button" id="attach" class="icon-btn" title="Add context"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg></button>
    <button type="button" id="mention" class="icon-btn context-btn" title="Attach a file"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/></svg></button>
    <button type="button" id="mode" class="chip" title="Agent mode"><span class="chip-icon" id="mode-icon"></span><span class="chip-text" id="mode-label">Code</span><span class="caret">&#9662;</span></button>
    <button type="button" id="engine" class="chip" title="Execution engine"><span class="chip-text" id="engine-label">Cline</span><span class="caret">&#9662;</span></button>
    <button type="button" id="harness-toggle" class="icon-btn" title="Show harness comments (kronyx plan lines)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg></button>
    <span class="spacer"></span>
    <span id="tokchip" class="tok" title="Tokens in / out" hidden></span>
    <button type="button" id="model" class="chip model-chip" title="Model"><span class="chip-text" id="model-label">Model</span><span class="caret">&#9662;</span></button>
    <button type="button" id="activity" class="activity" title="Context usage" aria-label="Context usage" aria-expanded="false"><svg viewBox="0 0 16 16"><circle class="activity-track" cx="8" cy="8" r="6"/><circle id="activity-fill" class="activity-fill" cx="8" cy="8" r="6"/></svg></button>
    <button type="button" id="microphone" class="icon-btn microphone" title="Voice input coming soon" disabled aria-label="Voice input coming soon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/></svg></button>
    <button type="button" id="send" class="send-btn" title="Run (Enter)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg></button>
    <button type="button" id="stop" class="send-btn stop" title="Stop" hidden><svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="7" y="7" width="10" height="10" rx="2"/></svg></button>
  </div>
</div>
<div id="status" class="status" role="status" aria-live="polite">Idle</div>
<div id="menu" class="menu" hidden></div>
<div id="context-popover" class="context-popover" hidden></div>
<script nonce="${nonce}">globalThis.KRONYX_BUILD=${JSON.stringify(__BUILD_ID__)};</script>
<script nonce="${nonce}" src="${markedJs}"></script>
<script nonce="${nonce}" src="${highlightJs}"></script>
<script nonce="${nonce}" src="${queueJs}"></script>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
