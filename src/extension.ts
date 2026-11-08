import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentMode, RunDigest } from "./agent/runner";
import type { PriorTranscript } from "./agent/recall";
import { activeProfile, clearApiKey, configuredModels, fetchModelCatalog, profiles, promptForApiKey, readProviderSettings } from "./config";
import { RunViewProvider } from "./ui/runViewProvider";
import { renderPage } from "./ui/pageHtml";
import { SessionController } from "./ui/sessionController";
import { initLog, log } from "./log";
import { refreshUserConfig, saveUserConfig, seedUserConfig, setUserConfigSavedListener, userConfigDir } from "./userConfig";
import { SettingsSync, deviceName, getDeviceId } from "./settingsSync";
import { loadSuite, runSuite, writeReport } from "./evals";
import { appendEvent, clearEvents, insertApiCall, insertRun, insertTranscript, insertUsage, kvGet, kvSet, listEvents, listRuns, listTranscripts, latestSession, openStore, refreshStore, migrateLegacyStore, setStorageDir, setWasmDir, storeError } from "./store";
import { RunLock, type SessionDeps } from "./ui/sessionController";
import { RunComments } from "./ui/comments";
import { DiffReview, ORIGINAL_SCHEME } from "./ui/diffReview";
import { focusSessionPanel, openCloudSessionPanel, openSessionPanel, registerSessionSerializer } from "./ui/sessionPanel";
import { AgentsView } from "./ui/agentsView";
import { checkCloudSetup } from "./ui/cloudController";
import { openSettingsPage, openSettingsWindow, setProviderSavedListener } from "./ui/settingsPage";
import { openUsagePage } from "./ui/usagePage";
import { currentUser, handleAuthUri, onAuthChanged, signIn, signOut, webAppUrl } from "./auth";
import { UsageSync } from "./sync";

const MODE_STATE_KEY = "kronyx.mode";
const MODELS_CACHE_KEY = "kronyx.modelsCache";
const HISTORY_KEY = "kronyx.history";
const KNOWN_MODEL_KEY = "kronyx.knownModel";
let pendingGate: string | undefined; // prior model to restore if a gated eval run fails
let syncWorker: UsageSync | undefined; // usage sync worker (set in activate)
let sidebarController: SessionController | undefined; // the canonical right-sidebar session
let rightController: SessionController | undefined; // the session in the dedicated right window
let gateSuppressed = false; // set briefly while reverting modelId

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel("Kronyx");
	initLog(output, [
		vscode.Uri.joinPath(context.extensionUri, ".kronyx", "extension.log").fsPath,
		path.join(userConfigDir(), "extension.log"),
	]);
	log("init", `Kronyx activated (log: ${path.join(userConfigDir(), "extension.log")})`);
	if (context.extensionMode === vscode.ExtensionMode.Development) {
		// npm run dev / F5: surface the Kronyx output channel and log everything.
		output.show(true);
		log("init", "development mode — verbose logging on");
	}
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	status.command = "kronyx.focus";
	const accountStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
	accountStatus.command = "kronyx.account";
	// Reveal the dedicated right-sidebar Kronyx window on activation.
	setTimeout(() => void vscode.commands.executeCommand(`${RunViewProvider.rightViewId}.focus`), 800);
	setStatus(status, "idle");
	status.show();

	const defaultMode = vscode.workspace
		.getConfiguration("kronyx")
		.get<AgentMode>("agent.defaultMode", "code");

	const storeRoot = Promise.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.globalStorageUri.fsPath);
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
		// Import rows from legacy per-workspace stores into the shared profile db.
		for (const f of [path.join(root ?? "", ".kronyx", "kronyx.db"), path.join(os.homedir(), ".kronyx", "kronyx.db")]) {
			try { migrateLegacyStore(f); } catch { /* best-effort */ }
		}
	});

	// Usage sync: local-first ledger + burst upload when signed in.
	syncWorker = new UsageSync(context, async () => {
		const root = await storeRoot;
		return openStore(root ?? context.globalStorageUri.fsPath);
	});
	context.subscriptions.push(syncWorker);

	// Cross-device settings sync: push on config writes, pull on sign-in.
	const settingsSync = new SettingsSync(context);
	context.subscriptions.push(settingsSync);
	setUserConfigSavedListener(() => settingsSync.schedulePush());
	void refreshUserConfig().then(() => settingsSync.pull());

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
	// Reflect sign-in state in the context key, status bar, and all webview surfaces.
	const applyAuthState = async (user: Awaited<ReturnType<typeof currentUser>>): Promise<void> => {
		const signedIn = !!user;
		await vscode.commands.executeCommand("setContext", "kronyx.signedIn", signedIn);
		accountStatus.text = signedIn ? `$(account) ${user!.email ?? user!.name ?? "account"}` : "$(account) Sign in";
		accountStatus.show();
		deps.viewState = { ...deps.viewState, signedIn, userEmail: user?.email };
		for (const surface of deps.surfaces) surface.setState(deps.viewState);
	};
	onAuthChanged((user) => {
		void applyAuthState(user);
		if (user) void settingsSync.pull().then(() => settingsSync.push());
	});
	void currentUser(context).then(applyAuthState);
	// Soft-required onboarding: one-time prompt on first activation when signed out.
	void (async () => {
		if (context.globalState.get("kronyx.onboarded")) return;
		const user = await currentUser(context);
		if (user) return;
		const pick = await vscode.window.showInformationMessage(
			"Connect your Kronyx account to sync usage and settings across devices.",
			"Sign in",
			"Skip",
		);
		await context.globalState.update("kronyx.onboarded", true);
		if (pick === "Sign in") void vscode.commands.executeCommand("kronyx.signIn");
	})();
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
		isSidebar: (controller) => controller === sidebarController || controller === rightController,
		recordUsage: (entry) => {
			void storeRoot.then((root) => {
				if (root) void openStore(root).then((d) => insertUsage(d, entry, root));
			});
		},
		recordApiCall: (call) => {
			void (async () => {
				const root = await storeRoot;
				if (!root) return;
				const d = await openStore(root);
				insertApiCall(d, { ...call, device: deviceName(), deviceId: await getDeviceId(context) }, root);
				syncWorker?.kick();
			})();
			return -1; // row insert is async; callers don't depend on the id
		},
		saveDigest: (session, digests) => {
			void storeRoot.then((root) => {
				if (root) void openStore(root).then((d) => kvSet(d, `digest:${session}`, digests));
			});
		},
		loadDigest: async (session) => {
			const root = await storeRoot;
			return root ? (kvGet<RunDigest[]>(await openStore(root), `digest:${session}`) ?? []) : [];
		},
		saveTranscript: (session, messages) => {
			void storeRoot.then((root) => {
				if (root) void openStore(root).then((d) => insertTranscript(d, session, messages, root));
			});
		},
		loadTranscripts: async (session) => {
			const root = await storeRoot;
			return root ? (listTranscripts(await openStore(root), session, root) as unknown as PriorTranscript[]) : [];
		},
		persistEvent: (session, event, runId) => {
			void storeRoot.then((root) => {
				if (root) void openStore(root).then((d) => appendEvent(d, session, event, root, runId));
			});
		},
		loadEvents: async (session) => {
			const root = await storeRoot;
			if (!root) return [];
			await refreshStore().catch(() => {});
			const d = await openStore(root);
			// Root-scoped first; fall back to session-only if nothing matched
			// (rows written under a different root column or empty root).
			const scoped = listEvents(d, session, root) as Parameters<RunViewProvider["post"]>[0][];
			const all = listEvents(d, session) as Parameters<RunViewProvider["post"]>[0][];
			output.appendLine(`[store] loadEvents "${session}" — scoped(root=${root})=${scoped.length}, session-only=${all.length}`);
			return scoped.length ? scoped : all;
		},
		clearEvents: (session) => {
			void storeRoot.then((root) => {
				if (root) void openStore(root).then((d) => clearEvents(d, session, root));
			});
		},
		setStatus: (state) => setStatus(status, state),
		syncSettings: () => settingsSync.pull(),
		refreshModels: () => refreshModels(),
	};

	let refreshInFlight: Promise<void> | undefined;
	const refreshModels = (force = false): Promise<void> => {
		// Dedupe concurrent callers — activation + requestState can race to the network.
		if (!force && refreshInFlight) return refreshInFlight;
		refreshInFlight = doRefreshModels(force).finally(() => {
			refreshInFlight = undefined;
		});
		return refreshInFlight;
	};

	const doRefreshModels = async (force: boolean): Promise<void> => {
		const settings = await readProviderSettings(context.secrets);
		if (!settings) {
			log("models", "skipped — no runnable provider settings (saved profiles exist but none is active)");
			return;
		}
		// Use the persisted catalog (profile.models or per-baseUrl globalState cache) — no network unless forced.
		const norm = (u: string) => u.replace(/\/+$/, "");
		const profileCached = activeProfile()?.models;
		const cacheMap = context.globalState.get<Record<string, { models: { id: string }[] }>>(MODELS_CACHE_KEY) ?? {};
		const stateCached = cacheMap[norm(settings.baseUrl)];
		const cached =
			profileCached && profileCached.length > 0
				? profileCached
				: stateCached && stateCached.models.length > 0
					? stateCached.models
					: undefined;
		if (!force && cached) {
			log("models", `using cached catalog (${cached.length} models)`);
			deps.viewState = {
				modelId: settings.modelId,
				models: cached.some((m) => m.id === settings.modelId) ? cached : [{ id: settings.modelId }, ...cached],
			};
			for (const surface of deps.surfaces) surface.setState(deps.viewState);
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
			cacheMap[norm(settings.baseUrl)] = { models: remote };
			await context.globalState.update(MODELS_CACHE_KEY, cacheMap);
			// Also persist onto the active profile so the Models page renders from cache.
			const profile = activeProfile();
			if (profile) {
				profile.models = remote;
				profile.modelsFetchedAt = Date.now();
				const list = profiles();
				const i = list.findIndex((p) => p.name === profile.name);
				if (i >= 0) {
					list[i] = profile;
					await saveUserConfig({ profiles: list });
				}
			}
		}
		const models = remote.length > 0 ? remote : cached && cached.length > 0 ? cached : configuredModels();
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
		// Devin-style Agents sidebar: live sessions + recent runs with cloud links.
		vscode.window.registerWebviewViewProvider(AgentsView.viewId, new AgentsView(deps)),
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
						log("view", `${viewId} resolved — session "${name}"`);
						if (viewId === "kronyx.sessionView") sidebarController = controller;
						else rightController = controller;
						view.webview.onDidReceiveMessage((m) => {
							log("ui", `${viewId} message: ${(m as { type?: string }).type ?? typeof m}`);
							void controller.handle(m);
						});
						surface.attach(view.webview);
						surface.setState({ mode: deps.modeRef.current, modelId: deps.viewState.modelId, models: deps.viewState.models });
						output.appendLine(`[store] ${viewId} resolved session "${name}"`);
						view.onDidDispose(() => {
							deps.surfaces.delete(surface);
							if (sidebarController === controller) sidebarController = undefined;
							if (rightController === controller) rightController = undefined;
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
		vscode.commands.registerCommand("kronyx.newSession", () => {
			log("cmd", "kronyx.newSession — opening session tab");
			return openSessionPanel(context, deps);
		}),
		vscode.commands.registerCommand("kronyx.openSession", (name: string) => {
			log("cmd", `openSession "${name}"`);
			openSessionPanel(context, deps, name);
		}),
		vscode.commands.registerCommand("kronyx.checkCloudSetup", () => checkCloudSetup(context)),
		vscode.commands.registerCommand("kronyx.newCloudSession", (task?: string) =>
			// Devin-style: a dedicated agent window — flag consumed by the new
			// window's extension host on activation (see below).
			void context.globalState
				.update("kronyx.cloudLaunch", { task: task ?? null, at: Date.now() })
				.then(() => vscode.commands.executeCommand("workbench.action.newWindow")),
		),
		vscode.commands.registerCommand("kronyx.openSettings", () =>
			vscode.commands.executeCommand("workbench.action.openSettings", "@ext:kronyx.kronyx"),
		),
		vscode.commands.registerCommand("kronyx.openSettingsPage", () => {
			setProviderSavedListener(() => void refreshModels());
			openSettingsPage(context);
		}),
		vscode.commands.registerCommand("kronyx.openSettingsWindow", () => void openSettingsWindow(context)),
		vscode.commands.registerCommand("kronyx.showUsage", () => openUsagePage(context)),
		vscode.commands.registerCommand("kronyx.account", async () => {
			const user = await currentUser(context);
			if (!user) return void vscode.commands.executeCommand("kronyx.signIn");
			const pick = await vscode.window.showQuickPick(
				[
					{ label: `$(account) ${user.email ?? user.name ?? user.uid}`, kind: vscode.QuickPickItemKind.Separator },
					{ label: "$(dashboard) Open dashboard", id: "dashboard" },
					{ label: "$(cloud-upload) Sync usage now", id: "sync" },
					{ label: "$(sign-out) Sign out", id: "signout" },
				],
				{ title: `Kronyx account` },
			);
			const item = pick as ({ id?: string } & vscode.QuickPickItem) | undefined;
			if (item?.id === "dashboard" && webAppUrl()) void vscode.env.openExternal(vscode.Uri.parse(webAppUrl()));
			if (item?.id === "sync") void vscode.commands.executeCommand("kronyx.syncNow");
			if (item?.id === "signout") void vscode.commands.executeCommand("kronyx.signOut");
		}),
		vscode.commands.registerCommand("kronyx.signIn", async () => {
			const user = await signIn(context);
			if (user) {
				void vscode.window.showInformationMessage(`Kronyx: signed in as ${user.email ?? user.uid}`);
				syncWorker?.resume();
			}
		}),
		vscode.window.registerUriHandler({
			handleUri: (uri) => {
				void handleAuthUri(context, uri).then((user) => user && syncWorker?.resume());
			},
		}),
		vscode.commands.registerCommand("kronyx.signOut", async () => {
			await signOut(context);
			void vscode.window.showInformationMessage("Kronyx: signed out.");
		}),
		vscode.commands.registerCommand("kronyx.syncNow", async () => {
			const user = await currentUser(context);
			if (!user) {
				const pick = await vscode.window.showInformationMessage("Kronyx: sign in first to sync usage.", "Sign in");
				if (pick === "Sign in") void vscode.commands.executeCommand("kronyx.signIn");
				return;
			}
			await syncWorker?.flush();
			void vscode.window.showInformationMessage("Kronyx: usage sync attempted (see Kronyx output for details).");
		}),
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
							? ` · in ${(run as { tokens_in: number }).tokens_in.toLocaleString()} tok` +
								((run as { cache_read?: number }).cache_read
									? ` (${((run as { cache_read?: number }).cache_read ?? 0).toLocaleString()} cached)`
									: "")
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
				log("cmd", "kronyx.runTask — running task via session");
				await vscode.commands.executeCommand(`${RunViewProvider.rightViewId}.focus`);
				const session = sidebarController ?? rightController ?? focusSessionPanel(context, deps);
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

	// Dedicated cloud window: if this activation was launched by
	// kronyx.newCloudSession (flag is fresh), boot straight into the cloud page.
	void (async () => {
		const launch = context.globalState.get<{ task?: string | null; at?: number }>("kronyx.cloudLaunch");
		if (launch?.at && Date.now() - launch.at < 30_000) {
			await context.globalState.update("kronyx.cloudLaunch", undefined);
			setTimeout(() => openCloudSessionPanel(context, deps, launch.task ?? undefined), 600);
		}
	})();

	setProviderSavedListener(() => void refreshModels());
	void refreshModels();
}

export function deactivate(): void {}

function setStatus(item: vscode.StatusBarItem, state: "idle" | "running" | "failed"): void {
	const icon = state === "running" ? "$(sync~spin)" : state === "failed" ? "$(error)" : "$(hubot)";
	item.text = `${icon} Kronyx`;
	item.tooltip = `Kronyx: ${state}`;
}
