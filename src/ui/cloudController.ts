import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { AgentRunner, type AgentMode, type ProviderSettings } from "../agent/runner";
import { providerErrorMessage, resolveProvider, writeProviderValue } from "../config";
import { insertPr, insertSandboxEvent, kvGet, kvSet, openStore } from "../store";
import { deviceName, getDeviceId } from "../settingsSync";
import { E2bSandbox, e2bApiKey, openPr } from "../sandbox/e2b";
import { createRemoteFileTools } from "../tools/remoteFileTools";
import type { RunViewProvider, WebviewMessage } from "./runViewProvider";
import type { SessionDeps } from "./sessionController";
import { apiKey, webAppUrl } from "../auth";
import { currentUser } from "../auth";
import { log } from "../log";

const REUSE_KEY = "kronyx.cloudState";
const REPO_DIR = "/home/user/repo";
const PLAN_DIR = "/home/user/.kronyx/plans";

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

/** Silent lookup — never prompts. Prompts belong to the enablement flows. */
function githubTokenSilent(secrets: vscode.SecretStorage): Promise<string | undefined> {
	return Promise.resolve(process.env.GITHUB_TOKEN ?? secrets.get("kronyx.github.token"));
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
/** Read-only setup checklist for `Kronyx: Check cloud setup` — logs ✓/✗ to the output channel. */
export async function checkCloudSetup(context: vscode.ExtensionContext): Promise<void> {
	const checks: [string, () => Promise<boolean>][] = [
		["Signed in to Kronyx", async () => !!(await currentUser(context))],
		["E2B API key", async () => !!process.env.E2B_API_KEY || !!(await context.secrets.get("kronyx.sandbox.e2bApiKey"))],
		["GitHub credential (PAT)", async () => !!(await githubToken(context.secrets))],
		["Provider key", async () => !!(await resolveProvider(context.secrets)).settings?.apiKey],
	];
	let ok = true;
	for (const [label, fn] of checks) {
		const pass = await fn().catch(() => false);
		ok = ok && pass;
		log("cloud", `setup check ${pass ? "✓" : "✗"} ${label}`);
	}
	log("cloud", `setup check complete — ${ok ? "ready for cloud runs" : "some prerequisites missing"}`);
	void vscode.window.showInformationMessage(ok ? "Kronyx: cloud setup looks good." : "Kronyx: cloud setup incomplete — see Output → Kronyx for details.");
}

export class CloudController {
	private readonly sandbox = new E2bSandbox();
	private state: CloudState = {};
	private runner: AgentRunner | undefined;
	private running = false;
	private postRunPause: ReturnType<typeof setTimeout> | undefined;
	private lastUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	private lastUsageAt = 0;
	private runStartedAt = 0;
	private currentTask = "";
	private currentRunId = "";
	private runProvider: { providerId: string; baseUrl: string; modelId: string; profile?: string } | undefined;
	private installationId: number | undefined;
	private deviceId = "";
	private githubChoice: "pat" | "cancel" | undefined;
	private githubConfigured = false;
	private githubSlug = process.env.KRONYX_GITHUB_APP_SLUG || "kronyx";
	/** Secret strings that must never reach persisted/synced event payloads. */
	private maskSecrets: string[] = [];

	private mask<T>(event: T): T {
		if (!this.maskSecrets.length) return event;
		let raw = JSON.stringify(event);
		for (const s of this.maskSecrets) {
			if (s && s.length > 6) raw = raw.split(s).join("•••");
		}
		return JSON.parse(raw) as T;
	}

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
				void this.probeSetup();
				break;
			case "fixSetup":
				await this.fixSetup(message.key);
				break;
			case "githubPat": {
				const t = await vscode.window.showInputBox({ title: "Kronyx: GitHub token (repo scope)", password: true, ignoreFocusOut: true });
				if (t?.trim()) await this.deps.context.secrets.store("kronyx.github.token", t.trim());
				this.githubChoice = "pat";
				break;
			}
			case "githubCancel":
				this.githubChoice = "cancel";
				break;
			case "githubOpen":
				void vscode.env.openExternal(vscode.Uri.parse(message.url));
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

	/** Mirror SessionController's per-request ledger: deltas from cumulative usage events. */
	private trackUsage(event: { type: string } & Record<string, unknown>): void {
		if (event.type === "run-started") {
			this.currentTask = String(event.task ?? "");
			this.runStartedAt = Date.now();
			this.lastUsageAt = 0;
			return;
		}
		if (event.type === "usage") {
			const now = Date.now();
			const prev = this.lastUsage;
			const delta = {
				tokensIn: Math.max(0, Number(event.inputTokens ?? 0) - prev.inputTokens),
				tokensOut: Math.max(0, Number(event.outputTokens ?? 0) - prev.outputTokens),
				cacheRead: Math.max(0, Number(event.cacheReadTokens ?? 0) - prev.cacheReadTokens),
				cacheWrite: Math.max(0, Number(event.cacheWriteTokens ?? 0) - prev.cacheWriteTokens),
			};
			this.lastUsage = {
				inputTokens: Number(event.inputTokens ?? 0),
				outputTokens: Number(event.outputTokens ?? 0),
				cacheReadTokens: Number(event.cacheReadTokens ?? 0),
				cacheWriteTokens: Number(event.cacheWriteTokens ?? 0),
			};
			const p = this.runProvider;
			this.deps.recordApiCall?.({
				session: this.name,
				task: this.currentTask,
				at: now,
				status: "ok",
				provider: p?.providerId,
				baseUrl: p?.baseUrl,
				model: p?.modelId,
				profile: p?.profile,
				keyLabel: p?.profile ?? "default",
				...delta,
				durationMs: this.lastUsageAt ? now - this.lastUsageAt : now - this.runStartedAt,
			});
			this.lastUsageAt = now;
			return;
		}
		if (event.type === "run-failed" && (this.lastUsageAt || this.runStartedAt)) {
			const p = this.runProvider;
			this.deps.recordApiCall?.({
				session: this.name,
				task: this.currentTask,
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
	}

	/** Public entry used by openCloudSessionPanel when the composer passed a task. */
	async start(task: string): Promise<void> {
		await this.runTask(task);
	}

	private cloudStatus(text: string): void {
		log("cloud", `${this.name}: ${text}`);
		const ev = { type: "cloud-status" as const, text };
		this.surface.post(ev);
		this.deps.persistEvent(this.name, ev, this.currentRunId);
	}

	private setupStep(step: number, label: string, state: "run" | "ok" | "fail", detail?: string): void {
		const ev = { type: "setup" as const, step, label, state, detail };
		this.surface.post(ev);
		this.deps.persistEvent(this.name, ev, this.currentRunId);
		log("cloud", `${this.name}: setup ${label} → ${state}${detail ? ` (${detail})` : ""}`);
	}

	private checks(): { key: string; label: string; fixLabel: string; fn: () => Promise<string | undefined> }[] {
		return [
			{ key: "signin", label: "Signed in to Kronyx", fixLabel: "Sign in", fn: async () =>
				(await currentUser(this.deps.context)) ? "authenticated" : "" },
			{ key: "e2b", label: "E2B API key", fixLabel: "Paste key", fn: async () =>
				process.env.E2B_API_KEY || (await this.deps.context.secrets.get("kronyx.sandbox.e2bApiKey")) ? "key set" : "" },
			{ key: "github", label: "GitHub access", fixLabel: "Set up", fn: async () => {
				if (await githubTokenSilent(this.deps.context.secrets)) return "PAT set";
				const repos = await this.installedRepos();
				if (repos.length) return `app installed (${repos.length} repo${repos.length > 1 ? "s" : ""})`;
				return this.githubConfigured ? "app ready — repo access needed" : "";
			} },
			{ key: "provider", label: "Provider credentials", fixLabel: "Open settings", fn: async () => {
				const resolved = await resolveProvider(this.deps.context.secrets);
				return resolved.settings?.apiKey ? `${resolved.settings.providerId}/${resolved.settings.modelId}` : "";
			} },
		];
	}

	/** Read-only status probe — posts aggregate status + per-item fixes to the page. */
	async probeSetup(): Promise<void> {
		await this.deps.syncSettings?.().catch(() => {});
		const items: { key: string; label: string; ok: boolean; detail?: string; fixLabel?: string }[] = [];
		for (const c of this.checks()) {
			const detail = await c.fn().catch(() => "");
			items.push({ key: c.key, label: c.label, ok: !!detail, detail, fixLabel: c.fixLabel });
		}
		this.surface.post({ type: "setupStatus", items });
	}

	/** Launches the fix flow for a missing prerequisite. */
	private async fixSetup(key: string): Promise<void> {
		const secrets = this.deps.context.secrets;
		if (key === "signin") {
			await vscode.commands.executeCommand("kronyx.signIn");
		} else if (key === "e2b") {
			const k = await vscode.window.showInputBox({ title: "Kronyx: E2B API key", password: true, ignoreFocusOut: true });
			if (k?.trim()) await secrets.store("kronyx.sandbox.e2bApiKey", k.trim());
		} else if (key === "github") {
			const slug = this.githubSlug;
			const pick = await vscode.window.showQuickPick(
				["Enable via GitHub App (recommended)", "Paste a personal access token"],
				{ title: "Kronyx: GitHub access" },
			);
			if (pick?.startsWith("Enable")) {
				const url = `https://github.com/apps/${slug}/installations/new`;
				void vscode.env.openExternal(vscode.Uri.parse(url));
				this.info(`Install the app on your repos: ${url}`);
			} else if (pick) {
				const t = await vscode.window.showInputBox({ title: "Kronyx: GitHub token (repo scope)", password: true, ignoreFocusOut: true });
				if (t?.trim()) await secrets.store("kronyx.github.token", t.trim());
			}
		} else if (key === "provider") {
			await vscode.commands.executeCommand("kronyx.openSettingsPage");
		}
		void this.probeSetup();
	}

	/** Setup gate: check each prerequisite; auto-launch its fix once if missing. */
	private async ensureSetup(): Promise<void> {
		for (const [i, c] of this.checks().entries()) {
			this.setupStep(i + 1, c.label, "run");
			let detail = await c.fn().catch(() => "");
			if (!detail) {
				await this.fixSetup(c.key); // auto-fix: prompt/enable/settings, then re-check once
				detail = await c.fn().catch(() => "");
			}
			this.setupStep(i + 1, c.label, detail ? "ok" : "fail", detail);
			if (!detail) throw new Error(`Setup failed: ${c.label}`);
		}
	}

	/** Run detected tests in the sandbox before the PR step; emits a checks event. */
	private async verify(): Promise<string> {
		const probe = await this.sandbox
			.runIn(REPO_DIR, "ls package.json go.mod requirements.txt pyproject.toml 2>/dev/null || true")
			.catch(() => ({ stdout: "", exitCode: 1, stderr: "" }));
		const cmd = probe.stdout.includes("package.json")
			? "npm test --if-present"
			: probe.stdout.includes("pyproject.toml") || probe.stdout.includes("requirements.txt")
				? "python -m pytest -q || true"
				: probe.stdout.includes("go.mod")
					? "go test ./..."
					: "";
		if (!cmd) return "";
		this.cloudStatus(`Verifying: ${cmd}`);
		const r = await this.sandbox.runIn(REPO_DIR, cmd, 300_000).catch(() => undefined);
		const status = !r || r.exitCode !== 0 ? "failed" : "passed";
		this.surface.post({
			type: "check",
			command: cmd,
			ok: status === "passed",
			durationMs: 0,
			output: (r?.stdout || r?.stderr || "").slice(0, 1000),
		});
		return `${cmd} → ${status}`;
	}

	private info(text: string): void {
		this.surface.post({ type: "info", text });
	}

	/** Repos covered by Kronyx GitHub App installations (empty when unsigned-in/uninstalled). */
	private async installedRepos(): Promise<{ repo: string; defaultBranch: string; installationId: number }[]> {
		const key = await apiKey(this.deps.context);
		const base = webAppUrl();
		if (!key || !base) return [];
		try {
			const res = await fetch(`${base}/api/github/repos`, {
				headers: { Authorization: `Bearer ${key}` },
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) return [];
			const body = (await res.json()) as { repos?: { repo: string; defaultBranch: string; installationId: number }[]; configured?: boolean; appSlug?: string };
			this.githubConfigured = body.configured === true;
			if (body.appSlug) this.githubSlug = body.appSlug;
			return body.repos ?? [];
		} catch {
			return [];
		}
	}

	/** Show the GitHub-enablement card; poll until the repo appears in an installation,
	 *  the user picks PAT, or cancels. Resolves 'install'|'pat'|'cancel'. */
	private async awaitForInstall(repo: string): Promise<string> {
		const slug = this.githubSlug;
		this.surface.post({ type: "github-enable", repo, url: `https://github.com/apps/${slug}/installations/new` });
		this.cloudStatus(`Waiting for GitHub access on ${repo}…`);
		this.githubChoice = undefined;
		for (let i = 0; i < 24 && this.running; i++) {
			if (this.githubChoice) return this.githubChoice;
			const installed = await this.installedRepos();
			const hit = installed.find((r) => r.repo === repo);
			if (hit) {
				this.installationId = hit.installationId;
				this.setupStep(99, "GitHub App enabled", "ok", repo);
				return "install";
			}
			await new Promise((r) => setTimeout(r, 5000));
		}
		return this.githubChoice ?? "pat";
	}

	/** Mint a short-lived installation token for the picked repo, via the web API. */
	private async repoToken(): Promise<string | undefined> {
		if (!this.installationId) return undefined;
		const key = await apiKey(this.deps.context);
		const base = webAppUrl();
		if (!key || !base) return undefined;
		try {
			const res = await fetch(`${base}/api/github/token`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
				body: JSON.stringify({ installationId: this.installationId }),
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) return undefined;
			return ((await res.json()) as { token?: string }).token;
		} catch {
			return undefined;
		}
	}

	private async ensureSandbox(): Promise<void> {
		if (!this.deviceId) this.deviceId = await getDeviceId(this.deps.context).catch(() => "");
		this.sandbox.onLifecycle = (event, sandboxId) => {
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (root) {
				void openStore(root).then((d) =>
					insertSandboxEvent(d, { sandboxId, event, device: deviceName(), deviceId: this.deviceId, repo: this.state.repo, runId: this.currentRunId }, root),
				);
			}
		};
		this.sandbox.setPauseHook(() => {
			this.persist();
			this.cloudStatus("Sandbox paused — resumes on next run");
		});
		const idle = idleTimeoutMin();
		if (this.state.sandboxId && (await this.sandbox.connect(this.state.sandboxId, await e2bApiKey(this.deps.context.secrets)))) {
			await this.sandbox.keepalive(idle);
			this.cloudStatus(`Reused warm sandbox ${this.state.sandboxId}`);
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
		const token = await githubTokenSilent(this.deps.context.secrets);
		if (!this.state.repo) {
			// Prefer repos covered by a Kronyx GitHub App installation (scoped tokens);
			// fall back to a raw URL + personal token.
			const installed = await this.installedRepos();
			const pick = await pickRepo(installed.map((r) => r.repo));
			if (!pick) throw new Error("No repository selected.");
			const hit = installed.find((r) => pick.includes(r.repo));
			if (hit) {
				this.installationId = hit.installationId;
				this.state.repo = hit.repo;
				this.state.base = hit.defaultBranch;
			} else {
				const match = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(pick);
				this.state.repo = match?.[1] ?? pick;
				this.state.base = vscode.workspace.getConfiguration("kronyx").get<string>("cloud.defaultBase", "main");
				// Coverage check — if the repo isn't in an installation, drive the enablement loop.
				if (this.state.repo && !installed.some((r) => r.repo === this.state.repo)) {
					const mode = await this.awaitForInstall(this.state.repo);
					if (mode === "cancel") throw new Error("GitHub access not enabled.");
				}
			}
			const cloneToken = (await this.repoToken()) ?? token;
			if (!cloneToken) throw new Error("No GitHub credential — enable the app or set a PAT.");
			const repoUrl = `https://github.com/${this.state.repo}`;
			await this.sandbox.cloneRepo(repoUrl, cloneToken, REPO_DIR);
			if (cloneToken !== token) this.maskSecrets.push(cloneToken);
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
			planDir: PLAN_DIR,
			environment: "an E2B cloud sandbox",
			log: (tag, message) => log(tag, message),
			createTools: () => {
				const inner = sbx.inner;
				if (!inner) throw new Error("Sandbox not ready.");
				return Promise.resolve(createRemoteFileTools(inner, REPO_DIR, { planDir: PLAN_DIR }));
			},
			emit: (event) => {
				this.surface.post(event);
				this.trackUsage(event);
				this.deps.persistEvent(this.name, this.mask(event), this.currentRunId);
				if (event.type === "run-started") this.deps.setStatus("running");
				if (event.type === "run-finished" || event.type === "run-failed") this.deps.setStatus("idle");
			},
		});
		this.runner = runner;
		return runner;
	}

	private async runTask(task: string): Promise<void> {
		this.currentRunId = randomUUID();
		this.currentTask = task;
		if (this.running) {
			this.surface.post({ type: "run-failed", error: "A run is already in progress in this session." });
			return;
		}
		this.running = true;
		clearTimeout(this.postRunPause);
		try {
			await this.deps.syncSettings?.();
			await this.ensureSetup();
			this.cloudStatus("Provisioning sandbox…");
			await this.ensureSandbox();
			const token = (await this.repoToken()) ?? (await githubTokenSilent(this.deps.context.secrets));
			if (token && !this.maskSecrets.includes(token)) this.maskSecrets.push(token);
			this.cloudStatus("Cloning repository…");
			await this.ensureRepo();
			this.surface.setState({ cloudRepo: this.state.repo, cloudBranch: this.state.branch });
			this.cloudStatus("Running agent…");
			const resolved = await resolveProvider(this.deps.context.secrets);
			if (resolved.error) {
				this.surface.post({ type: "run-failed", error: providerErrorMessage(resolved.error) });
				return;
			}
			const settings = resolved.settings!;
			this.runProvider = {
				providerId: settings.providerId,
				baseUrl: settings.baseUrl,
				modelId: settings.modelId,
				profile: settings.profile,
			};
			if (settings.apiKey) this.maskSecrets.push(settings.apiKey);
			this.cloudStatus("Running agent…");
			this.info("Note: your provider API key runs inside the E2B sandbox.");
			const runner = await this.ensureRunner(settings);
			await runner.run(task, settings);
			this.deps.recordRun({
				task,
				session: this.name,
				status: "completed",
				durationMs: Date.now() - this.runStartedAt,
				at: Date.now(),
				runId: this.currentRunId,
			});
			const checkResult = await this.verify();
			if (vscode.workspace.getConfiguration("kronyx").get<boolean>("cloud.autoPr", true) && token && this.state.repo && this.state.branch) {
				this.cloudStatus("Pushing branch and opening PR…");
				this.info("Pushing branch and opening PR…");
				await this.sandbox.commitAndPush(REPO_DIR, this.state.branch, `kronyx: ${task.slice(0, 60)}`);
				const pr = await openPr(this.state.repo, this.state.branch, this.state.base ?? "main", `Kronyx: ${task.slice(0, 80)}`, `Automated change by Kronyx cloud session.\n\nTask: ${task}${checkResult ? `\n\nVerification: ${checkResult}` : ""}`, token);
				this.state.prUrl = pr.url;
				this.persist();
				this.surface.setState({ cloudPr: pr.url });
				this.cloudStatus(`PR ${pr.created ? "created" : "updated"}: ${pr.url}`);
				const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (root) {
					const d = await openStore(root);
					insertPr(d, { runId: this.currentRunId, session: this.name, task, repo: this.state.repo, branch: this.state.branch, url: pr.url, title: `Kronyx: ${task.slice(0, 80)}` }, root);
				}
				this.info(`${pr.created ? "Opened" : "Updated"} PR ${pr.url}`);
			}
		} catch (error) {
			this.surface.post({ type: "run-failed", error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.running = false;
			// Grace window before pausing so follow-up tasks resume the warm sandbox.
			const pauseAfter = vscode.workspace.getConfiguration("kronyx").get<number>("cloud.pauseAfterRunMin", 12);
			clearTimeout(this.postRunPause);
			this.postRunPause = setTimeout(() => {
				void this.sandbox.pause().catch(() => {});
			}, pauseAfter * 60_000);
		}
	}

	private persist(): void {
		this.state = { ...this.state };
		this.persistState();
	}

	async dispose(): Promise<void> {
		clearTimeout(this.postRunPause);
		// Window closed — pause the sandbox so the next session can resume it
		// without paying for an idle-running VM.
		void this.sandbox.pause().catch(() => {});
		this.runner?.stop();
	}
}

async function pickRepo(installed: string[] = []): Promise<string | undefined> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	let origin = "";
	if (root) {
		const { execSync } = await import("node:child_process");
		origin = execSync("git config --get remote.origin.url", { cwd: root, encoding: "utf8" }).trim();
		origin = origin.replace(/git@github\.com:(.+?)(\.git)?$/, "https://github.com/$1").replace(/\.git$/, "");
	}
	if (installed.length || origin) {
		const items = [
			...(origin ? [origin] : []),
			...installed.filter((r) => r !== origin),
			{ label: "$(pencil) Enter URL manually…", manual: true as const },
		];
		const picked = await vscode.window.showQuickPick(
			items.map((i) => (typeof i === "string" ? { label: i, manual: false } : i)),
			{ title: "Kronyx: cloud repository" },
		);
		if (!picked) return undefined;
		if (!picked.manual) return picked.label;
	}
	const entered = await vscode.window.showInputBox({
		title: "Kronyx: cloud repository",
		prompt: "GitHub repo URL to clone into the sandbox",
		value: origin || "https://github.com/owner/repo",
		ignoreFocusOut: true,
	});
	return entered?.trim() || undefined;
}
