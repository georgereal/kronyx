import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentMode, ProviderSettings, RunnerAttachment, RunDigest, RunnerHost } from "../agent/types";
import type { EngineKind } from "../agent/engine";
import { chooseTransport, type TransportKind } from "../harness/adapters";
import { buildSystemPrompt } from "../agent/systemPrompt";
import { assembleToolSet } from "../agent/toolSet";
import { withExplore } from "../harness/tools/explore";
import { withBatchReads } from "../harness/tools/batchReads";
import { withReadCache } from "../harness/tools/readCache";
import { withRecall } from "../harness/tools/recall";
import { WRITE_MODES } from "../agent/types";
import { isConversationalTask } from "../agent/taskGuard";
import { acceptsImages } from "../agent/vision";
import { evaluate, parsePermissionsText, ruleFor, type PermissionLayers, type PermissionRules } from "../agent/permissions";
import { readGlobalModePermissions, readGlobalPermissions } from "../permStore";
import type { PriorTranscript } from "../agent/recall";
import type { AgentMessage } from "@cline/shared";
import { checksOnFinish, runChecks } from "../checks";
import { E2bSandbox, sandboxBackend, sandboxEnabled } from "./e2b";
import { appendFact, createIdeRecallScorer, embedTexts, embeddingModel, indexFile, loadMemoryContext, logEpisode } from "./memory";
import { buildRunIndex, indexRunDigests, searchRunDigests } from "./runMemory";
import { createFileTools } from "../tools/fileTools";
import { FileEventLog } from "../harness/core/eventLog";
import { createModelAdapter } from "../harness/adapters";
import { resolveBehaviorProfile } from "../harness/behaviors";
import { createHarnessToolPort } from "../harness/tools/toolPort";
import { CommandVerifier } from "../harness/defaults/verifier";
import { shellExec } from "../harness/tools/exec";
import { runHarness } from "../harness/core/runner";
import { buildHarnessReport } from "../harness/report/report";
import type { HarnessLoop, SeedTask } from "../harness/core/loop";
import { implementationIntent, planSeedTasks } from "../harness/planning/planSeed";
import { PLAN_VISIBLE, READ_ONLY_HIDDEN } from "../agent/toolSet";
import { createFetchTools } from "../tools/fetchTools";
import { createMcpTools, type McpServerConfig } from "../tools/mcpTools";
import { createProcessTools, type ProcTools } from "../tools/procTools";
import { createLocalBrowserTools, type LocalBrowserTools } from "../tools/localBrowserTools";
import { userConfig } from "../userConfig";
import { insertMemoryEvent, openStore, upsertHarnessReport } from "../store";
import { SqliteKnowledgeStore } from "../context/knowledge/sqliteKnowledgeStore";
import { SqliteExecutionStateStore } from "../context/state/sqliteExecutionStateStore";
import { createIdeTools } from "./ideTools";
import { autoApproveWrites, currentSelection, estimateCostUsd, implementPrompt, modelPricing, networkAllowHosts, pickModel, planDir, type ProfileCatalog, profiles, promptForApiKey, providerErrorMessage, readProviderSettings, resolveProvider } from "../config";
import { log } from "../log";
import type { ApiCallRow } from "../store";
import * as git from "../git";
import type { RunComments } from "./comments";
import type { DiffReview } from "./diffReview";
import type { AttachmentPreview, ModelOption, RunViewProvider, WebviewMessage } from "./runViewProvider";

const MENTION_TOTAL_CAP = 50 * 1024;

/** Appended to an implement task when its plan seeded the board — the model's scope is the seed, not the session's history. */
const IMPLEMENT_SCOPE_NOTE =
	" The plan's steps are already on your task board — work them in order and stay inside the plan's scope. This is an implementation run: if the plan's text hedges (\"review-first\", \"no code changes\", \"pending review\"), that described the planning phase — your job now is to carry the plan out, including writing code where its steps call for deliverables. Close each step with task_step_update status \"done\" — the harness attaches the proving tool calls itself, never supply call ids. When a check fails, fix the cause or find a working alternative, don't skip ahead. The plan document is the record of the work: when implementation deviates from it in small ways (a file location, a renamed constant), correct the document with edit_file as you go — large scope changes are not yours to make, surface them instead.";

export interface GitSettings {
	autoBranch: boolean;
	branchPrefix: string;
	commitOnFinish: boolean;
}

export function gitSettings(): GitSettings {
	const config = vscode.workspace.getConfiguration("kronyx");
	return {
		autoBranch: config.get<boolean>("git.autoBranch", false),
		branchPrefix: config.get<string>("git.branchPrefix", "kronyx/"),
		commitOnFinish: config.get<boolean>("git.commitOnFinish", false),
	};
}

/** Global phase-1 lock: only one run may be active across all surfaces. */
export class RunLock {
	private owner: string | undefined;

	tryAcquire(name: string): boolean {
		if (this.owner) return false;
		this.owner = name;
		return true;
	}

	release(name: string): void {
		if (this.owner === name) this.owner = undefined;
	}

	get current(): string | undefined {
		return this.owner;
	}
}

export interface RunRecord {
	task: string;
	session: string;
	status: string;
	durationMs: number;
	at: number;
	tokensIn?: number;
	tokensOut?: number;
	cacheRead?: number;
	cacheWrite?: number;
	runId?: string;
}

/** Per-workspace tab strip state; `engines` remembers each session's execution engine. */
interface TabState {
	last?: string;
	tabs?: string[];
	engines?: Record<string, EngineKind>;
}

export interface SessionDeps {
	context: vscode.ExtensionContext;
	output: vscode.OutputChannel;
	runLock: RunLock;
	modeRef: { current: AgentMode };
	viewState: { models: ModelOption[]; groups?: ProfileCatalog[]; signedIn?: boolean; userEmail?: string };
	/** Re-push the composer pick (read from config) and catalogs to every surface. */
	pushViewState: () => void;
	surfaces: Set<RunViewProvider>;
	diffReview: DiffReview;
	comments: RunComments;
	recordRun: (entry: RunRecord) => void;
	isSidebar?: (controller: SessionController) => boolean;
	recordUsage: (entry: { session: string; task: string; tokensIn: number; tokensOut: number; cacheRead?: number; cacheWrite?: number; at: number }) => void;
	/** Insert one per-request usage row into the api_calls ledger; returns the row id (or -1). */
	recordApiCall?: (call: ApiCallRow) => number;
	persistEvent: (session: string, event: Parameters<RunViewProvider["post"]>[0], runId?: string) => void;
	loadEvents: (session: string) => Promise<Parameters<RunViewProvider["post"]>[0][]>;
	saveDigest?: (session: string, digests: readonly RunDigest[]) => void;
	loadDigest?: (session: string) => Promise<RunDigest[]>;
	saveTranscript?: (session: string, messages: readonly AgentMessage[]) => void;
	loadTranscripts?: (session: string) => Promise<PriorTranscript[]>;
	clearEvents: (session: string) => void;
	/** Persisted local sessions (for the sidebar tab strip), most recent first. */
	listSessions?: () => Promise<{ name: string; title: string }[]>;
	/** Per-workspace tab-strip state: last active session + open tab names. */
	tabState?: { get(): TabState; set(v: TabState): void };
	setStatus: (state: "idle" | "running" | "failed") => void;
	syncSettings?: () => Promise<void>;
	refreshModels: () => Promise<void>;
}

/** Level-0 developer context: what the user is looking at right now — injected into the system prompt. */
function devContext(root: string): string {
	const lines: string[] = ["IDE state (from VS Code):"];
	const ed = vscode.window.activeTextEditor;
	if (ed?.document.uri.scheme === "file") {
		const rel = path.relative(root, ed.document.uri.fsPath).split(path.sep).join("/");
		const sel = ed.selection;
		const selText = sel.isEmpty ? "" : `, selected lines ${sel.start.line + 1}-${sel.end.line + 1}`;
		lines.push(`- Active file: ${rel}${selText}${ed.document.isDirty ? " (unsaved changes)" : ""}`);
	}
	const tabs = [
		...new Set(
			vscode.window.tabGroups.all
				.flatMap((g) => g.tabs)
				.map((t) => (t.input instanceof vscode.TabInputText ? t.input.uri : undefined))
				.filter((u): u is vscode.Uri => !!u && u.scheme === "file")
				.map((u) => path.relative(root, u.fsPath).split(path.sep).join("/"))
				.filter((r) => !r.startsWith("..")),
		),
	];
	if (tabs.length) lines.push(`- Open tabs: ${tabs.slice(0, 12).join(", ")}`);
	const dirty = vscode.workspace.textDocuments
		.filter((d) => d.isDirty && d.uri.scheme === "file")
		.map((d) => path.relative(root, d.uri.fsPath).split(path.sep).join("/"));
	if (dirty.length) lines.push(`- Unsaved files: ${dirty.slice(0, 10).join(", ")}`);
	lines.push(
		"- IDE tools available: get_diagnostics, get_file_structure, search_symbols, get_symbol_context, " +
			"get_call_hierarchy, rename_symbol — prefer them over search_files/grep for symbol lookups, " +
			"finding callers, renames, and checking errors.",
	);
	return lines.join("\n");
}

/** Workspace diagnostic counts (error/warning) — run baseline vs post-run comparison. */
function diagCounts(): { errors: number; warnings: number } {
	let errors = 0;
	let warnings = 0;
	for (const [, diags] of vscode.languages.getDiagnostics()) {
		for (const d of diags) {
			if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
			else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
		}
	}
	return { errors, warnings };
}

/** Owns one session surface (sidebar view or editor tab): runner, messages, git hooks. */
export class SessionController {
	/** OpenAI-compatible engine for this session; recreated when the session changes (it owns a per-session transcript). */
	private legacyDigests: RunDigest[] = [];
	private engineHost: RunnerHost | undefined;
	private engineKind: EngineKind = "auto";
	/** Engine of the run in flight (or last run); stamped on api_calls rows for comparison. */
	private runEngine: EngineKind = "auto";
	private runTransport: TransportKind = "auto";
	/** Resolved wire of the adapter actually in flight — the chip can ask for conversations while the provider only supports chat. */
	private runWire: string | undefined;
	/** Usage-row tag: harness runs are tagged by the resolved wire so fallback transports don't misreport. */
	private engineTag(): string {
		return this.runEngine === "harness" ? `harness:${this.runWire ?? this.runTransport}` : this.runEngine;
	}
	/** Aborts the harness run in flight (Stop). Set only while a harness run is active. */
	private harnessAbort: AbortController | undefined;
	/** True when the last harness run paused (Continue resumes it from its log). */
	private harnessPaused = false;
	/** The harness loop of the run in flight, for compact-now. */
	private activeHarnessLoop: HarnessLoop | undefined;
	private lastTransport: TransportKind = "auto";
	/** MCP connections are per-session: config change rebuilds on next runner. */
	private mcp: { key: string; tools: import("@cline/shared").AgentTool<any, string>[] } | undefined;
	/** Per-root background process registry — disposed at each run's end. */
	private procs: ProcTools | undefined;
	/** Host-side headless browser for local verification — disposed per run. */
	private browserTools: LocalBrowserTools | undefined;
	/** Values resolved from SecretStorage — scrubbed from tool output before the model sees it. */
	private knownSecrets = new Set<string>();

	private async mcpTools(): Promise<import("@cline/shared").AgentTool<any, string>[]> {
		const servers = userConfig().mcpServers as McpServerConfig[] | undefined;
		if (!servers?.length) return [];
		const key = JSON.stringify(servers);
		if (this.mcp?.key !== key) {
			const secrets = this.deps.context.secrets;
			const resolveSecret = async (n: string) => {
				const v = await secrets.get(n);
				if (v) this.knownSecrets.add(v);
				return v;
			};
			this.mcp = {
				key,
				tools: (await createMcpTools({ servers, resolveSecret, log: (m) => log("mcp", m) })).tools,
			};
		}
		return this.mcp.tools;
	}
	private runnerRoot: string | undefined;
	private approveAll = false;
	private changedPaths = new Set<string>();
	private indexTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private diagBaseline: { errors: number; warnings: number } | undefined;
	private runStartedAt = 0;
	/** Id shared by this run's api_calls/runs/session_events rows — required by
	 *  the unsynced queries that batch-upload to the dashboard. */
	private runId = "";
	private replayed = false;
	private runTask = "";
	private lastUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalCost: 0 };
	private lastUsageAt = 0;
	private runProvider: { providerId: string; baseUrl: string; modelId: string; profile?: string } | undefined;
	private transcripts: PriorTranscript[] = [];
	private permLayers: PermissionLayers = {
		global: { allow: [], ask: [], deny: [] },
		project: { allow: [], ask: [], deny: [] },
		local: { allow: [], ask: [], deny: [] },
		modes: {},
	};
	private sandbox: E2bSandbox | undefined;
	private sandboxSynced = false;
	private openTabs: string[] = [];

	private rememberTabs(): void {
		this.deps.tabState?.set({ ...this.deps.tabState.get(), last: this.name, tabs: [...this.openTabs] });
	}

	constructor(
		public name: string,
		private readonly surface: RunViewProvider,
		private readonly deps: SessionDeps,
	) {
		this.openTabs = [...new Set(deps.tabState?.get().tabs ?? [])];
		this.engineKind = deps.tabState?.get().engines?.[name] ?? "auto";
		if (!this.openTabs.includes(this.name)) this.openTabs.push(this.name);
	}

	private static sessionCounter = 0;

	/** Start a fresh named session in the same window — like Copilot's "new chat". */
	async startNewSession(): Promise<void> {
		this.resetEngines();
		this.engineKind = "auto";
		this.approveAll = false;
		this.permittedTools.clear();
		// Lowest unused N across open tabs and stored sessions — the static
		// counter resets per window, which would otherwise collide with history.
		const taken = new Set(this.openTabs);
		for (const s of (await this.deps.listSessions?.()) ?? []) taken.add(s.name);
		let n = SessionController.sessionCounter + 1;
		while (taken.has(`Kronyx Local Session ${n}`)) n++;
		SessionController.sessionCounter = n;
		this.name = `Kronyx Local Session ${n}`;
		this.openTabs.push(this.name);
		this.deps.clearEvents(this.name);
		this.surface.post({ type: "reset" });
		this.deps.setStatus("idle");
		this.rememberTabs();
		void this.pushTabs();
	}

	/** Close a session tab — history stays in the store; the tab leaves the strip until reopened. */
	async closeSession(name: string): Promise<void> {
		if (name === this.name) {
			const rest = this.openTabs.filter((n) => n !== name);
			if (rest.length) await this.openSession(rest[rest.length - 1]);
			else await this.startNewSession();
		}
		this.openTabs = this.openTabs.filter((n) => n !== name);
		this.rememberTabs();
		void this.pushTabs();
	}

	/** Load a different persisted session into this surface (Agents view → open session). */
	async openSession(name: string): Promise<void> {
		if (this.name === name) return;
		this.stopEngines();
		this.approveAll = false;
		this.permittedTools.clear();
		this.name = name;
		this.engineKind = this.deps.tabState?.get().engines?.[name] ?? "auto";
		this.surface.setState({ engine: this.engineKind });
		if (!this.openTabs.includes(name)) this.openTabs.push(name);
		this.replayed = true;
		this.surface.post({ type: "reset" });
		await this.replayStoredEvents();
		this.rememberTabs();
		void this.pushTabs();
	}

	/** Replay history without leaving a run visually active after an IDE restart. */
	private async replayStoredEvents(): Promise<number> {
		const evs = await this.deps.loadEvents(this.name);
		// Mark the replay burst — work cards mount synchronously inside it, or
		// the deferred live-mount would dump them all after the text.
		this.surface.post({ type: "replay-start" });
		let active = false;
		let task = "";
		for (const event of evs) {
			if (event.type === "run-started") {
				active = true;
				task = event.task;
			} else if (event.type === "run-finished" || event.type === "run-failed") {
				active = false;
			}
			this.surface.post(event);
		}
		if (task) this.runTask = task;
		// Do not close a run that is genuinely active in another surface of the
		// same extension host; after a VS Code restart the lock is empty.
		if (active && !this.isRunning && this.deps.runLock.current !== this.name) {
			this.runTask = task;
			const recovery = {
				type: "run-finished" as const,
				status: "stopped",
				text: "Run interrupted because VS Code was closed.",
				iterations: 0,
			};
			this.surface.post(recovery);
			this.deps.persistEvent(this.name, recovery, this.runId);
		}
		this.surface.post({ type: "replay-end" });
		this.deps.setStatus("idle");
		return evs.length;
	}

	/** Push the session tab-strip state (sidebar surfaces only). */
	private async pushTabs(): Promise<void> {
		if (!this.deps.isSidebar?.(this) || !this.deps.listSessions) return;
		const stored = await this.deps.listSessions();
		const titles = new Map(stored.map((s) => [s.name, s.title]));
		// Chips = open tabs only (persisted even before their first run). Other
		// stored sessions stay reachable through the dropdown, not as chips.
		if (!this.openTabs.includes(this.name)) this.openTabs.push(this.name);
		const tabs = [...new Set(this.openTabs)];
		// Sessions with stored events keep open order; brand-new tabs (no events
		// yet — a "temp" session) always pin to the far right.
		const ordered = [...tabs.filter((n) => titles.has(n)), ...tabs.filter((n) => !titles.has(n))];
		const sessions = ordered.slice(0, 12).map((n) => ({ name: n, title: titles.get(n) ?? n }));
		const moreSessions = stored.filter((s) => !this.openTabs.includes(s.name)).slice(0, 20);
		this.surface.setState({ sessions, moreSessions, activeSession: this.name });
	}

	get isRunning(): boolean {
		return !!this.harnessAbort;
	}

	private stopEngines(): void {
		this.harnessAbort?.abort();
	}

	private resetEngines(): void {
		this.procs?.dispose();
		void this.browserTools?.dispose();
	}

	private setEngineKind(kind: EngineKind): void {
		if (this.engineKind === kind) return;
		this.engineKind = kind;
		const tabs = this.deps.tabState;
		tabs?.set({ ...tabs.get(), engines: { ...tabs.get().engines, [this.name]: kind } });
		this.surface.setState({ engine: kind });
	}

	async handle(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case "run":
				await this.startRun(message.task, message.mode, message.pick, message.engine);
				break;
			case "resumeRun":
				await this.resumeRun();
				break;
			case "stop":
				this.stopEngines();
				for (const p of this.pendingPermissions.values()) p.resolve("deny");
				this.pendingPermissions.clear();
				break;
			case "compact":
				this.harnessCompact();
				break;
			case "clearContext":
				void this.harnessClear();
				break;
			case "permissionResponse": {
				const p = this.pendingPermissions.get(message.id);
				if (p) {
					this.pendingPermissions.delete(message.id);
					// save_plan's card shows an editable path — an edited value becomes
					// the tool input's path so the plan lands where the user put it.
					if (p.toolName === "save_plan" && typeof message.path === "string" && message.path.trim()) {
						(p.input as { path?: string }).path = message.path.trim().replace(/^\/+/, "");
					}
					p.resolve(message.decision);
				}
				break;
			}
			case "new":
				this.resetEngines();
				this.approveAll = false;
				this.permittedTools.clear();
				this.surface.post({ type: "reset" });
				this.deps.setStatus("idle");
				break;
			case "setApiKey":
				await promptForApiKey(this.deps.context.secrets);
				await this.deps.refreshModels();
				break;
			case "requestState":
				this.surface.setState({ engine: this.engineKind });
				if (!this.replayed) {
					this.replayed = true;
					const count = await this.replayStoredEvents();
					this.deps.output.appendLine(`[store] replayed "${this.name}" with ${count} event(s)`);
				}
				await this.deps.refreshModels();
				void this.pushTabs();
				break;
			case "setEngine":
				this.setEngineKind(message.engine);
				break;
			case "setMode":
				this.deps.modeRef.current = message.mode;
				await this.deps.context.globalState.update("kronyx.mode", message.mode);
				this.surface.setState({ mode: message.mode });
				break;
			case "setModel":
				// A pick is always a model together with the provider it belongs to.
				if (!message.modelId || !message.profile) break;
				await pickModel(message.modelId, message.profile);
				this.deps.pushViewState();
				break;
			case "attach":
				await this.attach(message.kind);
				break;
			case "fileQuery":
				await this.fileQuery(message.id, String(message.query ?? ""));
				break;
			case "openFile":
				{
					// Absolute paths (plan dirs may live outside the root, e.g. a tmp dir) open as-is.
					const abs = path.isAbsolute(message.path) ? message.path : this.toAbs(message.path);
					if (abs) {
						await vscode.window
							.showTextDocument(vscode.Uri.file(abs))
							.then(undefined, () => vscode.window.showWarningMessage(`Kronyx: can't open ${message.path}`));
					}
				}
				break;
			case "implementPlan": {
				await this.implementPlan(message.path);
				break;
			}
			case "newSession":
				// Sidebar/right-window surfaces start a fresh named session; editor tabs spawn a new tab.
				if (this.deps.isSidebar?.(this)) {
					await this.startNewSession();
				} else {
					await vscode.commands.executeCommand("kronyx.newSession");
				}
				break;
			case "switchSession":
				await this.openSession(message.name);
				break;
			case "closeSession":
				await this.closeSession(message.name);
				break;
			case "runInTerminal": {
				const terminal = vscode.window.createTerminal({ name: "Kronyx" });
				terminal.show();
				terminal.sendText(String(message.command ?? ""), true);
				break;
			}
			case "openSettings":
				await vscode.commands.executeCommand("kronyx.openSettingsPage");
				break;
			case "signIn":
				await vscode.commands.executeCommand("kronyx.signIn");
				break;
			case "runCloud":
				if (message.task.trim()) void vscode.commands.executeCommand("kronyx.newCloudSession", message.task, message.mode);
				break;
			case "showHistory":
				await vscode.commands.executeCommand("kronyx.showHistory");
				break;
			case "review": {
				const abs = this.toAbs(message.path);
				if (abs) await this.deps.diffReview.openReview(abs, message.path);
				break;
			}
			case "acceptChange": {
				const abs = this.toAbs(message.path);
				if (abs) {
					this.deps.diffReview.accept(abs);
					void logEpisode(this.runnerRoot ?? "", { kind: "accept", path: message.path, task: this.runTask });
					this.surface.post({ type: "info", text: `Accepted changes in ${message.path}` });
				}
				break;
			}
			case "rejectChange": {
				const abs = this.toAbs(message.path);
				if (abs) {
					await this.deps.diffReview.reject(abs);
					void logEpisode(this.runnerRoot ?? "", { kind: "reject", path: message.path, task: this.runTask });
					this.surface.post({ type: "info", text: `Reverted ${message.path}` });
				}
				break;
			}
		}
	}

	private async getRunner(_kind: EngineKind): Promise<RunnerHost | undefined> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			void vscode.window.showErrorMessage("Kronyx: open a folder first.");
			return undefined;
		}
		const root = folder.uri.fsPath;
		if (!this.engineHost || this.runnerRoot !== root) {
			this.runnerRoot = root;
			this.permLayers = await this.loadPermissionLayers(root);
			this.procs = createProcessTools({ root });
			this.browserTools = createLocalBrowserTools({ root, allowHosts: networkAllowHosts });
			const host: RunnerHost = {
				ideTools: true,
				webSearch: userConfig().webSearch,
				secretValues: () => this.knownSecrets,
				workspaceRoot: root,
				relativePath: (abs) => path.relative(root, abs).split(path.sep).join("/"),
				isDirty: (abs) =>
					vscode.workspace.textDocuments.some((doc) => doc.isDirty && doc.uri.fsPath === abs),
				approvals: {
					confirm: (toolName, input, callId) => this.confirmWrite(root, toolName, input, callId),
					check: async (toolName, input) => evaluate(this.permLayers, toolName, input, this.deps.modeRef.current),
				},
				currentMode: () => this.deps.modeRef.current,
				planDir: planDir(),
				tools: async () => [
					...createFileTools({
						root,
						isDirty: (abs) => vscode.workspace.textDocuments.some((doc) => doc.isDirty && doc.uri.fsPath === abs),
						onFileChanged: (abs, kind, stats) =>
							this.onEvent({ type: "file-changed", path: path.relative(root, abs).split(path.sep).join("/"), kind, ...stats } as Parameters<RunViewProvider["post"]>[0]),
						onBeforeWrite: (abs, before) => this.deps.diffReview.record(abs, before),
						execCommand: (command) => this.execCommand(command),
						planDir: planDir() ? () => planDir()! : undefined,
						onMemoryFact: (fact) => appendFact(root, fact),
					}),
					...createIdeTools({
						root,
						onBeforeWrite: (abs, before) => this.deps.diffReview.record(abs, before),
						onFileChanged: (abs) =>
							this.onEvent({ type: "file-changed", path: path.relative(root, abs).split(path.sep).join("/"), kind: "modified" } as Parameters<RunViewProvider["post"]>[0]),
						report: (d) =>
							void openStore(root).then((st) =>
								insertMemoryEvent(st, { op: String(d.op ?? "ide_context"), detail: d, session: this.name }, root),
							),
					}),
					...createFetchTools(userConfig().webSearch, { allowHosts: networkAllowHosts() }),
					...(this.procs?.tools ?? []),
					...(this.browserTools?.tools ?? []),
					...(await this.mcpTools()),
				],
				memory: {
					context: async (task, s) => [devContext(root), await loadMemoryContext(root, task, s)].filter(Boolean).join("\n\n"),
					onFact: (fact) => appendFact(root, fact),
				},
				log: (tag, message) => log(tag, message),
				files: {
					onBeforeWrite: (abs, before) => this.deps.diffReview.record(abs, before),
					execCommand: (command) => this.execCommand(command),
					listSkillFiles: async () => {
						const dir = path.join(root, ".kronyx", "skills");
						const out: { path: string; content: string }[] = [];
						for (const sub of await fs.readdir(dir).catch(() => [] as string[])) {
							const p = path.join(dir, sub, "SKILL.md");
							const content = await fs.readFile(p, "utf8").catch(() => null);
							if (content !== null) out.push({ path: `.kronyx/skills/${sub}/SKILL.md`, content });
						}
						return out;
					},
				},
				recall: {
					transcripts: () => this.transcripts,
					scorer: async (query, chunks) => {
						const s = await readProviderSettings(this.deps.context.secrets);
						return s ? createIdeRecallScorer(root, s.baseUrl, s.apiKey)(query, chunks) : undefined;
					},
				},
				transcripts: {
					save: (messages) => {
						this.transcripts = [...this.transcripts, { label: `run ${this.transcripts.length + 1}`, messages }].slice(-5);
						this.deps.saveTranscript?.(this.name, messages);
					},
				},
				emit: (event) => this.onEvent(event),
				events: { record: (e) => this.deps.persistEvent(this.name, e as Parameters<RunViewProvider["post"]>[0], this.runId) },
			};
			this.engineHost = host;
			void this.deps.loadDigest?.(this.name).then((d) => {
				this.legacyDigests = d.slice(-3);
			});
			void this.deps.loadTranscripts?.(this.name).then((t) => {
				this.transcripts = t;
			});
		}
		return this.engineHost;
	}

	/** Re-indexes a changed file after 500 ms of quiet, so rapid agent edits embed once. */
	private scheduleIndex(root: string, rel: string): void {
		const key = `${root}\0${rel}`;
		clearTimeout(this.indexTimers.get(key));
		this.indexTimers.set(
			key,
			setTimeout(() => {
				this.indexTimers.delete(key);
				void readProviderSettings(this.deps.context.secrets).then((s) => {
					if (s) void indexFile(root, rel, s.baseUrl, s.apiKey);
				});
			}, 500),
		);
	}

	private onEvent(event: Parameters<RunViewProvider["post"]>[0]): void {
		// Wall-clock stamp at emission: the live UI shows this exact time and the
		// persisted copy carries it into replays.
		(event as { ts?: number }).ts ??= Date.now();
		this.surface.post(event);
		// Delta events are transient streaming frames — final messages persist separately.
		if (event.type !== "assistant-delta" && event.type !== "reasoning-delta" && event.type !== "usage") {
			this.deps.persistEvent(this.name, event, this.runId);
		}
		this.deps.output.appendLine(`[${this.name}] [${event.type}] ${summarize(event)}`);
		if (event.type === "file-changed" && this.runnerRoot) {
			const abs = path.resolve(this.runnerRoot, event.path);
			this.changedPaths.add(abs);
			this.deps.comments.noteChangedFile(abs, event.kind, this.runTask);
			this.scheduleIndex(this.runnerRoot, event.path);
		}
		if (event.type === "usage") {
			const now = Date.now();
			// usage-updated is cumulative per run — the delta from the previous event
			// approximates the most recent provider request. Reset-safe: a counter
			// drop (agent handoff) counts the new value, not a clamped 0.
			const diff = (cur: number, prev: number) => (cur >= prev ? cur - prev : cur);
			const prev = this.lastUsage;
			const delta = {
				inputTokens: diff(event.inputTokens, prev.inputTokens),
				outputTokens: diff(event.outputTokens, prev.outputTokens),
				cacheReadTokens: diff(event.cacheReadTokens, prev.cacheReadTokens),
				cacheWriteTokens: diff(event.cacheWriteTokens, prev.cacheWriteTokens),
				reasoningTokens: diff(event.reasoningTokens ?? 0, prev.reasoningTokens),
			};
			const billedCost =
				(event.totalCost ?? 0) > 0 || prev.totalCost > 0 ? diff(event.totalCost ?? 0, prev.totalCost) : undefined;
			this.lastUsage = {
				inputTokens: event.inputTokens,
				outputTokens: event.outputTokens,
				cacheReadTokens: event.cacheReadTokens,
				cacheWriteTokens: event.cacheWriteTokens,
				reasoningTokens: event.reasoningTokens ?? 0,
				totalCost: event.totalCost ?? 0,
			};
			this.deps.recordUsage({
				session: this.name,
				task: this.runTask,
				tokensIn: event.inputTokens,
				tokensOut: event.outputTokens,
				cacheRead: event.cacheReadTokens,
				cacheWrite: event.cacheWriteTokens,
				at: now,
			});
			const p = this.runProvider;
			const pricing = p ? modelPricing(p.modelId, undefined) : undefined;
			this.deps.recordApiCall?.({
				session: this.name,
				task: this.runTask,
				at: now,
				status: "ok",
				provider: p?.providerId,
				baseUrl: p?.baseUrl,
				model: p?.modelId,
				profile: p?.profile,
				keyLabel: p?.profile ?? "default",
				engine: this.engineTag(),
				tokensIn: delta.inputTokens,
				tokensOut: delta.outputTokens,
				cacheRead: delta.cacheReadTokens,
				cacheWrite: delta.cacheWriteTokens,
				reasoningTokens: delta.reasoningTokens,
				billedCostUsd: billedCost,
				iteration: event.iteration,
				contextMsgs: event.contextMsgs,
				costUsd: estimateCostUsd(delta, pricing),
				durationMs: this.lastUsageAt ? now - this.lastUsageAt : now - this.runStartedAt,
				runId: this.runId,
			});
			this.lastUsageAt = now;
		}
		if (event.type === "run-started") {
			this.deps.comments.clear();
			this.deps.setStatus("running");
			this.runStartedAt = Date.now();
			this.runTask = event.task;
			this.lastUsageAt = 0;
			this.diagBaseline = diagCounts();
			void this.pushTabs();
		}
		if (event.type === "run-finished") {
			this.procs?.dispose();
			void this.browserTools?.dispose();
			this.deps.setStatus("idle");
			this.deps.recordRun({
				task: this.runTask,
				session: this.name,
				status: event.status,
				durationMs: Date.now() - this.runStartedAt,
				at: Date.now(),
				tokensIn: this.lastUsage.inputTokens,
				tokensOut: this.lastUsage.outputTokens,
				cacheRead: this.lastUsage.cacheReadTokens,
				cacheWrite: this.lastUsage.cacheWriteTokens,
				runId: this.runId,
			});
			this.recordDigest(event.status, event.text);
			if (this.diagBaseline && this.runnerRoot) {
				const after = diagCounts();
				const root = this.runnerRoot;
				void openStore(root).then((st) =>
					insertMemoryEvent(st, { op: "diagnostics", session: this.name, detail: { before: this.diagBaseline, after } }, root),
				);
			}
			void this.onFinished(event.status);
		}
		if (event.type === "run-failed") {
			this.procs?.dispose();
			void this.browserTools?.dispose();
			// The failing request never reports usage — still log it so the ledger
			// shows non-2xx calls like a provider dashboard would.
			if (this.lastUsageAt || this.runStartedAt) {
				const p = this.runProvider;
				this.deps.recordApiCall?.({
					session: this.name,
					task: this.runTask,
					at: Date.now(),
					status: "failed",
					provider: p?.providerId,
					baseUrl: p?.baseUrl,
					model: p?.modelId,
					profile: p?.profile,
					keyLabel: p?.profile ?? "default",
					engine: this.engineTag(),
					tokensIn: 0,
					tokensOut: 0,
					durationMs: Date.now() - (this.lastUsageAt || this.runStartedAt),
					runId: this.runId,
				});
			}
			this.deps.setStatus("failed");
			this.deps.recordRun({
				task: this.runTask,
				session: this.name,
				status: "failed",
				durationMs: Date.now() - this.runStartedAt,
				at: Date.now(),
				runId: this.runId,
			});
			this.recordDigest("failed", event.error);
		}
	}

	private recordDigest(status: string, summary: string): void {
		const files = [...this.changedPaths].map((abs) =>
			this.runnerRoot ? path.relative(this.runnerRoot, abs).split(path.sep).join("/") : abs,
		);
		const digest = { task: this.runTask, status, summary, filesChanged: files, at: Date.now() };
		this.legacyDigests = [...this.legacyDigests, digest].slice(-3);
		this.deps.saveDigest?.(this.name, this.legacyDigests);
	}

	/** `pick` is the composer chip's pair; the run uses exactly that pair, or none of them. */
	/** "Implement this plan" — from the plan-ready card or the editor CodeLens:
	 *  flips to code mode and runs a scope-bounded implement: the plan file's
	 *  steps are seeded onto this run's task board (no planner call, no prior
	 *  board adoption), the plan's verify command becomes the close-out gate,
	 *  and step failures surface on the board for the model to fix or reroute. */
	public async implementPlan(planPath: string): Promise<void> {
		this.deps.modeRef.current = "code";
		this.surface.setState({ mode: "code" });
		const rel = path.isAbsolute(planPath) ? path.relative(this.runnerRoot ?? "", planPath) : planPath;
		const planned = await this.planSeed(rel);
		if ("error" in planned) return this.surface.post({ type: "run-failed", error: planned.error });
		await this.startRun(implementPrompt(planPath) + IMPLEMENT_SCOPE_NOTE, "code", undefined, this.engineKind, planned.seed);
	}

	/** Board for an implement run on a plan file: the file's steps, or an error. Never the planner. */
	private async planSeed(rel: string): Promise<{ seed: SeedTask[] } | { error: string }> {
		let markdown: string;
		try {
			markdown = await fs.readFile(this.planAbs(rel), "utf8");
		} catch (err) {
			return { error: `Can't read ${rel}: ${err instanceof Error ? err.message : String(err)}` };
		}
		return planSeedTasks(rel, markdown);
	}

	private planAbs(rel: string): string {
		return path.isAbsolute(rel) ? rel : path.join(this.runnerRoot ?? "", rel);
	}

	private async startRun(task: string, mode?: AgentMode, pick?: { modelId: string; profile: string }, engine: EngineKind = this.engineKind, seed?: SeedTask[]): Promise<void> {
		const freshRunner = false;
		const active = await this.getRunner(engine);
		if (!active) return;
		if (!this.deps.runLock.tryAcquire(this.name)) {
			this.surface.post({
				type: "run-failed",
				error: `A run is already active in "${this.deps.runLock.current}". Stop it or wait for it to finish.`,
			});
			return;
		}
		try {
			if (mode) this.deps.modeRef.current = mode;
			if (pick && (!pick.modelId || !pick.profile)) {
				this.surface.post({ type: "run-failed", error: "No model selected — pick a provider and model in the composer." });
				return;
			}
			const { settings, error } = await resolveProvider(this.deps.context.secrets, pick ?? currentSelection());
			if (!settings) {
				this.surface.post({ type: "run-failed", error: providerErrorMessage(error!) });
				return;
			}
			// Wire-shape resolution, strict: the session's gear pick wins; "auto" defers to
			// the profile's API-type override, then the matrix default. No fallbacks — an
			// unsupported explicit pick fails the run before it starts.
			const profileShape = profiles().find((p) => p.name === settings.profile)?.apiShape;
			const preference: TransportKind = engine === "auto" || engine === "harness" || !engine ? (profileShape && profileShape !== "auto" ? profileShape : "auto") : engine;
			const transport: TransportKind = preference;
			const choice = chooseTransport(settings.providerId, transport, settings.baseUrl);
			if (!choice.ok) {
				this.surface.post({ type: "run-failed", error: choice.message });
				return;
			}
			this.setEngineKind(engine);
			this.runEngine = engine;
			const shown = currentSelection();
			if (pick && (shown?.modelId !== pick.modelId || shown?.profile !== pick.profile)) {
				await pickModel(pick.modelId, pick.profile);
				this.deps.pushViewState();
			}
			this.runProvider = {
				providerId: settings.providerId,
				baseUrl: settings.baseUrl,
				modelId: settings.modelId,
				profile: settings.profile,
			};
			this.deps.output.appendLine(
				`[${this.name}] Run with ${settings.providerId} ${settings.modelId} at ${settings.baseUrl} (mode: ${this.deps.modeRef.current})`,
			);
			this.changedPaths.clear();
			this.runId = randomUUID();
			await this.beforeRun(task);
			const restored = freshRunner ? summarizePrior(await this.deps.loadEvents(this.name)) : "";
			const expanded = await expandMentions(
				restored ? `${task}\n\nContext from the previous session in this tab:\n${restored}` : task,
				this.runnerRoot ?? "",
			);
			// Images go to the selected model only: no substitute describer model.
			const attachments: RunnerAttachment[] = await collectImageMentions(task, this.runnerRoot ?? "");
			const meta = profiles().find((p) => p.name === settings.profile)?.models?.find((m) => m.id === settings.modelId);
			if (attachments.length && !acceptsImages(meta)) {
				this.surface.post({ type: "run-failed", error: `${settings.modelId} can't view images — pick a vision-capable model or remove the attached images.` });
				return;
			}
			this.lastTransport = choice.transport;
			// Implementation intent toward a plan document (implement/build/follow/as per):
			// the document IS the board — parsed deterministically and seeded, never
			// handed to the planner. Reference use of .md files never enters this path.
			let runSeed = seed;
			const seedNotes: string[] = [];
			let runTask = expanded;
			const named = !runSeed ? implementationIntent(task) : undefined;
			if (named) {
				if (!(await fs.access(this.planAbs(named)).then(() => true, () => false))) {
					return this.surface.post({ type: "run-failed", error: `${named} doesn't exist — save the plan there or fix the path, then run again.` });
				}
				const planned = await this.planSeed(named);
				if ("error" in planned) return this.surface.post({ type: "run-failed", error: planned.error });
				runSeed = planned.seed;
				seedNotes.push(`Read ${named} — parsed ${runSeed.length} phase${runSeed.length === 1 ? "" : "s"} (${runSeed.reduce((n, t) => n + t.steps.length, 0)} steps). The document is the scope; no planner call this run.`);
				runTask += IMPLEMENT_SCOPE_NOTE;
				// The document is authoritative scope — its full content rides in the run
				// context even when the user typed a bare path without @-expansion.
				if (!task.includes("@")) {
					try {
						const content = await fs.readFile(this.planAbs(named), "utf8");
						if (!runTask.includes(content.slice(0, 200))) runTask = `<plan-document path="${named}">\n${content.slice(0, 16000)}\n</plan-document>\n\n${runTask}`;
					} catch { /* the seed already carries the steps */ }
				}
			}
			await this.runOnHarness(runTask, settings, task, choice.transport, false, attachments, runSeed, seedNotes);
		} finally {
			this.deps.runLock.release(this.name);
		}
	}

	/** Continue a run paused at the step cap on its own agent. Refuses if the composer pick changed since the run started. */
	private async resumeRun(): Promise<void> {
		if (!this.harnessPaused) {
			this.surface.post({ type: "run-failed", error: "Nothing to continue — start a new task." });
			return;
		}
		const { settings, error } = await resolveProvider(this.deps.context.secrets);
		const started = this.runProvider;
		if (!settings || (started && (settings.modelId !== started.modelId || settings.profile !== started.profile))) {
			this.surface.post({
				type: "run-failed",
				error: settings ? `The model changed while this run was paused — stop it and start again on ${settings.modelId}.` : providerErrorMessage(error!),
			});
			return;
		}
		if (!this.deps.runLock.tryAcquire(this.name)) {
			this.surface.post({
				type: "run-failed",
				error: `A run is already active in "${this.deps.runLock.current}". Stop it or wait for it to finish.`,
			});
			return;
		}
		try {
			await this.runOnHarness("", settings, "", this.lastTransport, true);
		} finally {
			this.deps.runLock.release(this.name);
		}
	}

	private async beforeRun(task: string): Promise<void> {
		const settings = gitSettings();
		if (!settings.autoBranch || !this.runnerRoot) return;
		const repo = git.getRepo(this.runnerRoot);
		if (!repo) return;
		try {
			const branch = `${settings.branchPrefix}${git.slugify(task)}`;
			await git.createBranch(repo, branch);
			this.surface.post({ type: "info", text: `Created branch ${branch}` });
		} catch (error) {
			this.surface.post({ type: "info", text: `Auto-branch skipped: ${errorMessage(error)}` });
		}
	}

	private async onFinished(status: string): Promise<void> {
		if (status !== "completed" || !this.runnerRoot) return;
		if (gitSettings().commitOnFinish) {
			const repo = git.getRepo(this.runnerRoot);
			if (repo && this.changedPaths.size > 0) {
				try {
					await git.commitPaths(repo, [...this.changedPaths], `kronyx: run on ${git.currentBranch(repo)}`);
					this.surface.post({ type: "info", text: `Committed ${this.changedPaths.size} changed file(s)` });
				} catch (error) {
					this.surface.post({ type: "info", text: `Commit skipped: ${errorMessage(error)}` });
				}
			}
		}
		if (checksOnFinish()) {
			for (const result of await runChecks(this.runnerRoot)) {
				this.surface.post({ type: "check", ...result });
			}
		}
	}

	private async execCommand(command: string): Promise<string | null> {
		if (!(sandboxEnabled() && this.runnerRoot)) return null;
		const backend = sandboxBackend();
		if (backend === "docker" || backend === "devcontainer") return this.execContainer(backend, command);
		if (backend !== "e2b") return null;
		if (!this.sandbox) this.sandbox = new E2bSandbox();
		await this.sandbox.ensure(this.deps.context.secrets);
		if (!this.sandboxSynced) {
			const synced = await this.sandbox.syncUp(this.runnerRoot);
			this.sandboxSynced = true;
			this.surface.post({ type: "info", text: `Sandbox: synced ${synced} file(s) to E2B` });
		}
		const result = await this.sandbox.run(command);
		const out = `${result.stdout}${result.stderr}`.trim();
		return `exit ${result.exitCode}\n${out.length > 8000 ? `${out.slice(0, 8000)}\n... (truncated)` : out}`;
	}

	/** Docker/devcontainer backends: run the command in a container over the workspace. */
	private async execContainer(backend: string, command: string): Promise<string | null> {
		const root = this.runnerRoot;
		if (!root) return null;
		const config = vscode.workspace.getConfiguration("kronyx");
		const image = config.get<string>("sandbox.image", "kronyx/base:latest");
		const wrap =
			backend === "devcontainer"
				? `devcontainer exec --workspace-folder ${JSON.stringify(root)} sh -c ${JSON.stringify(command)}`
				: `docker run --rm -v ${JSON.stringify(root)}:/workspace -w /workspace ${image} sh -c ${JSON.stringify(command)}`;
		const { exec } = await import("node:child_process");
		return new Promise((resolve) => {
			exec(wrap, { timeout: 120_000 }, (error, stdout, stderr) => {
				const out = `${stdout}${stderr}`.trim();
				const head = `exit ${error ? 1 : 0}\n`;
				resolve(out.length > 8000 ? `${head}${out.slice(0, 8000)}\n... (truncated)` : `${head}${out}`);
			});
		});
	}

	private toAbs(rel: string): string | undefined {
		// Harness sessions never build an engine runner — fall back to the
		// workspace folder so file links still resolve.
		const root = this.runnerRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) return undefined;
		const abs = path.resolve(root, rel);
		return abs.startsWith(root + path.sep) || abs === root ? abs : undefined;
	}

	private pendingPermissions = new Map<
		string,
		{ toolName: string; input: unknown; resolve: (decision: "allow" | "always" | "deny" | "alwaysTool" | "alwaysRule") => void }
	>();
	private permittedTools = new Set<string>();

	/** Layered rule files: ~/.kronyx global, <root>/.kronyx project + local. */
	private async loadPermissionLayers(root: string): Promise<PermissionLayers> {
		const read = async (p: string): Promise<PermissionRules> =>
			parsePermissionsText(await fs.readFile(p, "utf8").catch(() => ""));
		return {
			global: await readGlobalPermissions(),
			project: await read(path.join(root, ".kronyx", "permissions.json")),
			local: await read(path.join(root, ".kronyx", "permissions.local.json")),
			modes: await readGlobalModePermissions(),
		};
	}

	/** Persist an "always allow this" decision as a narrow rule in the repo-local file. */
	private async appendLocalRule(root: string, rule: string): Promise<void> {
		const file = path.join(root, ".kronyx", "permissions.local.json");
		let doc: { permissions?: Record<string, unknown> } = {};
		try {
			doc = JSON.parse(await fs.readFile(file, "utf8")) as typeof doc;
		} catch {}
		doc.permissions ??= {};
		const allow = Array.isArray(doc.permissions.allow) ? (doc.permissions.allow as unknown[]) : [];
		if (!allow.includes(rule)) allow.push(rule);
		doc.permissions.allow = allow;
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, JSON.stringify(doc, null, 2) + "\n");
		// Keep the personal layer out of commits: .kronyx/.gitignore covers it.
		const gi = path.join(root, ".kronyx", ".gitignore");
		const giText = await fs.readFile(gi, "utf8").catch(() => "");
		if (!giText.includes("permissions.local.json")) {
			await fs.writeFile(gi, `${giText}${giText && !giText.endsWith("\n") ? "\n" : ""}permissions.local.json\n`);
		}
		this.permLayers.local = parsePermissionsText(JSON.stringify(doc));
	}

	/** Compute a preview diff for the permission card — real hunks for write_file, pseudo-diff from edits otherwise. */
	private async pendingDiff(root: string, file: string, toolName: string, input: unknown): Promise<string | undefined> {
		try {
			const inp = input as {
				content?: string;
				edits?: { old_text?: string; new_text?: string; old?: string; new?: string }[];
				lines?: string;
				position?: number;
				command?: string;
				file_text?: string;
				old_str?: string;
				new_str?: string;
				old_text?: string;
				new_text?: string;
			};
			const hunkDiff = async (after: string) => {
				const { computeHunks, formatHunks } = await import("../diff/hunks");
				let before = "";
				try {
					before = (await fs.readFile(path.join(root, file), "utf8")) ?? "";
				} catch {
					/* new file */
				}
				return formatHunks(computeHunks(before, after));
			};
			if (toolName === "write_file" && typeof inp?.content === "string") return hunkDiff(inp.content);
			if (toolName === "edit_file" && Array.isArray(inp?.edits)) {
				return inp.edits
					.flatMap((e) => [
						...String(e.old_text ?? e.old ?? "").split("\n").map((l) => `-${l}`),
						...String(e.new_text ?? e.new ?? "").split("\n").map((l) => `+${l}`),
					])
					.join("\n");
			}
			if (toolName === "file_editor") {
				const oldStr = inp?.old_str ?? inp?.old_text;
				const newStr = inp?.new_str ?? inp?.new_text;
				if (inp?.command === "create" && typeof inp.file_text === "string") return hunkDiff(inp.file_text);
				if (inp?.command === "str_replace" && (oldStr || newStr)) {
					return [
						...String(oldStr ?? "").split("\n").map((l) => `-${l}`),
						...String(newStr ?? "").split("\n").map((l) => `+${l}`),
					].join("\n");
				}
				if ((inp?.command === "insert" || inp?.command === "replace_function") && typeof newStr === "string") {
					return newStr.split("\n").map((l) => `+${l}`).join("\n");
				}
			}
			if ((toolName === "append_file" || toolName === "insert_lines") && typeof inp?.content === "string") {
				return inp.content.split("\n").map((l) => `+${l}`).join("\n");
			}
		} catch {
			/* diff preview is best-effort */
		}
		return undefined;
	}

	/** One task on the harness loop (the composer's Harness engine). Local only. Acceptance commands need approval before they run. */
	private async runOnHarness(task: string, settings: ProviderSettings, displayTask: string, transport: TransportKind, resume = false, attachments: RunnerAttachment[] = [], seed?: SeedTask[], preNotes: string[] = []): Promise<void> {
		const root = this.runnerRoot ?? "";
		const mode = this.deps.modeRef.current;
		// Plan mode keeps the plan-visible exceptions offered (write_file scoped,
		// run_command behind approval); ask mode hides all write tools.
		// update_progress is hidden on every harness run: the task board is the
		// progress display, so a parallel narrative channel is invention-prone by
		// construction. It stays for the legacy engines (cloud worker has no board).
		const hidden = new Set(["update_progress",
			...(mode === "plan"
				? [...READ_ONLY_HIDDEN].filter((n) => !PLAN_VISIBLE.has(n))
				: mode === "ask"
					? [...READ_ONLY_HIDDEN]
					: []),
		]);
		// Same tool set and policy pipeline as the Cline loop: mode hiding, write-mode and permission guards, parallel markers.
		const assembled = this.engineHost ? await assembleToolSet(this.engineHost, settings, task, () => this.harnessAbort?.abort(), { repeatGuard: false }) : undefined;
		const tools = assembled?.tools ?? (await this.engineHost?.tools?.()) ?? [];
		const log = await FileEventLog.open(this.harnessFile());
		// Index earlier runs' digests into run memory BEFORE the loop starts — the
		// model's recall_context scope 'runs' must not race a fire-and-forget index.
		const priorEvents = await log.read();
		try {
			await indexRunDigests(root, this.name, "", priorEvents, settings.baseUrl, settings.apiKey);
		} catch {
			/* indexing is best-effort */
		}
		const provider = { providerId: settings.providerId, baseUrl: settings.baseUrl, apiKey: settings.apiKey, modelId: settings.modelId, maxOutputTokens: settings.maxTokens };
		// The transport is the model side only; the loop is always the harness.
		// Provider/model behavior resolves independently from the wire adapter.
		const openaiConfig = vscode.workspace.getConfiguration("kronyx");
		const model = (() => {
			try {
				return createModelAdapter(transport, {
					...provider,
					store: openaiConfig.get<boolean>("openai.store", true),
					conversations: openaiConfig.get<boolean>("openai.conversations", true),
					contextWindow: settings.contextWindow,
				});
			} catch (err) {
				this.surface.post({ type: "run-failed", error: err instanceof Error ? err.message : String(err) });
				return undefined;
			}
		})();
		if (!model) return;
		this.runWire = model.capabilities?.wire;
		const behavior = resolveBehaviorProfile({
			providerId: settings.providerId,
			modelId: settings.modelId,
			profile: settings.profile,
			contextWindow: settings.contextWindow,
			maxOutputTokens: settings.maxTokens,
			capabilities: model.capabilities,
		});
		const run = shellExec(root);
		const verifier = new CommandVerifier(async (command) =>
			(await this.confirmWrite(root, "run_command", { command })) ? run(command) : { ok: false, output: "Acceptance command was not approved." },
		);
		const pipeline = assembled?.pipeline;
		const basePort = createHarnessToolPort({
			tools,
			hidden,
			check: async (name, input, callId) => {
				if (!pipeline) return evaluate(this.permLayers, name, input, mode) ?? "ask";
				const verdict = await pipeline.runPre({ name, input, callId });
				return verdict.kind === "allow" ? "allow" : verdict.kind === "deny" ? "deny" : "ask";
			},
			confirm: (name, input, callId) => this.confirmWrite(root, name, input, callId),
		});
		const toolPort = withRecall(
			withExplore(withReadCache(withBatchReads(basePort)), model),
			log,
			async (query, chunks) => {
				const s = await readProviderSettings(this.deps.context.secrets);
				return s ? createIdeRecallScorer(root, s.baseUrl, s.apiKey)(query, chunks) : undefined;
			},
			async (query, filter) => {
				const s = await readProviderSettings(this.deps.context.secrets);
				return s ? searchRunDigests(root, s.baseUrl, s.apiKey, query, filter) : undefined;
			},
		);
		this.runEngine = "harness";
		this.runTransport = transport;
		const abort = new AbortController();
		this.harnessAbort = abort;
		// Stable system prompt (same builder as the Cline loop). Per-run memory and dev context go in the user message.
		// The prompt's tool-conditional rules must reflect what the harness
		// actually offers — the assembled set predates mode-hiding and the
		// harness-only exclusions (update_progress), so subtract them here.
		const offered = assembled?.available ? new Set([...assembled.available].filter((n) => !hidden.has(n))) : undefined;
		const system =
			buildSystemPrompt(root, mode, "", this.engineHost?.environment, undefined, offered) +
			"\n\nHarness notes: a task checklist is maintained automatically — focus on the work, not on planning tools. Batch independent reads into one read_files call; elided tool results are recovered with log_slice or recall_context. " +
			"Earlier runs are indexed in memory — recall_context with scope 'runs' searches their digests (prompts, task outcomes, final reports, compaction briefs) across this and previous sessions; narrow with runId or task. Prefer it over re-reading files for prior work.";
		// Memory injection on resumes too — but keep it small: rules + facts +
		// a compact run index (not semantic snippet dumps). The model drills into
		// prior runs with recall_context scope 'runs' when the index isn't enough.
		const baseMemory = (await this.engineHost?.memory?.context?.("", settings)) ?? "";
		const runIndex = buildRunIndex(priorEvents, this.name);
		const memory = [baseMemory, runIndex].filter(Boolean).join("\n\n");
		const digests = resume ? [] : this.legacyDigests;
		const digestBlock = digests.length
			? `Earlier runs in this session (oldest first):\n${digests.map((d, i) => `${i + 1}) ${d.task} — ${d.status}. ${d.summary.slice(0, 800)}${d.filesChanged.length ? ` Files: ${d.filesChanged.join(", ")}.` : ""}`).join("\n")}`
			: "";
		const harnessNotes: string[] = [...preNotes];
		// AGENTS.md is the repo's own operating guide — conventions, build/test
		// commands, architecture. Injected deterministically into every run so the
		// model starts with repo understanding instead of rediscovering it through
		// exploration. It informs where to look; the model still verifies against
		// actual source before editing.
		let repoGuide = "";
		try {
			const guide = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
			if (guide.trim()) {
				const capped = guide.slice(0, 8000);
				repoGuide = `Repository guide (AGENTS.md) — conventions, build/test commands and architecture. Read before exploring; prefer it over rediscovery.\n<agents-md>\n${capped}${guide.length > capped.length ? "\n[truncated]" : ""}\n</agents-md>`;
				harnessNotes.push(`Read AGENTS.md (${guide.length > 8000 ? "first 8k of " + guide.length + " chars" : guide.length + " chars"}) — repo guide is in this run's context.`);
			}
		} catch {
			/* no AGENTS.md — nothing injected */
		}
		const context = [repoGuide, memory, digestBlock].filter(Boolean).join("\n\n") || undefined;
		try {
			const nudgeWrites = WRITE_MODES.has(mode) && !isConversationalTask(task);
			// Every real task gets a board, in every mode — in plan/ask mode the
			// board IS the deliverable; signals for unavailable tools are stripped.
			const plan = !isConversationalTask(task);
			const images = attachments.flatMap((a) => (a.data?.byteLength && a.mediaType.startsWith("image/") ? [{ mediaType: a.mediaType, base64: Buffer.from(a.data).toString("base64") }] : []));
			const store = await openStore(root);
			const knowledgeStore = store ? new SqliteKnowledgeStore(store) : undefined;
			const executionStateStore = store ? new SqliteExecutionStateStore(store) : undefined;
			const knowledgeEmbedder = knowledgeStore
				? {
						model: embeddingModel() || "local",
						embed: (texts: string[], op: string) => embedTexts(settings.baseUrl, settings.apiKey, texts, op, root),
					}
				: undefined;
			const outcome = await runHarness(
				{
					runId: this.runId,
					sessionId: this.name,
					...(knowledgeStore ? { knowledgeStore, knowledgeScope: { root, sessionId: this.name }, ...(knowledgeEmbedder ? { knowledgeEmbedder } : {}) } : {}),
					...(executionStateStore ? { executionStateStore } : {}),
					log,
					model,
					behavior,
					tools: toolPort,
					verifier,
					emit: (e) => this.onEvent(e),
					signal: abort.signal,
					system,
					nudgeWrites,
					writable: () => WRITE_MODES.has(this.deps.modeRef.current),
					limits: { maxTurns: settings.maxIterations },
					// Hit the turn cap → ask in chat instead of silently pausing.
					// "Always" answers auto-continue future windows for this run.
					onTurnLimit: (used, limit) =>
						this.confirmWrite(root, "continue_run", {
							command: `Run reached ${used} turns (limit ${limit}). Continue for another ${limit}?`,
						}),
					// Steering "ask" verdicts (plan.drift) go through the same in-chat card.
					onSteerAsk: (question) => this.confirmWrite(root, "steer_ask", { command: question }),
					debug: vscode.workspace.getConfiguration("kronyx").get<boolean>("harness.debug", false),
					onLoop: (l) => (this.activeHarnessLoop = l),
				},
				task,
				displayTask,
				{ resume, context, images, plan, seed, notes: harnessNotes },
			);
			this.harnessPaused = outcome.status === "paused";
			void this.queueHarnessReport();
		} finally {
			this.harnessAbort = undefined;
			this.activeHarnessLoop = undefined;
		}
	}

	/** Post-run: queue the harness report for this run — the sync worker uploads it to the dashboard in batches. */
	private async queueHarnessReport(): Promise<void> {
		try {
			const root = this.runnerRoot ?? "";
			const log = await FileEventLog.open(this.harnessFile());
			const events = await log.read();
			const report = buildHarnessReport(events, { runId: this.runId });
			upsertHarnessReport(await openStore(root), { runId: this.runId, session: this.name, report }, root);
			// Persist the run's digest (prompt + task outcomes + final report) into the
			// vector store so later runs recall it via recall_context scope 'runs'.
			const s = await readProviderSettings(this.deps.context.secrets);
			if (s) await indexRunDigests(root, this.name, this.runId, events, s.baseUrl, s.apiKey);
		} catch (err) {
			log("harness", `report queue failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Session log for the harness: one JSONL file per session. */
	private harnessFile(): string {
		return path.join(this.runnerRoot ?? "", ".kronyx", "harness", `${this.name.replace(/[^\w-]+/g, "-")}.jsonl`);
	}

	private harnessCompact(): void {
		if (!this.activeHarnessLoop?.requestCompact()) this.deps.output.appendLine("[ctx] nothing to compact: no running run, or Conversations compact on the server");
	}

	/** Clear context between runs: appends to the log, so the next run's replay starts empty. Ledger and log are kept. */
	private async harnessClear(): Promise<void> {
		if (this.activeHarnessLoop) {
			this.surface.post({ type: "info", text: "Clear context works between runs. Stop the run first." });
			return;
		}
		const log = await FileEventLog.open(this.harnessFile());
		await log.append({ type: "context.cleared", runId: this.runId });
		this.surface.post({ type: "info", text: "Context cleared. The next task starts fresh; the task board and log are kept." });
	}

	/** Best-guess plan dir for save_plan cards: the configured dir wins; else the
	 *  first conventional folder that already holds markdown (plans/, docs/plans/,
	 *  docs/, .kronyx/plans/); else "plans". */
	private async detectPlanDir(root: string): Promise<string> {
		const configured = planDir();
		if (configured && configured !== "plans") return configured;
		for (const rel of ["plans", "docs/plans", "docs", ".kronyx/plans"]) {
			try {
				const names = await fs.readdir(path.join(root, rel));
				if (names.some((n) => n.endsWith(".md"))) return rel;
			} catch {
				/* keep looking */
			}
		}
		return configured || "plans";
	}

	private async confirmWrite(root: string, toolName: string, input: unknown, callId?: string): Promise<boolean> {
		// Plan mode never auto-approves: the mode exists for human review, and a
		// silent write there is exactly the failure the mode prevents. Explicit
		// "always" decisions the user made this session still stand.
		const autoOk = this.deps.modeRef.current === "plan" ? this.approveAll || this.permittedTools.has(toolName) : autoApproveWrites() || this.approveAll || this.permittedTools.has(toolName);
		if (autoOk) return true;
		let file =
			(input as { path?: string })?.path ??
			(input as { command?: string })?.command ??
			(input as { pattern?: string })?.pattern ??
			(toolName.startsWith("mcp_") ? JSON.stringify(input ?? {}).slice(0, 300) : undefined) ??
			"(unknown file)";
		// save_plan with only a slug resolves to <detected plan dir>/<slug>.md —
		// the card shows (and can edit) that resolved path.
		if (toolName === "save_plan" && !(input as { path?: string })?.path) {
			const slug = String((input as { slug?: string })?.slug || "plan").replace(/[^\w-]+/g, "-").slice(0, 60) || "plan";
			file = `${await this.detectPlanDir(root)}/${slug}.md`;
		}
		const id = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const diff = await this.pendingDiff(root, file, toolName, input);
		const event = { type: "permission-request" as const, id, tool: toolName, path: file, diff, ...(callId ? { callId } : {}) };
		this.surface.post(event);
		this.deps.persistEvent(this.name, event, this.runId);
		void root;
		const decision = await new Promise<"allow" | "always" | "deny" | "alwaysTool" | "alwaysRule">((resolve) => {
			this.pendingPermissions.set(id, { toolName, input, resolve });
		});
		const response = { type: "permission-response" as const, id, decision };
		this.surface.post(response);
		this.deps.persistEvent(this.name, response, this.runId);
		void logEpisode(root, { kind: "permission", path: file, task: this.runTask, tool: toolName, decision });
		if (decision === "always") this.approveAll = true;
		if (decision === "alwaysTool") this.permittedTools.add(toolName);
		if (decision === "alwaysRule") {
			const rule = ruleFor(toolName, input);
			await this.appendLocalRule(root, rule).catch((e) => {
				log("permissions", `failed to persist rule: ${e}`);
			});
			this.surface.post({ type: "info", text: `Rule saved: allow ${rule} (.kronyx/permissions.local.json)` });
		}
		return decision !== "deny";
	}

	/** @-completion: fuzzy-match workspace files for the composer typeahead.
	 *  Subsequence matching with gap penalty; basename hits rank first. */
	private async fileQuery(id: string, query: string): Promise<void> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder || !id) return;
		const files = await vscode.workspace.findFiles("**/*", "{**/node_modules/**,**/.git/**,**/dist/**,**/target/**,**/.devhost/**}", 2000).then((uris) => uris, () => [] as vscode.Uri[]);
		const q = query.toLowerCase();
		const score = (rel: string): number | null => {
			if (!q) return 100 + rel.length;
			const lower = rel.toLowerCase();
			const base = lower.split("/").pop() ?? lower;
			if (base.startsWith(q)) return base.length - q.length;
			let ti = 0;
			let cost = 0;
			let first = -1;
			for (const ch of q) {
				const idx = lower.indexOf(ch, ti);
				if (idx < 0) return null;
				if (first < 0) first = idx;
				cost += idx - ti;
				ti = idx + 1;
			}
			return 10 + cost + first + rel.length / 100;
		};
		const matches = files
			.map((uri) => {
				const rel = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/");
				return { rel, s: score(rel) };
			})
			.filter((m): m is { rel: string; s: number } => m.s !== null)
			.sort((a, b) => a.s - b.s)
			.slice(0, 15)
			.map((m) => m.rel);
		this.surface.post({ type: "fileMatches", id, matches });
	}

	private async attach(kind: "file" | "directory" | "upload"): Promise<void> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (kind === "file") {
			if (!folder) return;
			const files = await vscode.workspace.findFiles(
				"**/*",
				"{**/node_modules/**,**/.git/**,**/dist/**}",
				500,
			);
			const picked = await vscode.window.showQuickPick(
				files.map((uri) => ({
					label: path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/"),
					uri,
				})),
				{ title: "Attach file", matchOnDescription: true },
			);
			if (picked) await this.insertAttachmentPreview(picked.uri.fsPath, picked.label, "file");
			return;
		}
		const picked = await vscode.window.showOpenDialog({
			canSelectFiles: kind === "upload",
			canSelectFolders: kind === "directory",
			canSelectMany: false,
			defaultUri: folder?.uri,
			title: kind === "upload" ? "Upload file" : "Attach directory",
		});
		const target = picked?.[0];
		if (!target) return;
		const rel = folder ? path.relative(folder.uri.fsPath, target.fsPath) : "";
		const mention = rel && !rel.startsWith("..") ? rel.split(path.sep).join("/") : target.fsPath;
		await this.insertAttachmentPreview(
			target.fsPath,
			kind === "directory" ? `${mention}/` : mention,
			kind === "directory" ? "directory" : "file",
		);
	}

	private async insertAttachmentPreview(abs: string, mention: string, kind: AttachmentPreview["kind"]): Promise<void> {
		const attachment: AttachmentPreview = {
			path: mention,
			name: path.basename(abs) || mention,
			kind,
		};
		if (kind === "file") {
			const mime = imageMime(abs);
			if (mime) {
				try {
					const stat = await fs.stat(abs);
					if (stat.size <= 4 * 1024 * 1024) {
						attachment.mime = mime;
						attachment.dataUrl = `data:${mime};base64,${(await fs.readFile(abs)).toString("base64")}`;
					}
				} catch {
					// The mention remains usable even when a visual preview cannot be read.
				}
			}
		}
		this.surface.insertAttachment(attachment);
	}
}

/** `@path` mention tokens pointing at image files → runner attachments (≤4MB each). */
async function collectImageMentions(task: string, root: string): Promise<RunnerAttachment[]> {
	const out: RunnerAttachment[] = [];
	for (const token of new Set([...task.matchAll(/@(\S+)/g)].map((m) => m[1]))) {
		const abs = path.isAbsolute(token) ? token : path.resolve(root, token);
		const mime = imageMime(abs);
		if (!mime) continue;
		try {
			const stat = await fs.stat(abs);
			if (stat.size > 4 * 1024 * 1024) continue;
			out.push({ filename: path.basename(abs), mediaType: mime, data: await fs.readFile(abs) });
		} catch {
			// Unresolvable mention — left as text for expandMentions.
		}
	}
	return out;
}

function imageMime(file: string): string | undefined {
	switch (path.extname(file).toLowerCase()) {
		case ".png": return "image/png";
		case ".jpg":
		case ".jpeg": return "image/jpeg";
		case ".gif": return "image/gif";
		case ".webp": return "image/webp";
		case ".bmp": return "image/bmp";
		default: return undefined;
	}
}

/**
 * Expand `@path` mention tokens in the task into <context> blocks read from disk.
 * Unresolvable tokens are left as-is.
 */
async function expandMentions(task: string, root: string): Promise<string> {
	const tokens = [...task.matchAll(/@(\S+)/g)].map((m) => m[1]);
	if (tokens.length === 0) return task;
	const blocks: string[] = [];
	let budget = MENTION_TOTAL_CAP;
	for (const token of new Set(tokens)) {
		const abs = path.isAbsolute(token) ? token : path.resolve(root, token);
		const stat = await fs.stat(abs).catch(() => undefined);
		if (!stat) continue;
		if (stat.isDirectory()) {
			const entries = await fs.readdir(abs).catch(() => []);
			if (entries.length > 0) {
				blocks.push(`<context path="${token}">\n${entries.slice(0, 200).join("\n")}\n</context>`);
			}
			continue;
		}
		if (stat.size > budget || stat.size > MENTION_TOTAL_CAP) continue;
		const buffer = await fs.readFile(abs);
		if (buffer.includes(0)) continue;
		budget -= stat.size;
		blocks.push(`<context path="${token}">\n${buffer.toString("utf8")}\n</context>`);
	}
	return blocks.length > 0 ? `${blocks.join("\n\n")}\n\n${task}` : task;
}

/** Builds a short context block from a restored session's persisted events. */
function summarizePrior(events: Parameters<RunViewProvider["post"]>[0][]): string {
	const lastTask = [...events].reverse().find((e) => e.type === "run-started") as { task?: string } | undefined;
	const lastText = [...events].reverse().find((e) => e.type === "assistant-text") as { text?: string } | undefined;
	const files = events.filter((e) => e.type === "file-changed").map((e) => (e as { path: string }).path);
	if (!lastTask && !lastText && files.length === 0) return "";
	// run-started persists the expanded prompt, which may already contain an
	// injected context block — strip it so blocks don't nest across sends.
	const taskText = lastTask?.task?.split("\n\nContext from the previous session in this tab:")[0];
	const parts = [
		taskText ? `Task: ${taskText.slice(0, 300)}` : "",
		files.length ? `Files touched: ${[...new Set(files)].slice(0, 20).join(", ")}` : "",
		lastText?.text ? `Last summary: ${lastText.text.slice(-600)}` : "",
	].filter(Boolean);
	return parts.join("\n").slice(0, 1500);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function summarize(event: { type: string } & Record<string, unknown>): string {
	const { type: _type, ...rest } = event;
	const text = JSON.stringify(rest);
	return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}
