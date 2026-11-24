import * as vscode from "vscode";
import { apiKey, webAppUrl } from "../auth";
import { currentSelection, pickModel, type ModelOption } from "../config";
import { listCloudSessions, createCloudSession, sendTask, workspaceRepo } from "../cloud/api";
import { openCloudSessionPanel, revealSession } from "./sessionPanel";
import type { SessionDeps } from "./sessionController";

let agentsPanel: vscode.WebviewPanel | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

interface AgentsMsg {
	type: string;
	task?: string;
	modelId?: string;
	profile?: string;
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
	// Keys are minted by the web app's backend, so prefer it — the web app
	// proxies /api/* to the backend. An api.endpoint pointing at a different
	// backend won't recognize those keys (401).
	const explicit = vscode.workspace.getConfiguration("kronyx").get<string>("api.endpoint") ?? "";
	return (webAppUrl() || explicit).replace(/\/+$/, "");
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
		if (selectSession) void select(agentsPanel.webview, context, deps, selectSession);
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
	if (selectSession) void select(panel.webview, context, deps, selectSession);

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

/** Select a session: backend UUID → mount the bundled view; otherwise match a
 *  backend session by title; legacy "Cloud N" name → reveal its tab. */
async function select(webview: vscode.Webview, context: vscode.ExtensionContext, deps: SessionDeps, name: string): Promise<void> {
	if (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(name)) return mountSession(webview, context, deps, name);
	// Agents sidebar passes local session names, but the backend may have a
	// session with the same title — mount it instead of opening the local tab.
	const key = await apiKey(context);
	const endpoint = apiEndpoint();
	if (key && endpoint) {
		try {
			const match = (await listCloudSessions(endpoint, key)).find((s) => s.title === name || s.sessionId === name);
			if (match) return mountSession(webview, context, deps, match.sessionId);
		} catch { /* fall through to local reveal */ }
	}
	revealSession(name);
}

/** Tell the webview to mount the bundled web session page (sessionId), or the
 *  web's new-session page when no sessionId is given. */
async function mountSession(webview: vscode.Webview, context: vscode.ExtensionContext, deps: SessionDeps, sessionId?: string): Promise<void> {
	const key = await apiKey(context);
	const endpoint = apiEndpoint();
	if (!key || !endpoint) {
		if (sessionId) void webview.postMessage({ type: "error", text: "Not connected to the Kronyx backend — check sign-in and endpoints." });
		return;
	}
	const selection = currentSelection();
	const modelId = selection?.modelId ?? "";
	const modelProfile = selection?.profile ?? "";
	// Seed local BYOK provider catalogs so the embedded composer's provider
	// filter works even when backend settings sync hasn't pushed profiles yet.
	const groups = (deps.viewState.groups ?? []).map((g) => ({
		profile: g.profile,
		active: g.active,
		models: g.models.map(pickerOption),
	}));
	void webview.postMessage({ type: sessionId ? "mountSession" : "showNew", sessionId, token: key, apiBase: endpoint, webBase: webAppUrl(), modelId, modelProfile, groups });
}

const perMtok = (v?: number) => (v === undefined ? "?" : `$${(v * 1e6).toFixed(v * 1e6 < 1 ? 2 : 1)}`);
const pickerOption = (m: ModelOption) => ({
	id: m.id,
	label: m.label ?? m.id,
	hint: m.pricing && (m.pricing.input !== undefined || m.pricing.output !== undefined) ? ` · ${perMtok(m.pricing.input)}/${perMtok(m.pricing.output)} per Mtok` : "",
});

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
		modelId: currentSelection()?.modelId ?? "",
		modelProfile: currentSelection()?.profile ?? "",
		models: deps.viewState.models.map(pickerOption),
		groups: (deps.viewState.groups ?? []).map((g) => ({ profile: g.profile, active: g.active, models: g.models.map(pickerOption) })),
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
			const pick = { modelId: String(m.modelId ?? ""), profile: String(m.profile ?? "") };
			if (!pick.modelId || !pick.profile) {
				void webview.postMessage({ type: "error", text: "Pick a model and its provider before starting a cloud agent." });
				return;
			}
			try {
				const sessionId = await createCloudSession(endpoint, key, { repo, title: task, mode: "agent", ...pick });
				await sendTask(endpoint, key, sessionId, task, pick);
				void mountSession(webview, context, deps, sessionId);
				setTimeout(() => void pushState(webview, context, deps), 1500);
			} catch (e) {
				void webview.postMessage({ type: "error", text: e instanceof Error ? e.message : String(e) });
			}
			return;
		}

		case "open": {
			// Backend session → mount the bundled session view in the right pane.
			if (m.sessionId) {
				void mountSession(webview, context, deps, m.sessionId);
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

		case "newPage":
			return mountSession(webview, context, deps);

		case "nav":
		case "openExternal": {
			// Links inside the bundled pages (PRs, dashboard routes). Session and
			// new-agent routes stay in the panel; everything else opens the dashboard.
			const raw = String(m.url ?? m.href ?? "");
			if (!raw) return;
			const path = raw.startsWith(webAppUrl()) ? raw.slice(webAppUrl().length) : raw;
			const route = path.match(/^\/sessions\/([0-9a-f-]{36})\/?$/i);
			if (route) return mountSession(webview, context, deps, route[1]);
			if (/^\/sessions\/?$/.test(path)) return mountSession(webview, context, deps);
			const url = /^https?:/i.test(raw) ? raw : `${webAppUrl()}${raw.startsWith("/") ? raw : `/${raw}`}`;
			void vscode.env.openExternal(vscode.Uri.parse(url));
			return;
		}

		case "setModel": {
			const id = String(m.modelId ?? "");
			const profile = String(m.profile ?? "");
			if (!id || !profile) return;
			await pickModel(id, profile);
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
[hidden] { display: none !important; }
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
#providerSelect { flex: none; max-width: 150px; }
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
body.session-on .main { display: none; }
/* Keep the rail as a fixed side panel next to the mounted session (mirrors
   the dashboard's session sidebar); the document still scrolls for the
   shared page's pin-to-bottom logic. */
body.session-on .rail {
	position: fixed;
	top: 40px;
	left: 0;
	bottom: 0;
	width: 240px;
	z-index: 50;
	overflow-y: auto;
}
body.session-on #kronyx-session-root { margin-left: 240px; }
/* The shared page's sticky session header (Clear / … buttons) pins to top:0 —
   push it below our fixed title bar so it isn't covered. */
body.session-on #kronyx-session-root .page > div:first-child { top: 40px !important; }
/* The shared page docks the composer with position:fixed (tuned for the web
   Shell, which also pads its content so nothing hides under the dock). The
   IDE has no Shell padding, so the dock covered the last messages. Sticky at
   the bottom of the session column keeps it pinned while taking real space in
   the flow; center the dock contents in an 820px column like the web. */
body.session-on { overflow-x: hidden; }
body.session-on .sess-body { justify-content: flex-start; }
/* The shared page caps the timeline column at 860px (inline style), which also
   caps the docked composer. Use the full Agent Mode width for both. */
body.session-on .sess-body > div:first-child { max-width: none !important; width: 100% !important; padding-left: 16px !important; padding-right: 16px !important; }
/* The multi-agent side panel (264px) beside the timeline narrowed the column
   and the composer docked inside it. Stack the panel below the timeline in the
   IDE, as the web does at narrow widths, so the composer gets the full width. */
body.session-on .sess-body { flex-direction: column; align-items: stretch; }
body.session-on .ma-panel { width: 100% !important; flex: none; max-width: none; margin: 0; position: static; }
body.session-on .composer-dock {
	position: sticky; bottom: 0; left: auto; right: auto;
	padding: 28px 16px 12px; background: var(--bg);
}
body.session-on .composer-dock > * { max-width: none; margin-left: 0; margin-right: 0; }
body.session-on .composer { max-width: none; padding: 8px 10px; }
body.session-on .composer textarea { min-height: 36px; }
body.session-on .composer-bar { margin-top: 6px; }
/* Under 1100px the shared page stacks the multi-agent panel below the timeline
   (flex-direction: column with align-items: flex-start), which shrinks the
   timeline column to its content width. Stretch it back to the full column. */
@media (max-width: 1100px) {
	body.session-on .sess-body > div:first-child { width: 100%; }
}
.sess.active { background: var(--vscode-list-activeSelectionBackground); }
.sess.active .sess-task { color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground)); }
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
				<select id="providerSelect" title="Provider — decides which endpoint and billing the run uses"></select>
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
let st = { signedIn: false, backendError: "", sessions: [], modelId: "", modelProfile: "", models: [], groups: [], workspace: "" };
let pendingMount = null;
let activeId = "";

function tryMount() {
	if (!pendingMount || !window.KronyxSession) return;
	const cfg = pendingMount;
	pendingMount = null;
	try {
		const args = { token: cfg.token, apiBase: cfg.apiBase, webBase: cfg.webBase, modelId: cfg.modelId, modelProfile: cfg.modelProfile, groups: cfg.groups };
		if (cfg.type === "showNew") window.KronyxSession.showNew(args);
		else window.KronyxSession.mount({ ...args, sessionId: cfg.sessionId });
		activeId = cfg.sessionId || "";
		renderRail();
		$("sessionsBtn").classList.add("on");
		document.body.classList.add("session-on");
	} catch (err) {
		$("errorLine").textContent = "Failed to load session: " + (err && err.message ? err.message : err);
	}
}
// sessionPage.js can load after a mount message arrives — poll until ready.
window.addEventListener("load", tryMount);
setInterval(tryMount, 500);
window.addEventListener("error", (e) => {
	$("errorLine").textContent = "Session bundle error: " + (e.message || "script failed to evaluate");
});

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
		el.className = "sess" + (r.id === activeId ? " active" : "");
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
	const prov = $("providerSelect"), sel = $("modelSelect");
	const option = (value, text) => { const o = document.createElement("option"); o.value = value; o.textContent = text; return o; };
	const groups = st.groups.length ? st.groups : [{ profile: "", active: true, models: st.models }];
	const profile = groups.some((g) => g.profile === st.modelProfile) ? st.modelProfile : (groups.find((g) => g.active) || groups[0]).profile;
	const models = (groups.find((g) => g.profile === profile) || groups[0]).models;
	const cur = sel.value || st.modelId;
	prov.innerHTML = "";
	for (const g of groups) prov.appendChild(option(g.profile, g.profile + (g.active ? " · active" : "")));
	prov.value = profile;
	sel.innerHTML = "";
	for (const m of models) sel.appendChild(option(m.id, (m.label || m.id) + (m.hint || "")));
	if (models.some((m) => m.id === cur)) sel.value = cur;
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
$("sessionsBtn").onclick = () => vscode.postMessage({ type: "newPage" });
$("newBtn").onclick = () => vscode.postMessage({ type: "newPage" });

function submit() {
	const task = $("taskInput").value.trim();
	if (!task) return;
	vscode.postMessage({ type: "start", task, modelId: $("modelSelect").value, profile: $("providerSelect").value });
	$("taskInput").value = "";
}
$("sendBtn").onclick = submit;
$("taskInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); });
$("providerSelect").onchange = () => {
	const g = st.groups.find((x) => x.profile === $("providerSelect").value);
	if (g && g.models.length) vscode.postMessage({ type: "setModel", modelId: g.models[0].id, profile: g.profile });
};
$("modelSelect").onchange = () => vscode.postMessage({ type: "setModel", modelId: $("modelSelect").value, profile: $("providerSelect").value });

window.addEventListener("message", (e) => {
	const msg = e.data;
	if (msg.type === "state") { st = msg; render(); }
	else if (msg.type === "mountSession" || msg.type === "showNew") {
		pendingMount = msg;
		tryMount();
		if (pendingMount === msg) {
			setTimeout(() => {
				if (pendingMount === msg) $("errorLine").textContent = "Session view failed to load — the bundle may not be built.";
			}, 4000);
		}
	}
	else if (msg.type === "error") { $("errorLine").textContent = msg.text || ""; }
});

vscode.postMessage({ type: "refresh" });
vscode.postMessage({ type: "newPage" });
</script>
<script src="${sessionJs}"></script>
</body>
</html>`;
}
