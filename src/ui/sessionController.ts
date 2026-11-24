import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AgentRunner, type AgentMode, type ProviderSettings, type RunnerAttachment, type RunDigest, type RunnerHost } from "../agent/runner";
import type { AgentEngine, EngineKind } from "../agent/engine";
import { OpenAIEngine } from "../agent/openaiEngine";
import { chooseTransport, type TransportKind } from "../harness/transport";
import { buildSystemPrompt } from "../agent/systemPrompt";
import { assembleToolSet } from "../agent/toolSet";
import { withExplore } from "../harness/explore";
import { withBatchReads } from "../harness/batchReads";
import { withReadCache } from "../harness/readCache";
import { withRecall } from "../harness/recall";
import { WRITE_MODES } from "../agent/runner";
import { isConversationalTask } from "../agent/taskGuard";
import { deriveMessages, type KronyxEvent } from "../agent/events";
import { acceptsImages } from "../agent/vision";
import { evaluate, parsePermissionsText, ruleFor, type PermissionLayers, type PermissionRules } from "../agent/permissions";
import { readGlobalModePermissions, readGlobalPermissions } from "../permStore";
import type { PriorTranscript } from "../agent/recall";
import type { AgentMessage } from "@cline/shared";
import { checksOnFinish, runChecks } from "../checks";
import { E2bSandbox, sandboxBackend, sandboxEnabled } from "./e2b";
import { appendFact, createIdeRecallScorer, indexFile, loadMemoryContext, logEpisode } from "./memory";
import { createFileTools } from "../tools/fileTools";
import { FileEventLog } from "../harness/eventLog";
import { OpenAIModelPort } from "../harness/adapters/openai";
import { ClineModelPort } from "../harness/adapters/cline";
import { createHarnessToolPort } from "../harness/toolPort";
import { CommandVerifier } from "../harness/verifier";
import { shellExec } from "../harness/exec";
import { runHarness } from "../harness/runner";
import { buildHarnessReport } from "../harness/report";
import type { HarnessLoop } from "../harness/loop";
import { PLAN_VISIBLE, READ_ONLY_HIDDEN } from "../agent/toolSet";
import { createFetchTools } from "../tools/fetchTools";
import { createMcpTools, type McpServerConfig } from "../tools/mcpTools";
import { createProcessTools, type ProcTools } from "../tools/procTools";
import { createLocalBrowserTools, type LocalBrowserTools } from "../tools/localBrowserTools";
import { userConfig } from "../userConfig";
import { insertMemoryEvent, openStore, upsertHarnessReport } from "../store";
import { createIdeTools } from "./ideTools";
import { autoApproveWrites, currentSelection, estimateCostUsd, implementPrompt, modelPricing, networkAllowHosts, pickModel, planDir, type ProfileCatalog, profiles, promptForApiKey, providerErrorMessage, readProviderSettings, resolveProvider } from "../config";
import { log } from "../log";
import type { ApiCallRow } from "../store";
import * as git from "../git";
import type { RunComments } from "./comments";
import type { DiffReview } from "./diffReview";
import type { AttachmentPreview, ModelOption, RunViewProvider, WebviewMessage } from "./runViewProvider";

const MENTION_TOTAL_CAP = 50 * 1024;

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
	private runner: AgentRunner | undefined;
	/** OpenAI-compatible engine for this session; recreated when the session changes (it owns a per-session transcript). */
	private openai: OpenAIEngine | undefined;
	private engineHost: RunnerHost | undefined;
	private engineKind: EngineKind = "cline";
	/** Engine of the run in flight (or last run); stamped on api_calls rows for comparison. */
	private runEngine: EngineKind = "cline";
	private runTransport: TransportKind = "cline";
	/** Usage-row tag: harness runs are split by transport so the comparison can tell them apart. */
	private engineTag(): string {
		return this.runEngine === "harness" ? `harness:${this.runTransport}` : this.runEngine;
	}
	/** Aborts the harness run in flight (Stop). Set only while a harness run is active. */
	private harnessAbort: AbortController | undefined;
	/** True when the last harness run paused (Continue resumes it from its log). */
	private harnessPaused = false;
	/** The harness loop of the run in flight, for compact-now. */
	private activeHarnessLoop: HarnessLoop | undefined;
	private lastTransport: TransportKind = "cline";
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
		this.engineKind = deps.tabState?.get().engines?.[name] ?? "cline";
		if (!this.openTabs.includes(this.name)) this.openTabs.push(this.name);
	}

	private static sessionCounter = 0;

	/** Start a fresh named session in the same window — like Copilot's "new chat". */
	async startNewSession(): Promise<void> {
		this.resetEngines();
		this.openai = undefined;
		this.engineKind = "cline";
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
		this.openai = undefined;
		this.approveAll = false;
		this.permittedTools.clear();
		this.name = name;
		this.engineKind = this.deps.tabState?.get().engines?.[name] ?? "cline";
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
		return !!(this.runner?.isRunning || this.openai?.isRunning);
	}

	private activeEngine(): AgentEngine | undefined {
		return this.engineKind === "openai" ? this.openai : this.runner;
	}

	private stopEngines(): void {
		this.runner?.stop();
		this.openai?.stop();
		this.harnessAbort?.abort();
	}

	private resetEngines(): void {
		this.procs?.dispose();
		void this.browserTools?.dispose();
		this.runner?.reset();
		this.openai?.reset();
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
				this.deps.modeRef.current = "code";
				this.surface.setState({ mode: "code" });
				await this.startRun(implementPrompt(message.path), "code");
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

	private async getRunner(kind: EngineKind): Promise<AgentEngine | undefined> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			void vscode.window.showErrorMessage("Kronyx: open a folder first.");
			return undefined;
		}
		const root = folder.uri.fsPath;
		if (!this.runner || this.runnerRoot !== root) {
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
					confirm: (toolName, input) => this.confirmWrite(root, toolName, input),
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
			this.runner = new AgentRunner(host);
			this.openai = undefined;
			void this.deps.loadDigest?.(this.name).then((d) => this.runner?.setRunDigests(d));
			void this.deps.loadTranscripts?.(this.name).then((t) => {
				this.transcripts = t;
			});
		}
		if (!this.openai && this.engineHost) {
			this.openai = new OpenAIEngine({
				...this.engineHost,
				resume: { resumeLog: async () => deriveMessages((await this.deps.loadEvents(this.name)) as KronyxEvent[]) },
			});
			void this.deps.loadDigest?.(this.name).then((d) => this.openai?.setRunDigests(d));
		}
		return kind === "openai" ? this.openai : this.runner;
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
		this.runner?.addRunDigest(digest);
		this.openai?.addRunDigest(digest);
		this.deps.saveDigest?.(this.name, this.runner?.runDigests ?? []);
	}

	/** `pick` is the composer chip's pair; the run uses exactly that pair, or none of them. */
	private async startRun(task: string, mode?: AgentMode, pick?: { modelId: string; profile: string }, engine: EngineKind = this.engineKind): Promise<void> {
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
			const choice = chooseTransport(settings.providerId, engine === "openai" ? "openai" : "cline");
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
			await this.runOnHarness(expanded, settings, task, choice.transport, false, attachments);
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
			};
			if (toolName === "write_file" && typeof inp?.content === "string") {
				const { computeHunks, formatHunks } = await import("../diff/hunks");
				let before = "";
				try {
					before = (await fs.readFile(path.join(root, file), "utf8")) ?? "";
				} catch {
					/* new file */
				}
				return formatHunks(computeHunks(before, inp.content));
			}
			if (toolName === "edit_file" && Array.isArray(inp?.edits)) {
				return inp.edits
					.flatMap((e) => [
						...String(e.old_text ?? e.old ?? "").split("\n").map((l) => `-${l}`),
						...String(e.new_text ?? e.new ?? "").split("\n").map((l) => `+${l}`),
					])
					.join("\n");
			}
		} catch {
			/* diff preview is best-effort */
		}
		return undefined;
	}

	/** One task on the harness loop (the composer's Harness engine). Local only. Acceptance commands need approval before they run. */
	private async runOnHarness(task: string, settings: ProviderSettings, displayTask: string, transport: TransportKind, resume = false, attachments: RunnerAttachment[] = []): Promise<void> {
		const root = this.runnerRoot ?? "";
		const mode = this.deps.modeRef.current;
		// Plan mode keeps the plan-visible exceptions offered (write_file scoped,
		// run_command behind approval); ask mode hides all write tools.
		const hidden =
			mode === "plan"
				? new Set([...READ_ONLY_HIDDEN].filter((n) => !PLAN_VISIBLE.has(n)))
				: mode === "ask"
					? READ_ONLY_HIDDEN
					: new Set<string>();
		// Same tool set and policy pipeline as the Cline loop: mode hiding, write-mode and permission guards, parallel markers.
		const assembled = this.engineHost ? await assembleToolSet(this.engineHost, settings, task, () => this.harnessAbort?.abort()) : undefined;
		const tools = assembled?.tools ?? (await this.engineHost?.tools?.()) ?? [];
		const log = await FileEventLog.open(this.harnessFile());
		const provider = { providerId: settings.providerId, baseUrl: settings.baseUrl, apiKey: settings.apiKey, modelId: settings.modelId, maxOutputTokens: settings.maxTokens };
		// The transport is the model side only; the loop is always the harness.
		const model = transport === "openai" ? new OpenAIModelPort(provider) : new ClineModelPort(provider);
		const run = shellExec(root);
		const verifier = new CommandVerifier(async (command) =>
			(await this.confirmWrite(root, "run_command", { command })) ? run(command) : { ok: false, output: "Acceptance command was not approved." },
		);
		const pipeline = assembled?.pipeline;
		const basePort = createHarnessToolPort({
			tools,
			hidden,
			check: async (name, input) => {
				if (!pipeline) return evaluate(this.permLayers, name, input, mode) ?? "ask";
				const verdict = await pipeline.runPre({ name, input });
				return verdict.kind === "allow" ? "allow" : verdict.kind === "deny" ? "deny" : "ask";
			},
			confirm: (name, input) => this.confirmWrite(root, name, input),
		});
		const toolPort = withRecall(withExplore(withReadCache(withBatchReads(basePort)), model), log);
		this.runEngine = "harness";
		this.runTransport = transport;
		const abort = new AbortController();
		this.harnessAbort = abort;
		// Stable system prompt (same builder as the Cline loop). Per-run memory and dev context go in the user message.
		const system =
			buildSystemPrompt(root, mode, "", this.engineHost?.environment, undefined, assembled?.available) +
			"\n\nHarness notes: a task checklist is maintained automatically — focus on the work, not on planning tools. Batch independent reads into one read_files call; elided tool results are recovered with log_slice or recall_context.";
		const memory = resume ? "" : (await this.engineHost?.memory?.context?.(task, settings)) ?? "";
		const digests = resume ? [] : (this.runner?.runDigests ?? []);
		const digestBlock = digests.length
			? `Earlier runs in this session (oldest first):\n${digests.map((d, i) => `${i + 1}) ${d.task} — ${d.status}. ${d.summary.slice(0, 800)}${d.filesChanged.length ? ` Files: ${d.filesChanged.join(", ")}.` : ""}`).join("\n")}`
			: "";
		const context = [memory, digestBlock].filter(Boolean).join("\n\n") || undefined;
		try {
			const nudgeWrites = WRITE_MODES.has(mode) && !isConversationalTask(task);
			// Every real task gets a board, in every mode — in plan/ask mode the
			// board IS the deliverable; signals for unavailable tools are stripped.
			const plan = !isConversationalTask(task);
			const images = attachments.flatMap((a) => (a.data?.byteLength && a.mediaType.startsWith("image/") ? [{ mediaType: a.mediaType, base64: Buffer.from(a.data).toString("base64") }] : []));
			const outcome = await runHarness({ runId: this.runId, log, model, tools: toolPort, verifier, emit: (e) => this.onEvent(e), signal: abort.signal, system, nudgeWrites, writable: WRITE_MODES.has(mode), debug: vscode.workspace.getConfiguration("kronyx").get<boolean>("harness.debug", false), onLoop: (l) => (this.activeHarnessLoop = l) }, task, displayTask, { resume, context, images, plan });
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
			const report = buildHarnessReport(await log.read(), { runId: this.runId });
			upsertHarnessReport(await openStore(root), { runId: this.runId, session: this.name, report }, root);
		} catch (err) {
			log("harness", `report queue failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Session log for the harness: one JSONL file per session. */
	private harnessFile(): string {
		return path.join(this.runnerRoot ?? "", ".kronyx", "harness", `${this.name.replace(/[^\w-]+/g, "-")}.jsonl`);
	}

	private harnessCompact(): void {
		if (!this.activeHarnessLoop?.requestCompact()) this.deps.output.appendLine("[ctx] no running harness run to compact");
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

	private async confirmWrite(root: string, toolName: string, input: unknown): Promise<boolean> {
		if (autoApproveWrites() || this.approveAll || this.permittedTools.has(toolName)) return true;
		const file =
			(input as { path?: string })?.path ??
			(toolName === "run_command" ? (input as { command?: string })?.command : undefined) ??
			(input as { pattern?: string })?.pattern ??
			(toolName.startsWith("mcp_") ? JSON.stringify(input ?? {}).slice(0, 300) : undefined) ??
			"(unknown file)";
		const id = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const diff = await this.pendingDiff(root, file, toolName, input);
		const event = { type: "permission-request" as const, id, tool: toolName, path: file, diff };
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
