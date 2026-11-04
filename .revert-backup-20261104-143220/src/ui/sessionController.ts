import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AgentRunner, type AgentMode } from "../agent/runner";
import { checksOnFinish, runChecks } from "../checks";
import { E2bSandbox, sandboxBackend, sandboxEnabled } from "../sandbox/e2b";
import { indexFile, logEpisode } from "../agent/memory";
import { autoApproveWrites, implementPrompt, promptForApiKey, providerErrorMessage, readProviderSettings, resolveProvider, writeProviderValue } from "../config";
import * as git from "../git";
import type { RunComments } from "./comments";
import type { DiffReview } from "./diffReview";
import type { RunViewProvider, WebviewMessage } from "./runViewProvider";

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
}

export interface SessionDeps {
	context: vscode.ExtensionContext;
	output: vscode.OutputChannel;
	runLock: RunLock;
	modeRef: { current: AgentMode };
	viewState: { modelId: string; models: { id: string; label?: string }[] };
	surfaces: Set<RunViewProvider>;
	diffReview: DiffReview;
	comments: RunComments;
	recordRun: (entry: RunRecord) => void;
	isSidebar?: (controller: SessionController) => boolean;
	recordUsage: (entry: { session: string; task: string; tokensIn: number; tokensOut: number; at: number }) => void;
	persistEvent: (session: string, event: Parameters<RunViewProvider["post"]>[0]) => void;
	loadEvents: (session: string) => Promise<Parameters<RunViewProvider["post"]>[0][]>;
	clearEvents: (session: string) => void;
	setStatus: (state: "idle" | "running" | "failed") => void;
	refreshModels: () => Promise<void>;
}

/** Owns one session surface (sidebar view or editor tab): runner, messages, git hooks. */
export class SessionController {
	private runner: AgentRunner | undefined;
	private runnerRoot: string | undefined;
	private approveAll = false;
	private changedPaths = new Set<string>();
	private runStartedAt = 0;
	private runTask = "";
	private lastUsage = { inputTokens: 0, outputTokens: 0 };
	private sandbox: E2bSandbox | undefined;
	private sandboxSynced = false;

	constructor(
		readonly name: string,
		private readonly surface: RunViewProvider,
		private readonly deps: SessionDeps,
	) {}

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
				for (const resolve of this.pendingPermissions.values()) resolve("deny");
				this.pendingPermissions.clear();
				break;
			case "permissionResponse": {
				const resolve = this.pendingPermissions.get(message.id);
				if (resolve) {
					this.pendingPermissions.delete(message.id);
					resolve(message.decision);
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
				await this.deps.refreshModels();
				break;
			case "setMode":
				this.deps.modeRef.current = message.mode;
				await this.deps.context.workspaceState.update("kronyx.mode", message.mode);
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
				// In the sidebar the canonical pane hosts one conversation at a time: start fresh.
				// Editor-tab sessions get a real new tab.
				if (this.name === "Side Session" || this.deps.isSidebar?.(this)) {
					await this.handle({ type: "new" });
				} else {
					await vscode.commands.executeCommand("kronyx.newSession");
				}
				break;
			case "openSettings":
				await vscode.commands.executeCommand("kronyx.openSettingsPage");
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

	private getRunner(): AgentRunner | undefined {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			void vscode.window.showErrorMessage("Kronyx: open a folder first.");
			return undefined;
		}
		const root = folder.uri.fsPath;
		if (!this.runner || this.runnerRoot !== root) {
			this.runnerRoot = root;
			this.runner = new AgentRunner({
				workspaceRoot: root,
				relativePath: (abs) => path.relative(root, abs).split(path.sep).join("/"),
				isDirty: (abs) =>
					vscode.workspace.textDocuments.some((doc) => doc.isDirty && doc.uri.fsPath === abs),
				confirmWrite: (toolName, input) => this.confirmWrite(root, toolName, input),
				currentMode: () => this.deps.modeRef.current,
				onBeforeWrite: (abs, before) => this.deps.diffReview.record(abs, before),
				execCommand: (command) => this.execCommand(command),
				emit: (event) => this.onEvent(event),
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
			this.lastUsage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
			this.deps.recordUsage({
				session: this.name,
				task: this.runTask,
				tokensIn: event.inputTokens,
				tokensOut: event.outputTokens,
				at: Date.now(),
			});
		}
		if (event.type === "run-started") {
			this.deps.comments.clear();
			this.deps.setStatus("running");
			this.runStartedAt = Date.now();
			this.runTask = event.task;
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
			});
			void this.onFinished(event.status);
		}
		if (event.type === "run-failed") {
			this.deps.setStatus("failed");
			this.deps.recordRun({
				task: this.runTask,
				session: this.name,
				status: "failed",
				durationMs: Date.now() - this.runStartedAt,
				at: Date.now(),
			});
		}
	}

	private async startRun(task: string, mode?: AgentMode): Promise<void> {
		const freshRunner = this.runner === undefined;
		const active = this.getRunner();
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

	private pendingPermissions = new Map<string, (decision: "allow" | "always" | "deny" | "alwaysTool") => void>();
	private permittedTools = new Set<string>();

	private async confirmWrite(root: string, toolName: string, input: unknown): Promise<boolean> {
		if (autoApproveWrites() || this.approveAll || this.permittedTools.has(toolName)) return true;
		const file = (input as { path?: string })?.path ?? "(unknown file)";
		const id = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const event = { type: "permission-request" as const, id, tool: toolName, path: file };
		this.surface.post(event);
		this.deps.persistEvent(this.name, event);
		void root;
		const decision = await new Promise<"allow" | "always" | "deny" | "alwaysTool">((resolve) => {
			this.pendingPermissions.set(id, resolve);
		});
		const response = { type: "permission-response" as const, id, decision };
		this.surface.post(response);
		this.deps.persistEvent(this.name, response);
		void logEpisode(root, { kind: "permission", path: file, task: this.runTask, tool: toolName, decision });
		if (decision === "always") this.approveAll = true;
		if (decision === "alwaysTool") this.permittedTools.add(toolName);
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
