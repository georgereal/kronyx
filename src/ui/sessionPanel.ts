import * as vscode from "vscode";
import { renderPage } from "./pageHtml";
import { renderCloudPage } from "./cloudPageHtml";
import { RunViewProvider } from "./runViewProvider";
import { CloudController } from "./cloudController";
import { SessionController, type SessionDeps } from "./sessionController";

let counter = 0;
const panels = new Map<vscode.WebviewPanel, SessionController>();
const panelNames = new Map<vscode.WebviewPanel, string>();
let sessionColumn: vscode.ViewColumn | undefined;
const listeners = new Set<() => void>();

export function onDidChangeSessions(listener: () => void): vscode.Disposable {
	listeners.add(listener);
	return { dispose: () => listeners.delete(listener) };
}

export function listSessions(): string[] {
	return [...panelNames.values()];
}

export function revealSession(name: string): void {
	for (const [panel, panelName] of panelNames) {
		if (panelName === name) {
			panel.reveal();
			return;
		}
	}
}

/** Reveal an existing session tab, or open the first one on the right. */
export function focusSessionPanel(context: vscode.ExtensionContext, deps: SessionDeps): SessionController {
	const existing = panels.entries().next().value;
	if (existing) {
		existing[0].reveal();
		return existing[1];
	}
	return openSessionPanel(context, deps);
}

/** Opens a chat session as an editor tab, grouped with the other session tabs. */
export function openSessionPanel(context: vscode.ExtensionContext, deps: SessionDeps, sessionName?: string): SessionController {
	counter += 1;
	const name = sessionName ?? `Session ${counter}`;
	const panel = vscode.window.createWebviewPanel(
		"kronyx.session",
		`Kronyx · ${name}`,
		sessionColumn ?? (Math.min(vscode.window.tabGroups.all.length + 1, 9) as vscode.ViewColumn),
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	if (panels.size === 0) sessionColumn = panel.viewColumn;
	return wire(context, deps, panel, name);
}

/** Opens a cloud session tab — the agent works in E2B and finishes with a PR. */
let cloudLaunching = false;

export function openCloudSessionPanel(context: vscode.ExtensionContext, deps: SessionDeps, task?: string): void {
	// Guard against double launches (launch flag + serializer restore, double submit):
	// only one cloud panel may be created per window at a time.
	// One cloud session per window: reveal the existing panel instead of opening a second.
	for (const [panel, panelName] of panelNames) {
		if (panelName.startsWith("Cloud")) {
			panel.reveal();
			return;
		}
	}
	if (cloudLaunching) return;
	cloudLaunching = true;
	setTimeout(() => { cloudLaunching = false; }, 5000);
	counter += 1;
	const name = `Cloud ${counter}`;
	const panel = vscode.window.createWebviewPanel(
		"kronyx.session",
		`Kronyx ☁ ${name}`,
		vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "kronyx.svg");
	if (panels.size === 0) sessionColumn = panel.viewColumn;
	const media = vscode.Uri.joinPath(context.extensionUri, "media");
	panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
	const surface = new RunViewProvider(context.extensionUri);
	const controller = new CloudController(name, surface, deps);
	panels.set(panel, controller as unknown as SessionController);
	panelNames.set(panel, name);
	for (const listener of listeners) listener();
	panel.webview.html = renderCloudPage(panel.webview, context.extensionUri);
	panel.webview.onDidReceiveMessage((message) => void controller.handle(message));
	surface.attach(panel.webview);
	surface.setState({ mode: deps.modeRef.current, modelId: deps.viewState.modelId, models: deps.viewState.models });
	deps.surfaces.add(surface);
	// Devin-style overlay: hide sidebars + panel so the agent page fills the
	// window edge-to-edge (Zen Mode's centered layout leaves dead margins).
	for (const cmd of ["workbench.action.closeSidebar", "workbench.action.closeAuxiliaryBar", "workbench.action.closePanel"]) {
		void vscode.commands.executeCommand(cmd);
	}
	if (task) void controller.start(task);
	panel.onDidDispose(() => {
		panels.delete(panel);
		panelNames.delete(panel);
		for (const listener of listeners) listener();
		if (panels.size === 0) sessionColumn = undefined;
		deps.surfaces.delete(surface);
		surface.detach(panel.webview);
		void controller.dispose();
	});
}

/** Restores session webview panels across window reloads. */
export function registerSessionSerializer(context: vscode.ExtensionContext, deps: SessionDeps): vscode.Disposable {
	// The sidebar view is the canonical surface; stale editor-tab sessions are not restored.
	void context;
	void deps;
	return vscode.window.registerWebviewPanelSerializer("kronyx.session", {
		async deserializeWebviewPanel(panel) {
			panel.dispose();
		},
	});
}

function wire(
	context: vscode.ExtensionContext,
	deps: SessionDeps,
	panel: vscode.WebviewPanel,
	name: string,
): SessionController {
	panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "kronyx.svg");
	const media = vscode.Uri.joinPath(context.extensionUri, "media");
	panel.webview.options = { enableScripts: true, localResourceRoots: [media] };

	const surface = new RunViewProvider(context.extensionUri);
	const controller = new SessionController(name, surface, deps);
	panels.set(panel, controller);
	panelNames.set(panel, name);
	for (const listener of listeners) listener();
	panel.webview.html = renderPage(panel.webview, context.extensionUri);
	panel.webview.onDidReceiveMessage((message) => void controller.handle(message));
	surface.attach(panel.webview);
	surface.setState({ mode: deps.modeRef.current, modelId: deps.viewState.modelId, models: deps.viewState.models });
	deps.surfaces.add(surface);
	panel.onDidDispose(() => {
		panels.delete(panel);
		panelNames.delete(panel);
		for (const listener of listeners) listener();
		if (panels.size === 0) sessionColumn = undefined;
		deps.surfaces.delete(surface);
		surface.detach(panel.webview);
		controller.handle({ type: "stop" }).catch(() => {});
	});
	return controller;
}
