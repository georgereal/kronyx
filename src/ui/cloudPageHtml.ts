import * as vscode from "vscode";

/** Dedicated Devin-style cloud-agent page: header + split timeline/workspace. */
export function renderCloudPage(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const media = vscode.Uri.joinPath(extensionUri, "media");
	const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "cloud.js"));
	const markedJs = webview.asWebviewUri(vscode.Uri.joinPath(media, "marked.js"));
	const style = webview.asWebviewUri(vscode.Uri.joinPath(media, "cloud.css"));
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
<header id="hdr">
	<span id="hdr-icon">☁</span>
	<span id="hdr-status" class="hdr-status">Idle</span>
	<span id="hdr-repo" class="chip mono" hidden></span>
	<span id="hdr-branch" class="chip mono" hidden></span>
	<a id="hdr-pr" class="pr" hidden target="_blank"></a>
	<button id="setupchip" class="setupchip" title="Setup status">…</button>
	<div id="setupmenu" class="setupmenu" hidden></div>
</header>
<main id="split">
	<section id="left">
		<div id="timeline" class="timeline"><div class="empty">Describe a task for the cloud agent.</div></div>
		<div id="composer">
			<textarea id="task" rows="2" placeholder="Describe a task for the cloud agent…"></textarea>
			<div class="bar">
				<span class="spacer"></span>
				<button id="send" title="Run (Enter)">↑</button>
				<button id="stop" class="stop" title="Stop" hidden>■</button>
			</div>
		</div>
	</section>
	<section id="right">
		<div id="tabs">
			<button class="tab active" data-tab="files">Files</button>
			<button class="tab" data-tab="diff">Diff</button>
			<button class="tab" data-tab="shell">Shell</button>
		</div>
		<div id="pane-files" class="pane active"></div>
		<div id="pane-diff" class="pane"><div class="pane-empty">Diffs appear here as files change.</div></div>
		<div id="pane-shell" class="pane"></div>
	</section>
</main>
<script nonce="${nonce}" src="${markedJs}"></script>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
