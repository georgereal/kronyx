import * as vscode from "vscode";
import { apiKey, webAppUrl } from "../auth";
import { writeProviderValue } from "../config";
import { listCloudSessions, createCloudSession, sendTask, workspaceRepo } from "../cloud/api";
import { openCloudSessionPanel, revealSession } from "./sessionPanel";
import type { SessionDeps } from "./sessionController";

let agentsPanel: vscode.WebviewPanel | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

interface AgentsMsg {
	type: string;
	task?: string;
	modelId?: string;
	name?: string;
	sessionId?: string;
	runId?: string;
	url?: string;
	href?: string;
}

interface RailSession {
	id: string;
	title: string;
	status: string;
	at: number;
	backend: boolean;
}

/** Returns true when the Agent Mode overlay is currently open. */
export function isAgentsPanelOpen(): boolean {
	return agentsPanel !== undefined;
}

function apiEndpoint(): string {
	return (vscode.workspace.getConfiguration("kronyx").get<string>("api.endpoint") ?? "").replace(/\/+$/, "");
}

/**
 * Agent Mode full-screen overlay. Layout on enter: sidebars + bottom panel are
 * hidden via the idempotent close* commands; on dispose the matching toggle*
 * commands bring them back.
 *
 * The right pane renders the REAL web session page — media/sessionPage.js is
 * the dashboard's sessions/[id] bundle (built by esbuild.mjs) talking to the
 * backend API with the krx_ key, so the IDE and the web share the same
 * session UI and the same backend runner.
 */
export function openAgentsPanel(context: vscode.ExtensionContext, deps: SessionDeps, selectSession?: string): void {
	if (agentsPanel) {
		agentsPanel.reveal();
		void pushState(agentsPanel.webview, context, deps);
		if (selectSession) void select(agentsPanel.webview, context, selectSession);
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		"kronyx.agents",
		"Kronyx Agent Mode",
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
		},
	);
	panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "kronyx.svg");
	panel.webview.html = html(panel.webview, context.extensionUri);
	agentsPanel = panel;

	void vscode.commands.executeCommand("workbench.action.closeSidebar");
	void vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
	void vscode.commands.executeCommand("workbench.action.closePanel");
	void vscode.commands.executeCommand("setContext", "kronyx.agentMode", true);

	panel.webview.onDidReceiveMessage((m: AgentsMsg) => void onMessage(context, deps, panel.webview, m));
	refreshTimer = setInterval(() => void pushState(panel.webview, context, deps), 5000);
	void pushState(panel.webview, context, deps);
	if (selectSession) void select(panel.webview, context, selectSession);

	panel.onDidChangeViewState((e) => {
		if (e.webviewPanel.visible) {
			void vscode.commands.executeCommand("workbench.action.closeSidebar");
			void vscode.commands.executeCommand("workbench.action.closePanel");
			void vscode.commands.executeCommand("setContext", "kronyx.agentMode", true);
		} else {
			void vscode.commands.executeCommand("setContext", "kronyx.agentMode", false);
		}
	});

	panel.onDidDispose(() => {
		agentsPanel = undefined;
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		void vscode.commands.executeCommand("setContext", "kronyx.agentMode", false);
		void vscode.commands.executeCommand("workbench.action.toggleSidebarVisibility");
		void vscode.commands.executeCommand("workbench.action.togglePanel");
	});
}

/** Dispose the overlay from outside (e.g. `kronyx.exitAgentMode` command). */
export function disposeAgentsPanel(): void {
	agentsPanel?.dispose();
}

/** Select a session: backend UUID → mount the bundled view; legacy "Cloud N" name → reveal its tab. */
async function select(webview: vscode.Webview, context: vscode.ExtensionContext, name: string): Promise<void> {
	if (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(name)) return mountSession(webview, context, name);
	revealSession(name);
}

/** Tell the webview to mount the bundled web session page for this session. */
async function mountSession(webview: vscode.Webview, context: vscode.ExtensionContext, sessionId: string): Promise<void> {
	const key = await apiKey(context);
	const endpoint = apiEndpoint();
	if (!key || !endpoint) return;
	void webview.postMessage({ type: "mountSession", sessionId, token: key, apiBase: endpoint, webBase: webAppUrl() });
}

async function pushState(webview: vscode.Webview, context: vscode.ExtensionContext, deps: SessionDeps): Promise<void> {
	const key = await apiKey(context);
	const endpoint = apiEndpoint();
	let sessions: RailSession[] = [];
	let backendError = "";
	if (key && endpoint) {
		try {
			sessions = (await listCloudSessions(endpoint, key)).map((s) => ({
				id: s.sessionId,
				title: s.title || s.sessionId.slice(0, 8),
				status: s.latestRunStatus ?? "",
				at: Date.parse(s.updatedAt ?? s.createdAt ?? "") || 0,
				backend: true,
			}));
		} catch (e) {
			backendError = e instanceof Error ? e.message : String(e);
		}
	}
	void webview.postMessage({
		type: "state",
		signedIn: !!(key && endpoint),
		backendError,
		sessions,
		modelId: deps.viewState.modelId,
		models: deps.viewState.models.map((m) => ({ id: m.id, label: m.label ?? m.id })),
		workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? "",
	});
}

async function onMessage(
	context: vscode.ExtensionContext,
	deps: SessionDeps,
	webview: vscode.Webview,
	m: AgentsMsg,
): Promise<void> {
	switch (m.type) {
		case "back":
			agentsPanel?.dispose();
			return;

		case "refresh":
			return pushState(webview, context, deps);

		case "signIn":
			void vscode.commands.executeCommand("kronyx.signIn");
			return;

		case "settings":
			void vscode.commands.executeCommand("kronyx.openSettings");
			return;

		case "start": {
			// New cloud agent: create the backend session, enqueue the task, then
			// mount the session view — identical pipeline to the web composer.
			const task = String(m.task ?? "").trim();
			if (!task) return;
			const key = await apiKey(context);
			const endpoint = apiEndpoint();
			if (!key || !endpoint) return;
			const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
			const repo = workspaceRepo(cwd);
			if (!repo) {
				void webview.postMessage({ type: "error", text: "No GitHub origin remote found in this workspace." });
				return;
			}
			try {
				const sessionId = await createCloudSession(endpoint, key, {
					repo,
					title: task,
					mode: "agent",
					modelId: deps.viewState.modelId || undefined,
				});
				await sendTask(endpoint, key, sessionId, task);
				void mountSession(webview, context, sessionId);
				setTimeout(() => void pushState(webview, context, deps), 1500);
			} catch (e) {
				void webview.postMessage({ type: "error", text: e instanceof Error ? e.message : String(e) });
			}
			return;
		}

		case "open": {
			// Backend session → mount the bundled session view in the right pane.
			if (m.sessionId) {
				void mountSession(webview, context, m.sessionId);
				return;
			}
			// Legacy local-store session → reveal its tab / dashboard.
			const name = String(m.name ?? "");
			if (name) {
				revealSession(name);
				if (m.runId) {
					const dash = webAppUrl();
					if (dash) void vscode.env.openExternal(vscode.Uri.parse(`${dash}/runs/${m.runId}`));
					else void vscode.commands.executeCommand("kronyx.openSession", name);
				} else {
					void vscode.commands.executeCommand("kronyx.openSession", name);
				}
			}
			return;
		}

		case "newCloudTab":
			openCloudSessionPanel(context, deps);
			return;

		case "nav":
		case "openExternal": {
			// Links inside the bundled session page (PRs, dashboard routes).
			const raw = String(m.url ?? m.href ?? "");
			if (!raw) return;
			const url = /^https?:/i.test(raw) ? raw : `${webAppUrl()}${raw.startsWith("/") ? raw : `/${raw}`}`;
			void vscode.env.openExternal(vscode.Uri.parse(url));
			return;
		}

		case "setModel": {
			const id = String(m.modelId ?? "");
			if (!id) return;
			await vscode.workspace.getConfiguration("kronyx").update("provider.modelId", id, vscode.ConfigurationTarget.Global);
			void writeProviderValue("provider.modelId", id);
			deps.viewState.modelId = id;
			return pushState(webview, context, deps);
		}
	}
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const media = vscode.Uri.joinPath(extensionUri, "media");
	const sessionJs = webview.asWebviewUri(vscode.Uri.joinPath(media, "sessionPage.js"));
	const sessionCss = webview.asWebviewUri(vscode.Uri.joinPath(media, "sessionPage.css"));
	const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; connect-src https: http: ws:; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource} https: data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${sessionCss}">
<style>
*, *::before, *::after { box-sizing: border-box; }
body {
	font: 13px var(--vscode-font-family, system-ui);
	color: var(--vscode-foreground);
	background: var(--vscode-editor-background);
	margin: 0;
	height: 100vh;
	display: flex;
	flex-direction: column;
	overflow: hidden;
}

/* ── Header bar ── */
.header {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 0 14px;
	height: 40px;
	flex: none;
	background: var(--vscode-titleBar-activeBackground, #1e1e1e);
	border-bottom: 1px solid var(--vscode-panel-border, #333);
	user-select: none;
	z-index: 60;
	position: relative;
}
.back-btn {
	display: flex;
	align-items: center;
	gap: 5px;
	border: none;
	background: transparent;
	color: var(--vscode-foreground);
	cursor: pointer;
	font-size: 12px;
	padding: 4px 8px;
	border-radius: 4px;
	opacity: 0.75;
}
.back-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08)); }
.header-title {
	flex: 1;
	text-align: center;
	font-size: 13px;
	font-weight: 600;
}
.header-title .cloud-icon { margin-right: 5px; opacity: 0.8; }
.sessions-btn, .settings-btn {
	border: none;
	background: transparent;
	color: var(--vscode-foreground);
	cursor: pointer;
	font-size: 13px;
	padding: 4px 8px;
	border-radius: 4px;
	opacity: 0.6;
}
.sessions-btn:hover, .settings-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08)); }
.sessions-btn { display: none; }
.sessions-btn.on { display: block; }

/* ── Body: rail + main ── */
.body { display: flex; flex: 1; overflow: hidden; }

/* ── Sessions rail ── */
.rail {
	width: 240px;
	flex: none;
	border-right: 1px solid var(--vscode-panel-border, #333);
	display: flex;
	flex-direction: column;
	background: var(--vscode-sideBar-background, #252526);
}
.rail-head {
	padding: 14px 14px 8px;
	font-size: 11px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.5px;
	color: var(--vscode-descriptionForeground);
	flex: none;
}
.new-btn {
	margin: 0 10px 10px;
	border: 1px solid var(--vscode-button-secondaryBorder, transparent);
	border-radius: 6px;
	padding: 7px 10px;
	cursor: pointer;
	background: var(--vscode-button-secondaryBackground, #3a3d41);
	color: var(--vscode-button-secondaryForeground, #fff);
	font-size: 12px;
	display: flex;
	align-items: center;
	gap: 6px;
	flex: none;
}
.new-btn:hover { opacity: 0.85; }
.rail-list { flex: 1; overflow-y: auto; }
.sess {
	display: flex;
	align-items: center;
	gap: 7px;
	padding: 7px 14px;
	cursor: pointer;
}
.sess:hover { background: var(--vscode-list-hoverBackground); }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dot.running, .dot.claimed, .dot.queued { background: #3b82f6; animation: pulse 1.4s ease-in-out infinite; }
.dot.failed { background: #ef4444; }
.dot.completed, .dot.idle { background: #22c55e; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
.sess-task { flex: 1; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sess-meta { font-size: 10.5px; color: var(--vscode-descriptionForeground); flex: none; }
.rail-empty { padding: 16px 14px; font-size: 12px; color: var(--vscode-descriptionForeground); }

/* ── Right / main panel ── */
.main {
	flex: 1;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	padding: 48px 32px;
	gap: 24px;
}
.main-heading { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
.main-sub { font-size: 13px; color: var(--vscode-descriptionForeground); margin-top: -18px; }
.composer {
	width: 100%;
	max-width: 660px;
	border: 1px solid var(--vscode-panel-border, #3c3c3c);
	border-radius: 12px;
	background: var(--vscode-input-background, #3c3c3c);
	padding: 14px 16px 12px;
}
.composer textarea {
	width: 100%;
	min-height: 72px;
	max-height: 220px;
	resize: vertical;
	border: none;
	outline: none;
	background: transparent;
	color: var(--vscode-foreground);
	font: inherit;
	font-size: 13px;
	line-height: 1.5;
}
.composer-bar { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.composer-bar select {
	flex: 1; max-width: 280px;
	background: var(--vscode-dropdown-background, #3c3c3c);
	color: var(--vscode-dropdown-foreground, #ccc);
	border: 1px solid var(--vscode-dropdown-border, #555);
	border-radius: 6px; padding: 4px 8px; font-size: 12px; font-family: inherit;
}
.workspace-label { font-size: 11.5px; color: var(--vscode-descriptionForeground); flex: none; }
.send-btn {
	width: 32px; height: 32px; border-radius: 50%; border: none; cursor: pointer;
	background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff);
	font-size: 15px; display: flex; align-items: center; justify-content: center; flex: none; margin-left: auto;
}
.send-btn:disabled { opacity: 0.35; cursor: default; }
.hint { font-size: 11.5px; color: var(--vscode-descriptionForeground); }
.error-line { font-size: 12px; color: #ef4444; }
.connect-card { text-align: center; display: flex; flex-direction: column; gap: 14px; align-items: center; }
.connect-btn {
	border: none; border-radius: 6px; padding: 8px 18px; cursor: pointer; font-size: 13px;
	background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff);
}

/* ── Bundled session page mounts here — flows under the fixed header so the
   DOCUMENT scrolls (the shared page reads window.scrollY/scrollTo/document-
   Element.scrollHeight for pin-to-bottom, history pagination, and scroll
   tracking — none of which fire if an inner div scrolls instead). ── */
body.session-on { display: block; height: auto; overflow: auto; }
body.session-on .header { position: fixed; top: 0; left: 0; right: 0; }
body.session-on .body { display: none; }
#kronyx-session-root {
	margin-top: 40px;
	min-height: calc(100vh - 40px);
	background: var(--vscode-editor-background, #1e1e1e);
}
</style>
</head>
<body>

<div class="header">
	<button class="back-btn" id="backBtn" title="Back to IDE">
		<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
			<path d="M7.5 2L3.5 6L7.5 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
		</svg>
		Back to IDE
	</button>
	<div class="header-title"><span class="cloud-icon">☁</span>Kronyx · Agent Mode</div>
	<button class="sessions-btn" id="sessionsBtn" title="Show sessions">≡ Sessions</button>
	<button class="settings-btn" id="settingsBtn" title="Settings">⚙</button>
</div>

<div class="body">
	<div class="rail">
		<div class="rail-head">Cloud Sessions</div>
		<button class="new-btn" id="newBtn"><span>＋</span> New cloud agent</button>
		<div class="rail-list" id="railList"></div>
	</div>

	<div class="main" id="mainPanel">
		<div class="main-heading">Kronyx Agent Mode</div>
		<div class="main-sub" id="mainSub">Start a cloud agent run on your repository.</div>
		<div class="composer" id="composer">
			<textarea id="taskInput" placeholder="Describe the task for the cloud agent…"></textarea>
			<div class="composer-bar">
				<select id="modelSelect"></select>
				<span class="workspace-label" id="workspaceLabel"></span>
				<button class="send-btn" id="sendBtn" title="Run (⌘Enter)">↑</button>
			</div>
		</div>
		<div class="connect-card" id="connectCard" hidden>
			<div>Sign in to use cloud agents — sessions run on the Kronyx backend and appear in the dashboard too.</div>
			<button class="connect-btn" id="connectBtn">Connect account</button>
		</div>
		<div class="error-line" id="errorLine"></div>
		<div class="hint">⌘Enter to submit · Cloud agent runs in a sandbox and opens a PR</div>
	</div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
// Injected BEFORE sessionPage.js loads — the bundle uses this for nav links
// (next/link shim) instead of calling acquireVsCodeApi itself (one-shot API).
window.__kronyxPost = (m) => vscode.postMessage(m);
let st = { signedIn: false, backendError: "", sessions: [], modelId: "", models: [], workspace: "" };
let sessionMounted = false;

const $ = (id) => document.getElementById(id);
const fmtAgo = (at) => {
	const s = Math.max(0, (Date.now() - at) / 1000);
	if (s < 60) return Math.floor(s) + "s";
	if (s < 3600) return Math.floor(s / 60) + "m";
	if (s < 86400) return Math.floor(s / 3600) + "h";
	return Math.floor(s / 86400) + "d";
};

function renderRail() {
	const list = $("railList");
	list.innerHTML = "";
	if (!st.sessions.length) {
		list.innerHTML = '<div class="rail-empty">' + (st.signedIn ? "No cloud sessions yet." : "Sign in to see sessions.") + "</div>";
		return;
	}
	for (const r of st.sessions) {
		const el = document.createElement("div");
		el.className = "sess";
		const cls = (r.status || "idle").toLowerCase();
		el.innerHTML =
			'<span class="dot ' + cls + '"></span>' +
			'<span class="sess-task">' + String(r.title || r.id).replace(/</g, "&lt;") + "</span>" +
			'<span class="sess-meta">' + fmtAgo(r.at) + "</span>";
		el.onclick = () => {
			if (r.backend) vscode.postMessage({ type: "open", sessionId: r.id });
			else vscode.postMessage({ type: "open", name: r.id });
		};
		list.appendChild(el);
	}
}

function renderModels() {
	const sel = $("modelSelect");
	const cur = sel.value || st.modelId;
	sel.innerHTML = "";
	for (const m of st.models) {
		const o = document.createElement("option");
		o.value = m.id;
		o.textContent = m.label || m.id;
		sel.appendChild(o);
	}
	if (cur) sel.value = cur;
}

function render() {
	renderRail();
	renderModels();
	$("workspaceLabel").textContent = st.workspace || "";
	$("composer").hidden = !st.signedIn;
	$("connectCard").hidden = st.signedIn;
	$("mainSub").textContent = st.signedIn ? "Start a cloud agent run on your repository." : "Connect your Kronyx account to run cloud agents.";
	if (st.backendError) $("errorLine").textContent = "Backend: " + st.backendError;
}

$("backBtn").onclick = () => vscode.postMessage({ type: "back" });
$("settingsBtn").onclick = () => vscode.postMessage({ type: "settings" });
$("connectBtn").onclick = () => vscode.postMessage({ type: "signIn" });
$("sessionsBtn").onclick = () => {
	window.KronyxSession?.unmount();
	sessionMounted = false;
	$("sessionsBtn").classList.remove("on");
	document.body.classList.remove("session-on");
};
$("newBtn").onclick = () => { if (sessionMounted) $("sessionsBtn").click(); $("taskInput").focus(); };

function submit() {
	const task = $("taskInput").value.trim();
	if (!task) return;
	vscode.postMessage({ type: "start", task });
	$("taskInput").value = "";
}
$("sendBtn").onclick = submit;
$("taskInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); });
$("modelSelect").onchange = () => vscode.postMessage({ type: "setModel", modelId: $("modelSelect").value });

window.addEventListener("message", (e) => {
	const msg = e.data;
	if (msg.type === "state") { st = msg; render(); }
	else if (msg.type === "mountSession") {
		window.KronyxSession.mount({ sessionId: msg.sessionId, token: msg.token, apiBase: msg.apiBase, webBase: msg.webBase });
		sessionMounted = true;
		$("sessionsBtn").classList.add("on");
		document.body.classList.add("session-on");
	}
	else if (msg.type === "error") { $("errorLine").textContent = msg.text || ""; }
});

vscode.postMessage({ type: "refresh" });
</script>
<script src="${sessionJs}"></script>
</body>
</html>`;
}
