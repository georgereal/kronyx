import * as vscode from "vscode";
import { listSessions, openStore } from "../store";
import { log } from "../log";
import type { SessionDeps } from "./sessionController";
import { webAppUrl } from "../auth";

interface AgentsMessage {
	type: "open" | "refresh" | "newLocal" | "newCloud";
	name?: string;
	url?: string;
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
		if (m.type === "newCloud") return void vscode.commands.executeCommand("kronyx.newCloudSession");
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
body { font: 12px var(--vscode-font-family); color: var(--vscode-foreground); padding: 0; margin: 0; }
.top { display: flex; flex-direction: column; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border, #333); }
.seg { display: flex; border: 1px solid var(--vscode-button-secondaryBackground, #3a3d41); border-radius: 4px; overflow: hidden; }
.seg button { flex: 1; border: none; padding: 4px 0; cursor: pointer; background: transparent; color: var(--vscode-descriptionForeground); font-size: 11px; }
.seg button.on { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
.act { border: none; border-radius: 3px; padding: 4px 0; cursor: pointer; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); font-size: 11px; }
.act:hover, .seg button:hover { opacity: 0.85; }
.item { display: flex; gap: 6px; padding: 5px 10px; cursor: pointer; align-items: baseline; }
.item:hover { background: var(--vscode-list-hoverBackground); }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; align-self: center; }
.dot.running { background: #4fc1ff; animation: pulse 1.2s infinite; }
.dot.completed { background: #4caf50; }
.dot.failed { background: #f44336; }
@keyframes pulse { 50% { opacity: 0.4; } }
.t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { color: var(--vscode-descriptionForeground); font-size: 10px; flex: none; }
.cloud { color: #7c9eff; font-size: 10px; }
.empty { padding: 14px 10px; color: var(--vscode-descriptionForeground); }
</style></head><body>
<div class="top">
	<div class="seg">
		<button id="mi">IDE</button>
		<button id="mc">Cloud ☁</button>
	</div>
	<button class="act" id="na">+ Session</button>
</div>
<div id="list"></div>
<script>
const vscode = acquireVsCodeApi();
let mode = (vscode.getState() || {}).mode || "ide";
let runs = [];
let dashboard = "";
const list = document.getElementById("list");
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
	if (s < 60) return Math.floor(s) + "s";
	if (s < 3600) return Math.floor(s / 60) + "m";
	if (s < 86400) return Math.floor(s / 3600) + "h";
	return Math.floor(s / 86400) + "d";
};

function render() {
	modeBtns.ide.classList.toggle("on", mode === "ide");
	modeBtns.cloud.classList.toggle("on", mode === "cloud");
	newBtn.textContent = mode === "cloud" ? "+ New cloud agent ☁" : "+ Session";
	list.innerHTML = "";
	const shown = runs.filter((r) => (mode === "cloud" ? r.cloud : !r.cloud));
	if (!shown.length) {
		const empty = document.createElement("div");
		empty.className = "empty";
		empty.textContent = mode === "cloud" ? "No cloud agents yet." : "No sessions yet.";
		list.appendChild(empty);
		return;
	}
	for (const r of shown) {
		const el = document.createElement("div");
		el.className = "item";
		const cls = r.status === "running" ? "running" : r.status === "failed" ? "failed" : "completed";
		const link = r.cloud && r.runId && dashboard ? dashboard + "/runs/" + r.runId : "";
		el.innerHTML = '<span class="dot ' + cls + '"></span><span class="t">' + (r.task || r.session).replace(/</g, "&lt;") +
			'</span>' + (r.cloud ? '<span class="cloud">☁</span>' : "") + '<span class="meta">' + fmtAgo(r.at) + "</span>";
		el.onclick = () => vscode.postMessage(link ? { type: "open", url: link } : { type: "open", name: r.session });
		list.appendChild(el);
	}
}

window.addEventListener("message", (e) => {
	const msg = e.data;
	if (msg.type !== "runs") return;
	runs = msg.runs;
	dashboard = msg.dashboard || "";
	render();
});
render();
vscode.postMessage({ type: "refresh" });
</script></body></html>`;
	}
}
