import * as vscode from "vscode";
import { listSessions, openStore } from "../store";
import { log } from "../log";
import type { SessionDeps } from "./sessionController";
import { webAppUrl } from "../auth";
import { openAgentsPanel } from "./agentsPanel";

interface AgentsMessage {
	type: "open" | "refresh" | "newLocal" | "newCloud";
	name?: string;
	url?: string;
	cloud?: boolean;
	runId?: string;
}

/**
 * Devin-style "Agents" sidebar: an IDE / Cloud selector at top, then the
 * matching sessions (local) or cloud runs. Cloud mode opens the cloud agent
 * page in this window; IDE mode opens local sessions. The selected mode is
 * kept in the webview state so it survives hide/show.
 */
export class AgentsView implements vscode.WebviewViewProvider {
	static readonly viewId = "kronyx.agentsView";
	private view: vscode.WebviewView | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(private readonly deps: SessionDeps) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = this.html();
		view.webview.onDidReceiveMessage((m: AgentsMessage) => void this.onMessage(m));
		this.timer = setInterval(() => void this.refresh(), 5000);
		void this.refresh();
		view.onDidDispose(() => clearInterval(this.timer));
	}

	private async onMessage(m: AgentsMessage): Promise<void> {
		if (m.type === "refresh") return this.refresh();
		if (m.type === "newLocal") return void vscode.commands.executeCommand("kronyx.newSession");
		// New cloud agent → the Agent Mode overlay (its composer creates the session),
		// not a standalone editor tab.
		if (m.type === "newCloud") return openAgentsPanel(this.deps.context, this.deps);
		if (m.type === "open" && m.cloud && m.name) {
			// Cloud sessions open inside the Agent Mode overlay, not a dashboard tab.
			log("agents", `click → agents overlay "${m.name}"`);
			return openAgentsPanel(this.deps.context, this.deps, m.name);
		}
		if (m.type === "open" && m.url) return void vscode.env.openExternal(vscode.Uri.parse(m.url));
		if (m.type === "open" && m.name) {
			log("agents", `click → openSession "${m.name}"`);
			return void vscode.commands.executeCommand("kronyx.openSession", m.name);
		}
		log("agents", `unhandled message ${JSON.stringify(m).slice(0, 120)}`);
	}

	private async refresh(): Promise<void> {
		if (!this.view) return;
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.deps.context.globalStorageUri.fsPath;
		const d = await openStore(root);
		const runs = listSessions(d, 30).map((r) => ({
			session: r.session,
			task: r.title,
			status: r.status,
			at: r.lastAt,
			events: r.events,
			cloud: r.cloud,
			runId: r.runId,
		}));
		this.view.webview.postMessage({ type: "runs", runs, dashboard: webAppUrl() });
	}

	dispose(): void {
		clearInterval(this.timer);
	}

	private html(): string {
		return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body {
	padding: 0;
	margin: 0;
	height: 100vh;
	overflow: hidden;
	color: var(--vscode-foreground);
	background: var(--vscode-sideBar-background, var(--vscode-editor-background));
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
}
* { box-sizing: border-box; }
button { font: inherit; }
.shell {
	height: 100vh;
	display: flex;
	flex-direction: column;
}
.top {
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 12px;
	border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border, transparent));
	background: color-mix(in srgb, var(--vscode-sideBar-background, var(--vscode-editor-background)) 92%, var(--vscode-foreground) 8%);
}
.heading {
	display: flex;
	flex-direction: column;
	gap: 3px;
}
.eyebrow {
	font-size: 0.78em;
	font-weight: 600;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	color: var(--vscode-descriptionForeground);
}
.title {
	font-size: 1em;
	font-weight: 600;
	line-height: 1.3;
	color: var(--vscode-foreground);
}
.sub {
	font-size: 0.92em;
	line-height: 1.4;
	color: var(--vscode-descriptionForeground);
}
.controls {
	display: flex;
	flex-direction: column;
	gap: 8px;
}
.seg {
	display: flex;
	gap: 4px;
	padding: 3px;
	border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, transparent));
	border-radius: 10px;
	background: var(--vscode-editorWidget-background, var(--vscode-input-background));
}
.seg button {
	flex: 1;
	border: none;
	border-radius: 7px;
	padding: 6px 10px;
	cursor: pointer;
	background: transparent;
	color: var(--vscode-descriptionForeground);
	font-size: 0.92em;
}
.seg button.on {
	background: var(--vscode-button-background, #0e639c);
	color: var(--vscode-button-foreground, #fff);
}
.seg button:hover,
.act:hover,
.item:hover {
	background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.16));
}
.seg button.on:hover {
	background: var(--vscode-button-hoverBackground, var(--vscode-button-background, #1177bb));
}
.act {
	border: 1px solid var(--vscode-button-border, transparent);
	border-radius: 9px;
	padding: 7px 10px;
	cursor: pointer;
	background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
	color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
	text-align: left;
}
.act-label {
	display: block;
	font-size: 0.95em;
	font-weight: 600;
	line-height: 1.2;
}
.act-copy {
	display: block;
	margin-top: 2px;
	font-size: 0.84em;
	line-height: 1.35;
	color: var(--vscode-descriptionForeground);
}
.list-wrap {
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
}
.list-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 10px 12px 8px;
	font-size: 0.82em;
	font-weight: 600;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	color: var(--vscode-descriptionForeground);
}
.count {
	font-weight: 500;
	letter-spacing: 0;
	text-transform: none;
}
.list {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	overflow-x: hidden;
	padding: 0 6px 10px;
}
.item {
	display: flex;
	gap: 10px;
	width: 100%;
	padding: 10px;
	border: 1px solid transparent;
	border-radius: 10px;
	cursor: pointer;
	background: transparent;
	color: inherit;
	text-align: left;
}
.item + .item {
	margin-top: 2px;
}
.item:hover {
	border-color: var(--vscode-list-hoverBackground);
}
.item:focus-visible,
.seg button:focus-visible,
.act:focus-visible {
	outline: 1px solid var(--vscode-focusBorder);
	outline-offset: 1px;
}
.dot {
	width: 9px;
	height: 9px;
	margin-top: 5px;
	border-radius: 999px;
	flex: none;
	background: var(--vscode-descriptionForeground);
}
.dot.running {
	background: var(--vscode-charts-blue, #4fc1ff);
	box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-charts-blue, #4fc1ff) 22%, transparent);
	animation: pulse 1.2s infinite;
}
.dot.completed {
	background: var(--vscode-testing-iconPassed, #4caf50);
}
.dot.failed {
	background: var(--vscode-errorForeground, #f44336);
}
@keyframes pulse { 50% { opacity: 0.45; } }
.content {
	flex: 1;
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: 4px;
}
.row {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
}
.primary {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 0.98em;
	font-weight: 500;
	line-height: 1.35;
}
.badge {
	flex: none;
	border-radius: 999px;
	padding: 1px 7px;
	font-size: 0.78em;
	line-height: 1.5;
	color: var(--vscode-textLink-foreground);
	background: color-mix(in srgb, var(--vscode-textLink-foreground) 14%, transparent);
}
.meta {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 8px;
	min-width: 0;
	font-size: 0.85em;
	line-height: 1.35;
	color: var(--vscode-descriptionForeground);
}
.meta-name {
	min-width: 0;
	max-width: 100%;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.meta .sep {
	opacity: 0.55;
}
.status {
	text-transform: capitalize;
}
.empty {
	margin: 8px 6px 0;
	padding: 14px 12px;
	border: 1px dashed color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
	border-radius: 10px;
	background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-foreground) 10%);
}
.empty-title {
	font-size: 0.95em;
	font-weight: 600;
	margin-bottom: 4px;
}
.empty-copy {
	font-size: 0.9em;
	line-height: 1.45;
	color: var(--vscode-descriptionForeground);
}
</style></head><body>
<div class="shell">
	<div class="top">
		<div class="heading">
			<div class="eyebrow">Kronyx</div>
			<div class="title" id="title">Recent local sessions</div>
			<div class="sub" id="sub">Open earlier runs or start a new local session.</div>
		</div>
		<div class="controls">
			<div class="seg">
				<button id="mi">IDE</button>
				<button id="mc">Cloud</button>
			</div>
			<button class="act" id="na"><span class="act-label">New session</span><span class="act-copy">Start a fresh task in this workspace.</span></button>
		</div>
	</div>
	<div class="list-wrap">
		<div class="list-head"><span id="list-label">Recent sessions</span><span class="count" id="count"></span></div>
		<div id="list" class="list"></div>
	</div>
</div>
<script>
const vscode = acquireVsCodeApi();
let mode = (vscode.getState() || {}).mode || "ide";
let runs = [];
const list = document.getElementById("list");
const title = document.getElementById("title");
const sub = document.getElementById("sub");
const listLabel = document.getElementById("list-label");
const count = document.getElementById("count");
const modeBtns = { ide: document.getElementById("mi"), cloud: document.getElementById("mc") };
const newBtn = document.getElementById("na");

function setMode(next) {
	mode = next;
	vscode.setState({ mode });
	render();
}
modeBtns.ide.onclick = () => setMode("ide");
modeBtns.cloud.onclick = () => setMode("cloud");
newBtn.onclick = () => vscode.postMessage({ type: mode === "cloud" ? "newCloud" : "newLocal" });

const fmtAgo = (at) => {
	const s = Math.max(0, (Date.now() - at) / 1000);
	if (s < 60) return Math.floor(s) + "s ago";
	if (s < 3600) return Math.floor(s / 60) + "m ago";
	if (s < 86400) return Math.floor(s / 3600) + "h ago";
	return Math.floor(s / 86400) + "d ago";
};
const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const statusClass = (status) => status === "running" ? "running" : status === "failed" ? "failed" : "completed";
const statusLabel = (status) => status === "running" ? "Running" : status === "failed" ? "Failed" : "Completed";

function renderEmpty() {
	const empty = document.createElement("div");
	empty.className = "empty";
	empty.innerHTML = mode === "cloud"
		? '<div class="empty-title">No cloud agents yet</div><div class="empty-copy">Start a cloud run to have Kronyx work in a sandbox and come back with changes.</div>'
		: '<div class="empty-title">No local sessions yet</div><div class="empty-copy">Start a session to plan, edit, and verify work directly in this workspace.</div>';
	list.appendChild(empty);
}

function render() {
	const isCloud = mode === "cloud";
	modeBtns.ide.classList.toggle("on", !isCloud);
	modeBtns.cloud.classList.toggle("on", isCloud);
	title.textContent = isCloud ? "Recent cloud agents" : "Recent local sessions";
	sub.textContent = isCloud
		? "Jump back into cloud runs or launch a new agent in a sandbox."
		: "Open earlier runs or start a new local session.";
		newBtn.innerHTML = isCloud
		? '<span class="act-label">New cloud agent</span><span class="act-copy">Run in an E2B sandbox and review the result here.</span>'
		: '<span class="act-label">New session</span><span class="act-copy">Start a fresh task in this workspace.</span>';
	listLabel.textContent = isCloud ? "Recent cloud runs" : "Recent sessions";
	list.innerHTML = "";
	const shown = runs.filter((r) => (isCloud ? r.cloud : !r.cloud));
	count.textContent = shown.length ? String(shown.length) : "";
	if (!shown.length) {
		renderEmpty();
		return;
	}
	for (const r of shown) {
		const el = document.createElement("button");
		el.type = "button";
		el.className = "item";
		const cls = statusClass(r.status);
		const task = esc(r.task || r.session);
		const session = esc(r.session);
		const badge = r.cloud ? '<span class="badge">Cloud</span>' : "";
		const metaBits = [
			'<span class="status">' + statusLabel(r.status) + '</span>',
			r.at ? '<span>' + fmtAgo(r.at) + '</span>' : '<span>Just now</span>',
			r.events ? '<span>' + r.events + ' event' + (r.events === 1 ? '' : 's') + '</span>' : '',
		];
		el.innerHTML =
			'<span class="dot ' + cls + '"></span>' +
			'<span class="content">' +
				'<span class="row"><span class="primary" title="' + task + '">' + task + '</span>' + badge + '</span>' +
				'<span class="meta"><span class="meta-name" title="' + session + '">' + session + '</span><span class="sep">•</span>' + metaBits.filter(Boolean).join('<span class="sep">•</span>') + '</span>' +
			'</span>';
		el.onclick = () => vscode.postMessage({ type: "open", name: r.session, cloud: !!r.cloud, runId: r.runId });
		list.appendChild(el);
	}
}

window.addEventListener("message", (e) => {
	const msg = e.data;
	if (msg.type !== "runs") return;
	runs = msg.runs;
	render();
});
render();
vscode.postMessage({ type: "refresh" });
</script></body></html>`;
	}
}
