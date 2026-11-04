import * as vscode from "vscode";
import { AgentRunner, type AgentMode, type ProviderSettings } from "../agent/runner";
import { providerErrorMessage, resolveProvider, writeProviderValue } from "../config";
import { kvGet, kvSet, openStore } from "../store";
import { E2bSandbox, openPr } from "../sandbox/e2b";
import { createRemoteFileTools } from "../tools/remoteFileTools";
import type { RunViewProvider, WebviewMessage } from "./runViewProvider";
import type { SessionDeps } from "./sessionController";

const REUSE_KEY = "kronyx.cloudState";
const REPO_DIR = "/home/user/repo";

interface CloudState {
	sandboxId?: string;
	repo?: string;
	branch?: string;
	prUrl?: string;
	base?: string;
}

function idleTimeoutMin(): number {
	return vscode.workspace.getConfiguration("kronyx").get<number>("cloud.idleTimeoutMin", 15);
}

export async function githubToken(secrets: vscode.SecretStorage): Promise<string | undefined> {
	const existing = process.env.GITHUB_TOKEN ?? (await secrets.get("kronyx.github.token"));
	if (existing) return existing;
	const entered = await vscode.window.showInputBox({
		title: "Kronyx: GitHub token",
		prompt: "PAT with repo scope for clone/push/PR (stored in SecretStorage; or set GITHUB_TOKEN env var).",
		password: true,
		ignoreFocusOut: true,
	});
	if (entered) await secrets.store("kronyx.github.token", entered.trim());
	return entered?.trim();
}

/** Cloud session: the agent works inside an E2B microVM and finishes by opening a PR. */
export class CloudController {
	private readonly sandbox = new E2bSandbox();
	private state: CloudState = {};
	private runner: AgentRunner | undefined;
	private running = false;

	constructor(
		readonly name: string,
		private readonly surface: RunViewProvider,
		private readonly deps: SessionDeps,
	) {
		this.state = deps.context.globalState.get<CloudState>(`${REUSE_KEY}.${name}`) ?? {};
		// Prefer the sqlite store; globalState retained as fallback/migration source.
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (root) {
			void openStore(root).then((d) => {
				const saved = kvGet<CloudState>(d, `${REUSE_KEY}.${this.name}`);
				if (saved) this.state = { ...this.state, ...saved };
			});
		}
	}

	private persistState(): void {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (root) void openStore(root).then((d) => kvSet(d, `${REUSE_KEY}.${this.name}`, this.state));
		void this.deps.context.globalState.update(`${REUSE_KEY}.${this.name}`, this.state);
	}


	async handle(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case "run":
				await this.runTask(message.task);
				break;
			case "stop":
				this.runner?.stop();
				break;
			case "new":
				this.runner?.reset();
				this.surface.post({ type: "reset" });
				break;
			case "requestState":
				await this.deps.refreshModels();
				break;
			case "setMode":
				this.deps.modeRef.current = message.mode;
				break;
			case "setModel":
				await vscode.workspace
					.getConfiguration("kronyx")
					.update("provider.modelId", message.modelId, vscode.ConfigurationTarget.Global);
				void writeProviderValue("provider.modelId", message.modelId);
				break;
			case "openSettings":
				await vscode.commands.executeCommand("kronyx.openSettingsPage");
				break;
			case "newSession":
				await vscode.commands.executeCommand("kronyx.newSession");
				break;
			case "showHistory":
				await vscode.commands.executeCommand("kronyx.showHistory");
				break;
		}
	}

	private info(text: string): void {
		this.surface.post({ type: "info", text });
	}

	private async ensureSandbox(): Promise<void> {
		const idle = idleTimeoutMin();
		if (this.state.sandboxId && (await this.sandbox.connect(this.state.sandboxId))) {
			await this.sandbox.keepalive(idle);
			this.info(`Reused sandbox ${this.state.sandboxId}${this.state.branch ? ` on ${this.state.branch}` : ""}`);
			return;
		}
		this.state = {};
		await this.sandbox.ensure(this.deps.context.secrets);
		await this.sandbox.keepalive(idle);
		this.state.sandboxId = this.sandbox.sandboxId;
		this.info(`Created sandbox ${this.state.sandboxId}`);
	}

	private async ensureRepo(): Promise<void> {
		const token = await githubToken(this.deps.context.secrets);
		if (!token) throw new Error("No GitHub token configured.");
		if (!this.state.repo) {
			const repoUrl = await pickRepo();
			if (!repoUrl) throw new Error("No repository selected.");
			const base = vscode.workspace.getConfiguration("kronyx").get<string>("cloud.defaultBase", "main");
			await this.sandbox.cloneRepo(repoUrl, token, REPO_DIR);
			const match = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(repoUrl);
			this.state.repo = match?.[1] ?? repoUrl;
			this.state.base = base;
			this.state.branch = `${vscode.workspace.getConfiguration("kronyx").get<string>("git.branchPrefix", "kronyx/")}cloud`;
			this.info(`Cloned ${this.state.repo}`);
		}
		this.persist();
	}

	private async ensureRunner(_settings: ProviderSettings): Promise<AgentRunner> {
		if (this.runner) return this.runner;
		const sbx = this.sandbox;
		const modeRef = this.deps.modeRef;
		const runner = new AgentRunner({
			workspaceRoot: REPO_DIR,
			relativePath: (abs) => abs.replace(`${REPO_DIR}/`, ""),
			isDirty: () => false,
			confirmWrite: async () => true,
			currentMode: (): AgentMode => (modeRef.current === "code" ? "smart" : modeRef.current),
			createTools: () => {
				const inner = (sbx as unknown as { sandbox?: import("e2b").Sandbox }).sandbox;
				if (!inner) throw new Error("Sandbox not ready.");
				return Promise.resolve(createRemoteFileTools(inner, REPO_DIR));
			},
			emit: (event) => {
				this.surface.post(event);
				if (event.type === "run-started") this.deps.setStatus("running");
				if (event.type === "run-finished" || event.type === "run-failed") this.deps.setStatus("idle");
			},
		});
		this.runner = runner;
		return runner;
	}

	private async runTask(task: string): Promise<void> {
		if (this.running) {
			this.surface.post({ type: "run-failed", error: "A run is already in progress in this session." });
			return;
		}
		this.running = true;
		try {
			await this.ensureSandbox();
			const token = await githubToken(this.deps.context.secrets);
			await this.ensureRepo();
			const resolved = await resolveProvider(this.deps.context.secrets);
			if (resolved.error) {
				this.surface.post({ type: "run-failed", error: providerErrorMessage(resolved.error) });
				return;
			}
			const settings = resolved.settings!;
			const runner = await this.ensureRunner(settings);
			await runner.run(task, settings);
			if (vscode.workspace.getConfiguration("kronyx").get<boolean>("cloud.autoPr", true) && token && this.state.repo && this.state.branch) {
				this.info("Pushing branch and opening PR…");
				await this.sandbox.commitAndPush(REPO_DIR, this.state.branch, `kronyx: ${task.slice(0, 60)}`);
				const pr = await openPr(this.state.repo, this.state.branch, this.state.base ?? "main", `Kronyx: ${task.slice(0, 80)}`, `Automated change by Kronyx cloud session.\n\nTask: ${task}`, token);
				this.state.prUrl = pr.url;
				this.persist();
				this.info(`${pr.created ? "Opened" : "Updated"} PR ${pr.url}`);
			}
		} catch (error) {
			this.surface.post({ type: "run-failed", error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.running = false;
		}
	}

	private persist(): void {
		this.state = { ...this.state };
		this.persistState();
	}

	async dispose(): Promise<void> {
		this.runner?.stop();
	}
}

async function pickRepo(): Promise<string | undefined> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	let origin = "";
	if (root) {
		const { execSync } = await import("node:child_process");
		origin = execSync("git config --get remote.origin.url", { cwd: root, encoding: "utf8" }).trim();
		origin = origin.replace(/git@github\.com:(.+?)(\.git)?$/, "https://github.com/$1").replace(/\.git$/, "");
	}
	const entered = await vscode.window.showInputBox({
		title: "Kronyx: cloud repository",
		prompt: "GitHub repo URL to clone into the sandbox",
		value: origin || "https://github.com/owner/repo",
		ignoreFocusOut: true,
	});
	return entered?.trim() || undefined;
}
