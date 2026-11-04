import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentMode } from "./agent/runner";
import { clearApiKey, configuredModels, fetchModelCatalog, promptForApiKey, readProviderSettings } from "./config";
import { RunViewProvider } from "./ui/runViewProvider";
import { renderPage } from "./ui/pageHtml";
import { SessionController } from "./ui/sessionController";
import { initLog, log } from "./log";
import { refreshUserConfig, seedUserConfig, userConfigDir } from "./userConfig";
import { loadSuite, runSuite, writeReport } from "./evals";
import { appendEvent, clearEvents, insertRun, insertUsage, kvSet, listEvents, listRuns, latestSession, openStore, setStorageDir, setWasmDir, storeError } from "./store";
import { RunLock, type SessionDeps } from "./ui/sessionController";
import { RunComments } from "./ui/comments";
import { DiffReview, ORIGINAL_SCHEME } from "./ui/diffReview";
import { focusSessionPanel, openCloudSessionPanel, openSessionPanel, registerSessionSerializer } from "./ui/sessionPanel";
import { openSettingsPage, openSettingsWindow, setProviderSavedListener } from "./ui/settingsPage";

const MODE_STATE_KEY = "kronyx.mode";
const MODELS_CACHE_KEY = "kronyx.modelsCache";
const HISTORY_KEY = "kronyx.history";
const KNOWN_MODEL_KEY = "kronyx.knownModel";
let pendingGate: string | undefined; // prior model to restore if a gated eval run fails
let sidebarController: SessionController | undefined; // the canonical right-sidebar session
let gateSuppressed = false; // set briefly while reverting modelId

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel("Kronyx");
	initLog(output, [
		vscode.Uri.joinPath(context.extensionUri, ".kronyx", "extension.log").fsPath,
		path.join(userConfigDir(), "extension.log"),
	]);
	log("init", `Kronyx activated (log: ${path.join(userConfigDir(), "extension.log")})`);
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	status.command = "kronyx.focus";
	// Reveal the dedicated right-sidebar Kronyx window on activation.
	setTimeout(() => void vscode.commands.executeCommand(`${RunViewProvider.rightViewId}.focus`), 800);
	setStatus(status, "idle");
	status.show();

	const defaultMode = vscode.workspace
		.getConfiguration("kronyx")
		.get<AgentMode>("agent.defaultMode", "code");

	const storeRoot = Promise.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
	void refreshUserConfig().then(() => {
		const config = vscode.workspace.getConfiguration("kronyx");
		void seedUserConfig({
			providerId: config.get("provider.id"),
			baseUrl: config.get("provider.baseUrl"),
			modelId: config.get("provider.modelId"),
			profiles: config.get("provider.profiles"),
			activeProfile: config.get("provider.profile"),
		});
	});
	if (context.globalStorageUri) setStorageDir(context.globalStorageUri.fsPath);
	setWasmDir(vscode.Uri.joinPath(context.extensionUri, "dist").fsPath);
	void storeRoot.then(async (root) => {
		const d = await openStore(root ?? context.globalStorageUri.fsPath);
		output.appendLine(d ? `[store] opened ${context.globalStorageUri.fsPath}/kronyx.db` : `[store] FAILED: ${storeError()}`);
	});

	// Background index on activation when embeddings are configured (incremental, no-op when current).
	void (async () => {
		const root = await storeRoot;
		const settings = root ? await readProviderSettings(context.secrets) : undefined;
		if (!root || !settings?.apiKey) return;
		const { embeddingModel, indexWorkspace } = await import("./agent/memory");
		if (embeddingModel()) void indexWorkspace(root, settings.baseUrl, settings.apiKey, (l) => output.appendLine(l));
	})();
	const diffReview = new DiffReview();
	const comments = new RunComments();
	const deps: SessionDeps = {
		context,
		output,
		runLock: new RunLock(),
		diffReview,
		comments,
		modeRef: { current: context.globalState.get<AgentMode>(MODE_STATE_KEY, defaultMode) },
		viewState: { modelId: "", models: [] },
		surfaces: new Set<RunViewProvider>(),
		recordRun: (entry) => {
			const history = context.workspaceState.get<typeof entry[]>(HISTORY_KEY, []);
			history.unshift(entry);
			void context.workspaceState.update(HISTORY_KEY, history.slice(0, 50));
			void storeRoot.then((root) => {
				if (root) void openStore(root).then((d) => insertRun(d, entry, root));
			});
		},
		isSidebar: (controller) => controller === sidebarController,
		recordUsage: (entry) => {
			void storeRoot.then((root) => {
				if (root) void openStore(root).then((d) => insertUsage(d, entry, root));
			});
		},
		persistEvent: (session, event) => {
			void storeRoot.then((root) => {
				if (root) void openStore(root).then((d) => appendEvent(d, session, event, root));
			});
		},
		loadEvents: async (session) => {
			const root = await storeRoot;
			return root ? (listEvents(await openStore(root), session, root) as Parameters<RunViewProvider["post"]>[0][]) : [];
		},
		clearEvents: (session) => {
			void storeRoot.then((root) => {
				if (root) void openStore(root).then((d) => clearEvents(d, session, root));
			});
		},
		setStatus: (state) => setStatus(status, state),
		refreshModels: () => refreshModels(),
	};

	const refreshModels = async (): Promise<void> => {
		const settings = await readProviderSettings(context.secrets);
		if (!settings) {
			log("models", "skipped — no runnable provider settings (saved profiles exist but none is active)");
			return;
		}
		log("models", `fetching ${settings.baseUrl}/models (key ${settings.apiKey ? "set" : "not set"})`);
		const { models: remote, error } = await fetchModelCatalog(settings);
		log(
			"models",
			remote.length > 0
				? `fetched ${remote.length} from ${settings.baseUrl}/models`
				: `fetch failed for ${settings.baseUrl}: ${error ?? "no models returned"}`,
		);
		if (remote.length > 0) {
			await context.globalState.update(MODELS_CACHE_KEY, { baseUrl: settings.baseUrl, models: remote });
		}
		const cached = context.globalState.get<{ baseUrl: string; models: { id: string }[] }>(MODELS_CACHE_KEY);
		const models =
			remote.length > 0
				? remote
				: cached?.baseUrl === settings.baseUrl && cached.models.length > 0
					? cached.models
					: configuredModels();
		const merged = models.some((m) => m.id === settings.modelId)
			? models
			: [{ id: settings.modelId }, ...models];
		deps.viewState = { modelId: settings.modelId, models: merged };
		for (const surface of deps.surfaces) surface.setState(deps.viewState);
	};

	context.subscriptions.push(
		output,
		status,
		diffReview,
		comments,
		vscode.commands.registerCommand("kronyx.dismissComments", () => comments.clear()),
		vscode.commands.registerCommand("kronyx.indexWorkspace", async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) return void vscode.window.showErrorMessage("Kronyx: open a folder first.");
			const settings = await readProviderSettings(context.secrets);
			if (!settings) return void vscode.window.showErrorMessage("Kronyx: provider settings unavailable.");
			const { embeddingModel, indexWorkspace } = await import("./agent/memory");
			if (!embeddingModel()) {
				return void vscode.window.showInformationMessage(
					"Kronyx: set kronyx.memory.embeddingModel first (e.g. text-embedding-3-small).",
				);
			}
			output.show();
			const n = await indexWorkspace(folder.uri.fsPath, settings.baseUrl, settings.apiKey, (l) => output.appendLine(l));
			void vscode.window.showInformationMessage(n > 0 ? `Kronyx: indexed ${n} file(s).` : "Kronyx: index already up to date.");
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (gateSuppressed) {
				/* revert-induced change */
			} else if (e.affectsConfiguration("kronyx.provider.modelId") || e.affectsConfiguration("kronyx.provider.profile")) {
				const gate = vscode.workspace.getConfiguration("kronyx").get<string>("eval.gateOnModelChange", "prompt");
				if (gate !== "off") {
					void (async () => {
						const root = await storeRoot;
						const cases = root ? await loadSuite(root).catch(() => []) : [];
						if (cases.length === 0) return;
						const model = vscode.workspace.getConfiguration("kronyx").get<string>("provider.modelId", "");
						const prior = context.globalState.get<string>(KNOWN_MODEL_KEY, "");
						if (gate === "always") {
							pendingGate = prior;
							void vscode.commands.executeCommand("kronyx.runEvals");
						} else {
							const pick = await vscode.window.showInformationMessage(
								`Kronyx model changed to ${model}. Run the eval suite to gate this change?`,
								"Run evals",
								"Skip",
								"Always gate",
							);
							if (pick === "Run evals") {
								pendingGate = prior;
								void vscode.commands.executeCommand("kronyx.runEvals");
							}
							else if (pick === "Always gate")
								await vscode.workspace
									.getConfiguration("kronyx")
									.update("eval.gateOnModelChange", "always", vscode.ConfigurationTarget.Global);
						}
					})();
				}
			}
			if (!e.affectsConfiguration("kronyx")) return;
			const snapshot: Record<string, unknown> = {};
			const config = vscode.workspace.getConfiguration("kronyx");
			for (const key of [
				"provider.id",
				"provider.baseUrl",
				"provider.modelId",
				"provider.profile",
				"agent.defaultMode",
				"agent.maxIterations",
				"sandbox.backend",
				"cloud.autoPr",
				"git.autoBranch",
				"checks.runOnFinish",
			])
				snapshot[key] = config.get(key);
			void storeRoot.then((root) => {
				if (root) void openStore(root).then((d) => kvSet(d, "kronyx.settings", snapshot));
			});
		}),
		vscode.commands.registerCommand("kronyx.runEvals", async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showErrorMessage("Kronyx: open a folder first.");
				return;
			}
			const root = folder.uri.fsPath;
			const settings = await readProviderSettings(context.secrets);
			if (!settings?.apiKey) {
				void vscode.window.showErrorMessage("Kronyx: set an API key first ('Kronyx: Set API key').");
				return;
			}
			try {
				const cases = await loadSuite(root);
				if (cases.length === 0) {
					void vscode.window.showInformationMessage("Kronyx: eval suite is empty.");
					return;
				}
				output.show();
				output.appendLine(`Running ${cases.length} eval case(s) with ${settings.modelId}...`);
				const results = await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: "Kronyx: running evals", cancellable: false },
					() => runSuite(root, settings, (line) => output.appendLine(line)),
				);
				const report = await writeReport(root, results);
				const passed = results.filter((r) => r.passed).length;
				output.appendLine(`Evals: ${passed}/${results.length} passed → ${report}`);
				const currentModel = vscode.workspace.getConfiguration("kronyx").get<string>("provider.modelId", "");
				if (passed === results.length) {
					await context.globalState.update(KNOWN_MODEL_KEY, currentModel);
				}
				const revertTo = pendingGate;
				pendingGate = undefined;
				if (revertTo && passed < results.length) {
					gateSuppressed = true;
					setTimeout(() => (gateSuppressed = false), 15_000);
					await vscode.workspace
						.getConfiguration("kronyx")
						.update("provider.modelId", revertTo, vscode.ConfigurationTarget.Global);
					void vscode.window.showErrorMessage(
						`Kronyx eval gate: ${passed}/${results.length} passed — model reverted to ${revertTo}.`,
					);
					return;
				}
				void vscode.window.showInformationMessage(`Kronyx evals: ${passed}/${results.length} passed (report: ${report})`);
			} catch (error) {
				void vscode.window.showErrorMessage(`Kronyx evals failed: ${error instanceof Error ? error.message : error}`);
			}
		}),
		registerSessionSerializer(context, deps),
		// Session webview provider — registered for both the left activity-bar view and the dedicated right-sidebar container.
		...["kronyx.sessionView", RunViewProvider.rightViewId].map((viewId) =>
			vscode.window.registerWebviewViewProvider(viewId, {
				resolveWebviewView(view) {
					const mediaUri = vscode.Uri.joinPath(context.extensionUri, "media");
					view.webview.options = { enableScripts: true, localResourceRoots: [mediaUri] };
					view.webview.html = renderPage(view.webview, context.extensionUri);
					const surface = new RunViewProvider(context.extensionUri);
					void (async () => {
						const root = await storeRoot;
						const d = root ? await openStore(root) : undefined;
						const name =
							(viewId === "kronyx.sessionView" ? root && latestSession(d, root) : undefined) ??
							(viewId === "kronyx.sessionView" ? "Side Session" : "Right Session");
						const controller = new SessionController(name, surface, deps);
						if (viewId === "kronyx.sessionView") sidebarController = controller;
						view.webview.onDidReceiveMessage((m) => void controller.handle(m));
						surface.attach(view.webview);
						surface.setState({ mode: deps.modeRef.current, modelId: deps.viewState.modelId, models: deps.viewState.models });
						const events = await deps.loadEvents(name);
						events.forEach((e) => surface.post(e));
						output.appendLine(`[store] ${viewId} restored "${name}" with ${events.length} event(s)`);
						view.onDidDispose(() => {
							deps.surfaces.delete(surface);
							if (sidebarController === controller) sidebarController = undefined;
							void controller.handle({ type: "stop" });
						});
					})();
					deps.surfaces.add(surface);
				},
			}),
		),
		vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, diffReview),
		vscode.languages.registerCodeLensProvider({ scheme: "file" }, diffReview),
		vscode.commands.registerCommand("kronyx.acceptHunk", (args) => diffReview.acceptHunk(args)),
		vscode.commands.registerCommand("kronyx.rejectHunk", (args) => diffReview.rejectHunk(args)),
		vscode.commands.registerCommand("kronyx.reviewChanges", async () => {
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
			const items = diffReview.changedFiles().map((abs) => ({
				label: abs.startsWith(root) ? abs.slice(root.length + 1) : abs,
				abs,
			}));
			if (items.length === 0) {
				void vscode.window.showInformationMessage("Kronyx: no unreviewed changes.");
				return;
			}
			const picked = await vscode.window.showQuickPick(items, { title: "Review changes" });
			if (picked) await diffReview.openReview(picked.abs, picked.label);
		}),
		vscode.commands.registerCommand("kronyx.focus", () =>
			vscode.commands.executeCommand(`${RunViewProvider.rightViewId}.focus`),
		),
		vscode.commands.registerCommand("kronyx.focusRight", () =>
			vscode.commands.executeCommand(`${RunViewProvider.rightViewId}.focus`),
		),
		vscode.commands.registerCommand("kronyx.newSession", () => openSessionPanel(context, deps)),
		vscode.commands.registerCommand("kronyx.newCloudSession", () => openCloudSessionPanel(context, deps)),
		vscode.commands.registerCommand("kronyx.openSettings", () =>
			vscode.commands.executeCommand("workbench.action.openSettings", "@ext:kronyx.kronyx"),
		),
		vscode.commands.registerCommand("kronyx.openSettingsPage", () => {
			setProviderSavedListener(() => void refreshModels());
			openSettingsPage(context);
		}),
		vscode.commands.registerCommand("kronyx.openSettingsWindow", () => void openSettingsWindow(context)),
		vscode.commands.registerCommand("kronyx.showHistory", async () => {
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			const db = root ? await openStore(root) : undefined;
			const sqliteRows = listRuns(db, 50, root).map((r) => ({ ...r, durationMs: r.duration_ms }));
			const history = sqliteRows.length
				? sqliteRows
				: context.workspaceState.get<{ task: string; session: string; status: string; durationMs: number; at: number }[]>(
						HISTORY_KEY,
						[],
					);
			if (history.length === 0) {
				void vscode.window.showInformationMessage("Kronyx: no runs yet.");
				return;
			}
			const picked = await vscode.window.showQuickPick(
				history.map((run) => ({
					label: `${run.status === "completed" ? "$(check)" : "$(error)"} ${run.task.slice(0, 80)}`,
					description: `${run.session} · ${(run.durationMs / 1000).toFixed(1)}s · ${new Date(run.at).toLocaleTimeString()}${
						"tokens_in" in run && (run as { tokens_in?: number }).tokens_in
							? ` · in ${(run as { tokens_in: number }).tokens_in.toLocaleString()} tok`
							: ""
					}`,
					run,
				})),
				{ title: "Run history" },
			);
			if (picked) void vscode.window.showInformationMessage(`"${picked.run.task}" — ${picked.run.status}`);
		}),
		vscode.commands.registerCommand("kronyx.runTask", async () => {
			const task = await vscode.window.showInputBox({ title: "Kronyx: run task", prompt: "Describe the change" });
			if (task) {
				await vscode.commands.executeCommand(`${RunViewProvider.rightViewId}.focus`);
				const session = sidebarController ?? focusSessionPanel(context, deps);
				await session.handle({ type: "run", task, mode: deps.modeRef.current });
			}
		}),
		vscode.commands.registerCommand("kronyx.stop", () => (sidebarController ?? focusSessionPanel(context, deps)).handle({ type: "stop" })),
		vscode.commands.registerCommand("kronyx.newTask", () => (sidebarController ?? focusSessionPanel(context, deps)).handle({ type: "new" })),
		vscode.commands.registerCommand("kronyx.setApiKey", () => promptForApiKey(context.secrets)),
		vscode.commands.registerCommand("kronyx.clearApiKey", async () => {
			await clearApiKey(context.secrets);
			void vscode.window.showInformationMessage("Kronyx: API key cleared.");
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("kronyx.provider")) void refreshModels();
		}),
	);

	setProviderSavedListener(() => void refreshModels());
	void refreshModels();
}

export function deactivate(): void {}

function setStatus(item: vscode.StatusBarItem, state: "idle" | "running" | "failed"): void {
	const icon = state === "running" ? "$(sync~spin)" : state === "failed" ? "$(error)" : "$(hubot)";
	item.text = `${icon} Kronyx`;
	item.tooltip = `Kronyx: ${state}`;
}
