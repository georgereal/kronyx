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
 * Devin-style "Agents" sidebar: live sessions + recent runs, with a
 * cloud/local new-session row at top. Clicking a cloud run with a synced
 * runId opens its dashboard detail page.
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
		}));
		this.view.webview.postMessage({ type: "runs", runs, dashboard: webAppUrl() });
	}

	dispose(): void {
		clearInterval(this.timer);
	}

	private html(): string {
		return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body { font: 12px var(--vscode-font-family); color: var(--vscode-foreground); padding: 0; margin: 0; }
.top { display: flex; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border, #333); }
.top button { flex: 1; border: none; border-radius: 3px; padding: 3px 0; cursor: pointer; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); font-size: 11px; }
.top button:hover { opacity: 0.85; }
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
	<button id="nl">+ Session</button>
	<button id="nc">+ Cloud ☁</button>
</div>
<div id="list"></div>
<script>
const vscode = acquireVsCodeApi();
document.getElementById("nl").onclick = () => vscode.postMessage({ type: "newLocal" });
document.getElementById("nc").onclick = () => vscode.postMessage({ type: "newCloud" });
const list = document.getElementById("list");
const fmtAgo = (at) => {
	const s = Math.max(0, (Date.now() - at) / 1000);
	if (s < 60) return Math.floor(s) + "s";
	if (s < 3600) return Math.floor(s / 60) + "m";
	if (s < 86400) return Math.floor(s / 3600) + "h";
	return Math.floor(s / 86400) + "d";
};
window.addEventListener("message", (e) => {
	const msg = e.data;
	if (msg.type !== "runs") return;
	list.innerHTML = "";
	if (!msg.runs.length) { list.innerHTML = '<div class="empty">No runs yet.</div>'; return; }
	for (const r of msg.runs) {
		const el = document.createElement("div");
		el.className = "item";
		const cls = r.status === "running" ? "running" : r.status === "failed" ? "failed" : "completed";
		const link = r.cloud && r.runId && msg.dashboard ? msg.dashboard + "/runs/" + r.runId : "";
		el.innerHTML = '<span class="dot ' + cls + '"></span><span class="t">' + (r.task || r.session).replace(/</g, "&lt;") +
			'</span>' + (r.cloud ? '<span class="cloud">☁</span>' : "") + '<span class="meta">' + fmtAgo(r.at) + "</span>";
		el.onclick = () => vscode.postMessage(link ? { type: "open", url: link } : { type: "open", name: r.session });
		list.appendChild(el);
	}
});
vscode.postMessage({ type: "refresh" });
</script></body></html>`;
	}
}
