import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AgentRunner, type AgentMode, type RunDigest } from "../agent/runner";
import { evaluate, parsePermissionsText, ruleFor, type PermissionLayers, type PermissionRules } from "../agent/permissions";
import { readGlobalModePermissions, readGlobalPermissions } from "../permStore";
import type { PriorTranscript } from "../agent/recall";
import type { AgentMessage } from "@cline/shared";
import { checksOnFinish, runChecks } from "../checks";
import { E2bSandbox, sandboxBackend, sandboxEnabled } from "../sandbox/e2b";
import { appendFact, indexFile, loadMemoryContext, logEpisode } from "../agent/memory";
import { createFileTools } from "../tools/fileTools";
import { insertMemoryEvent, openStore } from "../store";
import { createIdeTools } from "./ideTools";
import { autoApproveWrites, estimateCostUsd, implementPrompt, modelPricing, planDir, promptForApiKey, providerErrorMessage, readProviderSettings, resolveProvider, writeProviderValue } from "../config";
import { log } from "../log";
import type { ApiCallRow } from "../store";
import * as git from "../git";
import type { RunComments } from "./comments";
import type { DiffReview } from "./diffReview";
import type { ModelOption, RunViewProvider, WebviewMessage } from "./runViewProvider";

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

export interface SessionDeps {
	context: vscode.ExtensionContext;
	output: vscode.OutputChannel;
	runLock: RunLock;
	modeRef: { current: AgentMode };
	viewState: { modelId: string; models: ModelOption[]; signedIn?: boolean; userEmail?: string };
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
	private runnerRoot: string | undefined;
	private approveAll = false;
	private changedPaths = new Set<string>();
	private diagBaseline: { errors: number; warnings: number } | undefined;
	private runStartedAt = 0;
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

	constructor(
		public name: string,
		private readonly surface: RunViewProvider,
		private readonly deps: SessionDeps,
	) {}

	private static sessionCounter = 0;

	/** Start a fresh named session in the same window — like Copilot's "new chat". */
	async startNewSession(): Promise<void> {
		this.runner?.reset();
		this.approveAll = false;
		this.permittedTools.clear();
		SessionController.sessionCounter += 1;
		this.name = `${this.name.replace(/ \d+$/, "")} ${SessionController.sessionCounter}`;
		this.deps.clearEvents(this.name);
		this.surface.post({ type: "reset" });
		this.deps.setStatus("idle");
	}

	get isRunning(): boolean {
		return this.runner?.isRunning ?? false;
	}

	async handle(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case "run":
				await this.startRun(message.task, message.mode);
				break;
			case "stop":
				this.runner?.stop();
				for (const p of this.pendingPermissions.values()) p.resolve("deny");
				this.pendingPermissions.clear();
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
				this.runner?.reset();
				this.approveAll = false;
				this.permittedTools.clear();
				this.deps.clearEvents(this.name);
				this.surface.post({ type: "reset" });
				this.deps.setStatus("idle");
				break;
			case "setApiKey":
				await promptForApiKey(this.deps.context.secrets);
				await this.deps.refreshModels();
				break;
			case "requestState":
				if (!this.replayed) {
					this.replayed = true;
					const evs = await this.deps.loadEvents(this.name);
					evs.forEach((e) => this.surface.post(e));
					this.deps.output.appendLine(`[store] replayed "${this.name}" with ${evs.length} event(s)`);
				}
				await this.deps.refreshModels();
				break;
			case "setMode":
				this.deps.modeRef.current = message.mode;
				await this.deps.context.globalState.update("kronyx.mode", message.mode);
				this.surface.setState({ mode: message.mode });
				break;
			case "setModel":
				await vscode.workspace
					.getConfiguration("kronyx")
					.update("provider.modelId", message.modelId, vscode.ConfigurationTarget.Global);
				void writeProviderValue("provider.modelId", message.modelId);
				this.surface.setState({ modelId: message.modelId });
				break;
			case "attach":
				await this.attach(message.kind);
				break;
			case "openFile":
				if (this.runnerRoot) {
					const abs = this.toAbs(message.path);
					if (abs) await vscode.window.showTextDocument(vscode.Uri.file(abs));
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
				if (this.name === "Side Session" || this.deps.isSidebar?.(this)) {
					await this.startNewSession();
				} else {
					await vscode.commands.executeCommand("kronyx.newSession");
				}
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

	private async getRunner(): Promise<AgentRunner | undefined> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			void vscode.window.showErrorMessage("Kronyx: open a folder first.");
			return undefined;
		}
		const root = folder.uri.fsPath;
		if (!this.runner || this.runnerRoot !== root) {
			this.runnerRoot = root;
			this.permLayers = await this.loadPermissionLayers(root);
			this.runner = new AgentRunner({
				workspaceRoot: root,
				relativePath: (abs) => path.relative(root, abs).split(path.sep).join("/"),
				isDirty: (abs) =>
					vscode.workspace.textDocuments.some((doc) => doc.isDirty && doc.uri.fsPath === abs),
				confirmWrite: (toolName, input) => this.confirmWrite(root, toolName, input),
				checkPermission: async (toolName, input) => evaluate(this.permLayers, toolName, input, this.deps.modeRef.current),
				currentMode: () => this.deps.modeRef.current,
				planDir: planDir(),
				createTools: async () => [
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
				],
				memoryContext: async (task, s) => [devContext(root), await loadMemoryContext(root, task, s)].filter(Boolean).join("\n\n"),
				onMemoryFact: (fact) => appendFact(root, fact),
				log: (tag, message) => log(tag, message),
				onBeforeWrite: (abs, before) => this.deps.diffReview.record(abs, before),
				execCommand: (command) => this.execCommand(command),
				priorTranscripts: () => this.transcripts,
				saveTranscript: (messages) => {
					this.transcripts = [...this.transcripts, { label: `run ${this.transcripts.length + 1}`, messages }].slice(-5);
					this.deps.saveTranscript?.(this.name, messages);
				},
				emit: (event) => this.onEvent(event),
			});
			void this.deps.loadDigest?.(this.name).then((d) => this.runner?.setRunDigests(d));
			void this.deps.loadTranscripts?.(this.name).then((t) => {
				this.transcripts = t;
			});
		}
		return this.runner;
	}

	private onEvent(event: Parameters<RunViewProvider["post"]>[0]): void {
		this.surface.post(event);
		// Delta events are transient streaming frames — final messages persist separately.
		if (event.type !== "assistant-delta" && event.type !== "reasoning-delta" && event.type !== "usage") {
			this.deps.persistEvent(this.name, event);
		}
		this.deps.output.appendLine(`[${this.name}] [${event.type}] ${summarize(event)}`);
		if (event.type === "file-changed" && this.runnerRoot) {
			const abs = path.resolve(this.runnerRoot, event.path);
			this.changedPaths.add(abs);
			this.deps.comments.noteChangedFile(abs, event.kind, this.runTask);
			void readProviderSettings(this.deps.context.secrets).then((s) => {
				if (s) void indexFile(this.runnerRoot!, event.path, s.baseUrl, s.apiKey);
			});
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
		}
		if (event.type === "run-finished") {
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
					tokensIn: 0,
					tokensOut: 0,
					durationMs: Date.now() - (this.lastUsageAt || this.runStartedAt),
				});
			}
			this.deps.setStatus("failed");
			this.deps.recordRun({
				task: this.runTask,
				session: this.name,
				status: "failed",
				durationMs: Date.now() - this.runStartedAt,
				at: Date.now(),
			});
			this.recordDigest("failed", event.error);
		}
	}

	private recordDigest(status: string, summary: string): void {
		const files = [...this.changedPaths].map((abs) =>
			this.runnerRoot ? path.relative(this.runnerRoot, abs).split(path.sep).join("/") : abs,
		);
		this.runner?.addRunDigest({ task: this.runTask, status, summary, filesChanged: files, at: Date.now() });
		this.deps.saveDigest?.(this.name, this.runner?.runDigests ?? []);
	}

	private async startRun(task: string, mode?: AgentMode): Promise<void> {
		const freshRunner = this.runner === undefined;
		const active = await this.getRunner();
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
			const resolved = await resolveProvider(this.deps.context.secrets);
			if (resolved.error) {
				this.surface.post({ type: "run-failed", error: providerErrorMessage(resolved.error) });
				return;
			}
			const settings = resolved.settings!;
			if (!settings) return;
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
			await this.beforeRun(task);
			const restored = freshRunner ? summarizePrior(await this.deps.loadEvents(this.name)) : "";
			const expanded = await expandMentions(
				restored ? `${task}\n\nContext from the previous session in this tab:\n${restored}` : task,
				this.runnerRoot ?? "",
			);
			await active.run(expanded, settings);
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
		if (!this.runnerRoot) return undefined;
		const abs = path.resolve(this.runnerRoot, rel);
		return abs.startsWith(this.runnerRoot + path.sep) || abs === this.runnerRoot ? abs : undefined;
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

	private async confirmWrite(root: string, toolName: string, input: unknown): Promise<boolean> {
		if (autoApproveWrites() || this.approveAll || this.permittedTools.has(toolName)) return true;
		const file =
			(input as { path?: string })?.path ??
			(toolName === "run_command" ? (input as { command?: string })?.command : undefined) ??
			(input as { pattern?: string })?.pattern ??
			"(unknown file)";
		const id = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const diff = await this.pendingDiff(root, file, toolName, input);
		const event = { type: "permission-request" as const, id, tool: toolName, path: file, diff };
		this.surface.post(event);
		this.deps.persistEvent(this.name, event);
		void root;
		const decision = await new Promise<"allow" | "always" | "deny" | "alwaysTool" | "alwaysRule">((resolve) => {
			this.pendingPermissions.set(id, { toolName, input, resolve });
		});
		const response = { type: "permission-response" as const, id, decision };
		this.surface.post(response);
		this.deps.persistEvent(this.name, response);
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
			if (picked) this.surface.insertMention(picked.label);
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
		this.surface.insertMention(kind === "directory" ? `${mention}/` : mention);
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
	const parts = [
		lastTask?.task ? `Task: ${lastTask.task.slice(0, 300)}` : "",
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
