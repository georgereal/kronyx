import * as http from "node:http";
import * as vscode from "vscode";
import {
	clearProfileKey,
	renameProfileKey,
	profileApiKey,
	configuredModels,
	fetchModelCatalog,
	profiles,
	promptForApiKey,
	promptForProfileKey,
	readProviderSettings,
	writeProviderValue,
	type ModelOption,
} from "../config";
import { saveUserConfig, userConfig } from "../userConfig";
import { currentUser, signIn, signOut, webAppUrl } from "../auth";
import { log } from "../log";

/** Called whenever provider config is saved — extension.ts uses this to refresh the model list. */
export let onProviderSaved: (() => void) | undefined;
export function setProviderSavedListener(fn: () => void): void {
	onProviderSaved = fn;
}

async function profileKeyStatus(context: vscode.ExtensionContext): Promise<Record<string, boolean>> {
	const status: Record<string, boolean> = {};
	for (const p of profiles()) {
		if (p.name) status[p.name] = (await context.secrets.get(`kronyx.profile.apiKey.${p.name}`)) !== undefined;
	}
	return status;
}

const API_KEY_SECRET = "kronyx.provider.apiKey";

type SettingsMessage =
	| { type: "set"; key: string; value: unknown }
	| { type: "signIn" }
	| { type: "signOut" }
	| { type: "openDashboard" }
	| { type: "ready" }
	| { type: "setApiKey" }
	| { type: "clearApiKey" }
	| { type: "setProfileKey"; name: string }
	| { type: "renameProfileKey"; oldName: string; newName: string }
	| { type: "clearProfileKey"; name: string }
	| { type: "fetchProfileModels"; name: string; baseUrl: string }
	| { type: "testModels" };

let panel: vscode.WebviewPanel | undefined;
let server: http.Server | undefined;
let extCtx: vscode.ExtensionContext | undefined;

function extensionUri(): vscode.Uri {
	if (!extCtx) throw new Error("settingsPage context not initialized");
	return extCtx.extensionUri;
}

// ---------- values ----------

async function collectValues(context: vscode.ExtensionContext): Promise<Record<string, unknown>> {
	const config = vscode.workspace.getConfiguration("kronyx");
	const uc = userConfig();
	return {
		apiKeySet: (await context.secrets.get(API_KEY_SECRET)) !== undefined,
		values: {
			"provider.id": uc.providerId ?? config.get("provider.id"),
			"provider.baseUrl": uc.baseUrl ?? config.get("provider.baseUrl"),
			"provider.modelId": uc.modelId ?? config.get("provider.modelId"),
			"provider.models": JSON.stringify(config.get("provider.models", []), null, 2),
			"provider.profile": uc.activeProfile ?? config.get("provider.profile", ""),
			"provider.profiles": JSON.stringify(uc.profiles ?? config.get("provider.profiles", []), null, 2),
			"agent.maxIterations": config.get("agent.maxIterations"),
			"agent.planDir": config.get("agent.planDir", ".kronyx/plans"),
			"agent.implementPrompt": config.get("agent.implementPrompt", ""),
			"agent.defaultMode": config.get("agent.defaultMode", "code"),
			"approval.autoApproveWrites": config.get("approval.autoApproveWrites"),
			"sandbox.enabled": config.get("sandbox.enabled", false),
			"sandbox.backend": config.get("sandbox.backend", "local"),
			"sandbox.image": config.get("sandbox.image", ""),
			"sandbox.cpus": config.get("sandbox.cpus", 2),
			"sandbox.memoryMb": config.get("sandbox.memoryMb", 4096),
			"sandbox.host": config.get("sandbox.host", ""),
			"sandbox.vendor": config.get("sandbox.vendor", ""),
			"cloud.autoPr": config.get("cloud.autoPr", true),
			"sync.enabled": config.get("sync.enabled", false),
			"sync.providerKeys": config.get("sync.providerKeys", false),
			"sync.endpoint": config.get("sync.endpoint", ""),
			"cloud.defaultBase": config.get("cloud.defaultBase", "main"),
			"cloud.idleTimeoutMin": config.get("cloud.idleTimeoutMin", 15),
			"git.autoBranch": config.get("git.autoBranch", false),
			"git.branchPrefix": config.get("git.branchPrefix", "kronyx/"),
			"git.commitOnFinish": config.get("git.commitOnFinish", false),
			"checks.commands": JSON.stringify(config.get("checks.commands", []), null, 2),
			"checks.runOnFinish": config.get("checks.runOnFinish", false),
			"memory.enabled": config.get("memory.enabled", true),
			"memory.embeddingModel": config.get("memory.embeddingModel", ""),
			"memory.topK": config.get("memory.topK", 5),
			"eval.suite": config.get("eval.suite", ".kronyx/evals.json"),
			"eval.gateOnModelChange": config.get("eval.gateOnModelChange", "prompt"),
		},
		profileNames: profiles()
			.map((p) => p.name)
			.filter(Boolean),
		profileKeys: await profileKeyStatus(context),
		account: await currentUser(context).then((u) => u?.email ?? u?.name ?? null).catch(() => null),
		dashboardUrl: webAppUrl(),
	};
}

async function setKey(key: string, value: unknown): Promise<void> {
	// Provider config lives in the shared user-level file; everything else stays in VS Code settings.
	if (await writeProviderValue(key, value)) {
		onProviderSaved?.();
		return;
	}
	await vscode.workspace.getConfiguration("kronyx").update(key, value, vscode.ConfigurationTarget.Global);
}

async function testModelsResult(context: vscode.ExtensionContext): Promise<string> {
	const settings = await readProviderSettings(context.secrets);
	if (!settings) {
		log("models", "test: no provider settings (saved profiles exist but none is active)");
		return "Could not read provider settings.";
	}
	log("models", `test: fetching ${settings.baseUrl}/models (key ${settings.apiKey ? "set" : "not set"})`);
	const { models, error } = await fetchModelCatalog(settings);
	if (models.length > 0) {
		log("models", `test: ${models.length} model(s) from ${settings.baseUrl}`);
		return `✓ ${models.length} model(s) from ${settings.baseUrl}/models`;
	}
	log("models", `test: failed for ${settings.baseUrl}: ${error ?? "no models"}`);
	return `✗ ${error ?? "No models returned"} — using fallback list (${configuredModels().length} configured).`;
}

/**
 * Fetch a provider's model catalog. The API key is optional — gateways like
 * Vercel AI Gateway serve /models unauthenticated; the key is only needed for runs.
 */
async function profileModels(
	context: vscode.ExtensionContext,
	msg: { name: string; baseUrl: string },
): Promise<{ models: ModelOption[]; error?: string }> {
	if (!msg.baseUrl) return { models: [], error: "No base URL" };
	const apiKey = (await profileApiKey(context.secrets, msg.name)) || (await context.secrets.get(API_KEY_SECRET)) || "";
	log("models", `fetch "${msg.name}": GET ${msg.baseUrl}/models (key ${apiKey ? "set" : "not set"})`);
	const result = await fetchModelCatalog({ providerId: "openai-compatible", baseUrl: msg.baseUrl, modelId: "", apiKey, maxIterations: 1 });
	log("models", `fetch "${msg.name}": ${result.models.length} model(s)${result.error ? ` — ${result.error}` : ""}`);
	if (result.models.length > 0) {
		// Persist the catalog on the profile so the Models page renders from cache until refreshed.
		const list = profiles();
		const profile = list.find((p) => p.name === msg.name);
		if (profile) {
			profile.models = result.models;
			profile.modelsFetchedAt = Date.now();
			await saveUserConfig({ profiles: list });
		}
	}
	return result;
}

// ---------- separate browser window ----------

/** Opens settings in a real separate OS window via a localhost server. */
export async function openSettingsWindow(context: vscode.ExtensionContext): Promise<void> {
	extCtx = context;
	if (!server) {
		server = http.createServer((req, res) => void route(context, req, res));
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	}
	const port = (server.address() as { port: number }).port;
	await vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${port}/`));
}

async function route(context: vscode.ExtensionContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	const url = req.url ?? "/";
	const send = (body: string, type = "text/html") => {
		res.writeHead(200, { "Content-Type": type }).end(body);
	};
	const readBody = () =>
		new Promise<string>((resolve) => {
			let data = "";
			req.on("data", (c) => (data += c));
			req.on("end", () => resolve(data));
		});
	const media = vscode.Uri.joinPath(context.extensionUri, "media");
	if (url === "/") return send(html(null));
	if (url === "/settings.js") return send(settingsJs(true), "text/javascript");
	if (url === "/settings.css") {
		const css = (await vscode.workspace.fs.readFile(vscode.Uri.joinPath(media, "settings.css"))).toString();
		return send(css, "text/css");
	}
	if (url === "/api/values") return send(JSON.stringify(await collectValues(context)), "application/json");
	if (url === "/api/testModels") return send(JSON.stringify({ text: await testModelsResult(context) }), "application/json");
	if (url === "/api/profileModels" && req.method === "POST") {
		const body = JSON.parse(await readBody()) as { name: string; baseUrl: string };
		return send(JSON.stringify(await profileModels(context, body)), "application/json");
	}
	if (url === "/api/set" && req.method === "POST") {
		const body = JSON.parse(await readBody()) as { key: string; value: unknown };
		await setKey(body.key, body.value);
		return send("{}");
	}
	if (url === "/api/apikey" && req.method === "POST") {
		const body = (JSON.parse(await readBody()) as { action?: string; profile?: string; oldName?: string; newName?: string }) ?? {};
		if (body.profile) {
			if (body.action === "set") await promptForProfileKey(context.secrets, body.profile);
			else await clearProfileKey(context.secrets, body.profile);
		} else if (body.action === "rename" && body.oldName && body.newName) {
			await renameProfileKey(context.secrets, String(body.oldName), String(body.newName));
		} else if (body.action === "set") {
			await promptForApiKey(context.secrets);
		} else {
			await context.secrets.delete(API_KEY_SECRET);
		}
		return send(JSON.stringify(await collectValues(context)), "application/json");
	}
	res.writeHead(404).end();
}

// ---------- webview panel (in-editor, keeps the old message protocol) ----------

export function openSettingsPage(context: vscode.ExtensionContext): void {
	extCtx = context;
	if (panel) {
		panel.reveal();
		return;
	}
	panel = vscode.window.createWebviewPanel("kronyx.settings", "Kronyx Settings", vscode.ViewColumn.Active, {
		enableScripts: true,
	});
	panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "kronyx.svg");
	const media = vscode.Uri.joinPath(context.extensionUri, "media");
	panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
	panel.webview.html = html(panel.webview);
	panel.onDidDispose(() => {
		panel = undefined;
	});
	panel.webview.onDidReceiveMessage((message: SettingsMessage) => void handle(context, message));
}

async function handle(context: vscode.ExtensionContext, message: SettingsMessage): Promise<void> {
	switch (message.type) {
		case "ready":
			post({ type: "values", ...(await collectValues(context)) });
			break;
		case "set":
			await setKey(message.key, message.value);
			break;
		case "signIn":
			await signIn(context);
			post({ type: "values", ...(await collectValues(context)) });
			break;
		case "signOut":
			await signOut(context);
			post({ type: "values", ...(await collectValues(context)) });
			break;
		case "openDashboard": {
			const url = webAppUrl();
			if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
			break;
		}
		case "setApiKey":
			if (await promptForApiKey(context.secrets)) post({ type: "values", ...(await collectValues(context)) });
			break;
		case "clearApiKey":
			await context.secrets.delete(API_KEY_SECRET);
			post({ type: "values", ...(await collectValues(context)) });
			break;
		case "setProfileKey":
			await promptForProfileKey(context.secrets, message.name);
			post({ type: "values", ...(await collectValues(context)) });
			break;
		case "clearProfileKey":
			await clearProfileKey(context.secrets, message.name);
			post({ type: "values", ...(await collectValues(context)) });
			break;
		case "renameProfileKey":
			await renameProfileKey(context.secrets, message.oldName, message.newName);
			post({ type: "values", ...(await collectValues(context)) });
			break;
		case "testModels":
			post({ type: "modelsResult", text: await testModelsResult(context) });
			break;
		case "fetchProfileModels": {
			const { models, error } = await profileModels(context, message);
			post({ type: "profileModels", name: message.name, models, error });
			break;
		}
	}
}

function post(message: unknown): void {
	void panel?.webview.postMessage(message);
}

// ---------- shared page ----------

const NAV = [
	["account", "Account"],
	["provider", "Provider"],
	["agent", "Agent"],
	["checks", "Checks"],
	["memory", "Memory &amp; Evals"],
	["sandbox", "Sandbox / Cloud"],
	["git", "Git"],
];

const SECTIONS = `
<section id="sec-account" class="page active">
  <h2>Account</h2>
  <div id="account-status" class="note"></div>
  <div class="row">
    <button id="account-signin">Sign in</button>
    <button id="account-signout" class="secondary">Sign out</button>
    <button id="account-dashboard" class="secondary">Open dashboard</button>
  </div>
  <label class="check"><input data-key="sync.enabled" data-kind="bool" type="checkbox"> Sync usage to the dashboard</label>
  <label class="check"><input data-key="sync.providerKeys" data-kind="bool" type="checkbox"> Sync provider API keys across devices <em>(stored on our servers)</em></label>
  <label>Web app URL <input data-key="sync.endpoint" data-kind="text" placeholder="http://localhost:3000"></label>
</section>

<section id="sec-provider" class="page">
  <div class="prov-head">
    <div>
      <h2>Providers</h2>
      <p class="prov-sub">One provider is active for runs</p>
    </div>
    <button id="add-profile">+ Add provider</button>
  </div>
  <datalist id="provider-ids">
    <option value="openai-compatible"></option>
    <option value="openai"></option>
    <option value="anthropic"></option>
    <option value="openrouter"></option>
    <option value="vercel-ai-gateway"></option>
    <option value="azure"></option>
    <option value="ollama"></option>
  </datalist>
  <div id="preset-picker" hidden></div>
  <div id="profiles-list"></div>
  <button id="snapshot-profile" class="link">Save current settings as a provider</button>
  <details class="advanced"><summary>Advanced: raw profiles JSON</summary>
    <textarea data-key="provider.profiles" data-kind="json" rows="4"></textarea>
  </details>
  <details class="advanced" id="default-provider"><summary>Default provider — used only when no providers are saved</summary>
    <label>Provider id <input data-key="provider.id" data-kind="text" list="provider-ids"></label>
    <label>Base URL <input data-key="provider.baseUrl" data-kind="text" placeholder="https://ai-gateway.vercel.sh/v1"></label>
    <label>Model id <input data-key="provider.modelId" data-kind="text" placeholder="anthropic/claude-sonnet-4.6"></label>
    <div class="row">
      <span>API key <em id="apikey-status"></em></span>
      <button id="set-apikey">Set API key</button>
      <button id="clear-apikey" class="secondary">Clear</button>
      <button id="test-models" class="secondary">Test /models</button>
    </div>
    <div id="models-result" class="note"></div>
    <details class="advanced"><summary>Fallback model list (JSON)</summary>
      <textarea data-key="provider.models" data-kind="json" rows="4"></textarea>
    </details>
  </details>
</section>

<section id="sec-agent" class="page">
  <h2>Agent</h2>
  <label>Default mode
    <select data-key="agent.defaultMode" data-kind="text">
      <option value="code">Code</option>
      <option value="smart">Smart</option>
      <option value="ask">Ask</option>
      <option value="plan">Plan</option>
      <option value="bypass">Bypass Permissions</option>
    </select>
  </label>
  <label>Max iterations per run <input data-key="agent.maxIterations" data-kind="number" type="number" min="1"></label>
  <label>Plan directory <input data-key="agent.planDir" data-kind="text" placeholder=".kronyx/plans"></label>
  <label>Implement prompt <input data-key="agent.implementPrompt" data-kind="text" placeholder="Implement the plan in {path}..."></label>
  <label class="check"><input data-key="approval.autoApproveWrites" data-kind="bool" type="checkbox"> Auto-approve file writes</label>
</section>

<section id="sec-checks" class="page">
  <h2>Checks</h2>
  <label class="check"><input data-key="checks.runOnFinish" data-kind="bool" type="checkbox"> Run checks when a run completes</label>
  <label>Check commands (JSON array of shell commands)
    <textarea data-key="checks.commands" data-kind="json" rows="3" placeholder='["npm run typecheck", "npm run test"]'></textarea>
  </label>
</section>

<section id="sec-memory" class="page">
  <h2>Memory &amp; Evals</h2>
  <label class="check"><input data-key="memory.enabled" data-kind="bool" type="checkbox"> Load .kronyx rules/facts and record feedback</label>
  <label>Embedding model <input data-key="memory.embeddingModel" data-kind="text" placeholder="text-embedding-3-small"></label>
  <label>Top-K snippets <input data-key="memory.topK" data-kind="number" type="number" min="1"></label>
  <label>Eval suite path <input data-key="eval.suite" data-kind="text" placeholder=".kronyx/evals.json"></label>
  <label>Gate on model change
    <select data-key="eval.gateOnModelChange" data-kind="text">
      <option value="prompt">Prompt to run evals</option>
      <option value="always">Always run evals</option>
      <option value="off">Off</option>
    </select>
  </label>
</section>

<section id="sec-sandbox" class="page">
  <h2>Sandbox / Cloud <span class="planned">file edits stay local for now</span></h2>
  <label class="check"><input data-key="cloud.autoPr" data-kind="bool" type="checkbox"> Open/update a PR when a cloud run finishes</label>
  <label>PR base branch <input data-key="cloud.defaultBase" data-kind="text" placeholder="main"></label>
  <label>Sandbox idle timeout (min) <input data-key="cloud.idleTimeoutMin" data-kind="number" type="number" min="1"></label>
  <h3>Sandbox backend</h3>
  <label class="check"><input data-key="sandbox.enabled" data-kind="bool" type="checkbox"> Run agent commands inside a sandbox</label>
  <label>Backend
    <select data-key="sandbox.backend" data-kind="text">
      <option value="local">Local (no isolation)</option>
      <option value="docker">Docker</option>
      <option value="devcontainer">Dev container</option>
      <option value="e2b">E2B</option>
      <option value="firecracker">Firecracker microVM</option>
    </select>
  </label>
  <label>Image <input data-key="sandbox.image" data-kind="text" placeholder="kronyx/base:latest"></label>
  <label>CPUs <input data-key="sandbox.cpus" data-kind="number" type="number" min="1"></label>
  <label>Memory (MB) <input data-key="sandbox.memoryMb" data-kind="number" type="number" min="256"></label>
  <label>Remote runner host <input data-key="sandbox.host" data-kind="text" placeholder="https://runner.example.com"></label>
  <label>Vendor <input data-key="sandbox.vendor" data-kind="text" placeholder="microVM provider"></label>
</section>

<section id="sec-git" class="page">
  <h2>Git</h2>
  <label class="check"><input data-key="git.autoBranch" data-kind="bool" type="checkbox"> Create a branch before each run</label>
  <label>Branch prefix <input data-key="git.branchPrefix" data-kind="text" placeholder="kronyx/"></label>
  <label class="check"><input data-key="git.commitOnFinish" data-kind="bool" type="checkbox"> Commit changed files when a run completes</label>
</section>`;

function html(webview: vscode.Webview | null): string {
	const head = webview
		? `<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri(), "media", "settings.css"))}">`
		: `<link rel="stylesheet" href="/settings.css">`;
	const script = webview
		? `<script src="${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri(), "media", "settings.js"))}"></script>`
		: `<script>${settingsJs(true)}</script>`;
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${head}
<title>Kronyx Settings</title>
</head>
<body>
<div class="layout">
<nav class="nav">
  <div class="nav-title">Kronyx</div>
  ${NAV.map(([id, label], i) => `<button class="nav-item${i === 0 ? " active" : ""}" data-nav="${id}">${label}</button>`).join("\n  ")}
</nav>
<main class="content">
${SECTIONS}
</main>
</div>
<div class="saved-note" id="saved-note">Saved</div>
<p class="note">Provider config saves to <code>~/.kronyx/config.json</code> (shared across windows); other settings save to VS Code. API keys are stored per IDE.</p>
${script}
</body>
</html>`;
}

function settingsJs(httpMode: boolean): string {
	return `// @ts-check
(() => {
	const vscodeApi = ${httpMode ? "null" : "acquireVsCodeApi()"};
	const modelRequests = new Map();
	const post = (msg) => {
		if (vscodeApi) {
			if (msg.type === "fetchProfileModels")
				return new Promise((resolve) => {
					modelRequests.set(msg.name, resolve);
					setTimeout(() => {
						if (modelRequests.delete(msg.name)) resolve({ models: [], error: "Timed out waiting for the extension host" });
					}, 15000);
					vscodeApi.postMessage(msg);
				});
			return vscodeApi.postMessage(msg);
		}
		if (msg.type === "set") return fetch("/api/set", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msg) });
		if (msg.type === "setApiKey" || msg.type === "clearApiKey")
			return fetch("/api/apikey", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: msg.type === "setApiKey" ? "set" : "clear" }) }).then((r) => r.json()).then(applyValues);
		if (msg.type === "fetchProfileModels")
			return fetch("/api/profileModels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msg) }).then((r) => r.json());
		if (msg.type === "setProfileKey" || msg.type === "clearProfileKey")
			return fetch("/api/apikey", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: msg.type === "setProfileKey" ? "set" : "clear", profile: msg.name }) }).then((r) => r.json()).then(applyValues);
		if (msg.type === "renameProfileKey")
			return fetch("/api/apikey", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "rename", oldName: msg.oldName, newName: msg.newName }) });
		if (msg.type === "testModels") return fetch("/api/testModels").then((r) => r.json()).then((m) => { document.getElementById("models-result").textContent = m.text; });
		if (msg.type === "ready") return fetch("/api/values").then((r) => r.json()).then(applyValues);
		return Promise.resolve();
	};
	const fields = [...document.querySelectorAll("[data-key]")];
	const apiKeyStatus = document.getElementById("apikey-status");
	const modelsResult = document.getElementById("models-result");
	const savedNote = document.getElementById("saved-note");
	let savedTimer = 0;
	const showSaved = () => {
		savedNote.classList.add("visible");
		clearTimeout(savedTimer);
		savedTimer = setTimeout(() => savedNote.classList.remove("visible"), 1200);
	};
	const coerce = (el) => {
		const kind = el.dataset.kind;
		if (kind === "bool") return el.checked;
		if (kind === "number") return Number(el.value);
		if (kind === "json") { try { return JSON.parse(el.value || "[]"); } catch { return undefined; } }
		return el.value;
	};
	for (const el of fields) {
		el.addEventListener("change", () => {
			const value = coerce(el);
			if (value === undefined) return;
			post({ type: "set", key: el.dataset.key, value });
			showSaved();
		});
	}
	for (const nav of document.querySelectorAll(".nav-item")) {
		nav.addEventListener("click", () => {
			document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
			document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
			nav.classList.add("active");
			document.getElementById("sec-" + nav.dataset.nav)?.classList.add("active");
		});
	}
	document.getElementById("set-apikey").addEventListener("click", () => post({ type: "setApiKey" }));
	document.getElementById("clear-apikey").addEventListener("click", () => post({ type: "clearApiKey" }));
	document.getElementById("test-models").addEventListener("click", () => {
		modelsResult.textContent = "Fetching…";
		post({ type: "testModels" });
	});
	document.getElementById("account-signin").addEventListener("click", () => post({ type: "signIn" }));
	document.getElementById("account-signout").addEventListener("click", () => post({ type: "signOut" }));
	document.getElementById("account-dashboard").addEventListener("click", () => post({ type: "openDashboard" }));
	let lastValues = {};
	const applyValues = (msg) => {
		if (msg.values) lastValues = msg.values;
		for (const el of fields) {
			if (el.dataset.dynamic === "profiles" && msg.profileNames) {
				el.innerHTML = "";
				const none = document.createElement("option");
				none.value = ""; none.textContent = "(none)";
				el.appendChild(none);
				for (const name of msg.profileNames) {
					const opt = document.createElement("option");
					opt.value = name; opt.textContent = name;
					el.appendChild(opt);
				}
			}
			const value = msg.values[el.dataset.key];
			if (value === undefined) continue;
			if (el.dataset.kind === "bool") el.checked = Boolean(value);
			else el.value = value;
		}
		apiKeyStatus.textContent = msg.apiKeySet ? "— set" : "— not set";
		const acct = document.getElementById("account-status");
		if (acct) acct.textContent = msg.account ? "Signed in as " + msg.account : "Not signed in — usage and settings stay local only.";
		renderProfiles(msg);
	};

	let profiles = [];
	const profilesList = document.getElementById("profiles-list");
	const saveProfiles = () => post({ type: "set", key: "provider.profiles", value: profiles });

	const PRESETS = [
		{ id: "vercel-ai-gateway", label: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh/v1" },
		{ id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
		{ id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
		{ id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com" },
		{ id: "azure", label: "Azure OpenAI", baseUrl: "" },
		{ id: "ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1" },
		{ id: "openai-compatible", label: "Custom (OpenAI-compatible)", baseUrl: "" },
	];
	const PROVIDER_IDS = PRESETS.map((x) => x.id);
	const openCards = new Set();
	const openModelLists = new Set();
	const presetPicker = document.getElementById("preset-picker");
	let presetOpen = false;

	const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, textContent: text });
	const mkBtn = (label, fn) => {
		const b = Object.assign(document.createElement("button"), { textContent: label });
		b.className = "secondary tiny";
		b.addEventListener("click", fn);
		return b;
	};
	const ghost = (label, fn) => {
		const b = mkBtn(label, fn);
		b.className = "ghost tiny";
		return b;
	};

	const uniqueName = (base) => {
		let n = base;
		let i = 2;
		while (profiles.some((p) => p.name === n)) n = base + " " + i++;
		return n;
	};

	const renderPresetPicker = () => {
		presetPicker.innerHTML = "";
		presetPicker.hidden = !presetOpen;
		if (!presetOpen) return;
		const grid = el("div", "preset-grid", "");
		for (const pre of PRESETS) {
			const t = document.createElement("button");
			t.className = "preset-tile";
			t.appendChild(el("strong", "", pre.label));
			t.appendChild(el("em", "", pre.id));
			t.addEventListener("click", () => {
				const name = uniqueName(pre.label.split(" ")[0]);
				profiles.push({ name, providerId: pre.id, baseUrl: pre.baseUrl, modelId: "" });
				openCards.add(name);
				presetOpen = false;
				saveProfiles();
			});
			grid.appendChild(t);
		}
		presetPicker.appendChild(grid);
	};

	const renderProfiles = (msg) => {
		try { profiles = JSON.parse(msg.values["provider.profiles"] || "[]"); } catch { profiles = []; }
		profilesList.innerHTML = "";
		renderPresetPicker();
		if (profiles.length === 0) {
			profilesList.innerHTML = '<div class="prov-empty">No providers yet — click <strong>Add provider</strong> to connect one.</div>';
			return;
		}
		const activeName = msg.values["provider.profile"] || "";
		for (const p of profiles) profilesList.appendChild(buildCard(p, activeName, msg));
	};

	const buildCard = (p, activeName, msg) => {
		const keySet = msg.profileKeys && msg.profileKeys[p.name];
		const isActive = p.name === activeName;

		const card = document.createElement("details");
		card.className = "prov";
		card.open = openCards.size === 0 ? isActive : openCards.has(p.name);
		card.addEventListener("toggle", () => {
			if (card.open) openCards.add(p.name); else openCards.delete(p.name);
		});

		// ---- collapsed row ----
		const row = document.createElement("summary");
		row.className = "prov-row";
		const dot = el("span", "dot" + (isActive ? " on" : ""), "");
		dot.title = isActive ? "Active provider" : "Set as active provider";
		dot.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			post({ type: "set", key: "provider.profile", value: p.name });
			showSaved();
		});
		row.appendChild(dot);
		row.appendChild(el("span", "prov-name", p.name || "(unnamed)"));
		let host = p.baseUrl || "no base URL";
		try { host = new URL(p.baseUrl).host; } catch { /* keep raw */ }
		row.appendChild(el("span", "prov-meta", (p.providerId || "?") + " · " + host));
		const right = el("span", "prov-right", "");
		if (p.modelId) right.appendChild(el("code", "chip", p.modelId));
		right.appendChild(el("span", "pill" + (keySet ? "" : " dim"), keySet ? "key set" : "no key"));
		if (isActive) right.appendChild(el("span", "pill on", "Default"));
		right.appendChild(el("span", "chev", "›"));
		row.appendChild(right);
		card.appendChild(row);

		const ed = el("div", "prov-editor", "");

		// ---- status strip ----
		const strip = el("div", "prov-status", "");
		const configured = Boolean(p.baseUrl && p.modelId);
		strip.appendChild(el("span", "dot" + (configured ? " on" : ""), ""));
		strip.appendChild(el("span", "", configured ? "Configured" : "Incomplete — set a base URL and model"));
		strip.appendChild(el("em", "", keySet ? "key set" : "no key"));
		const testStat = el("em", "test-status", "");
		const test = ghost("Test connection", () => {
			test.disabled = true;
			testStat.textContent = "…";
			fetchCatalog();
		});
		strip.appendChild(test);
		strip.appendChild(testStat);
		ed.appendChild(strip);

		// ---- fields ----
		const fields = el("div", "prov-fields", "");
		const fld = (label, input, wide) => {
			const d = el("div", "fld" + (wide ? " wide" : ""), "");
			d.appendChild(el("span", "fld-label", label));
			d.appendChild(input);
			fields.appendChild(d);
		};
		const textInput = (f, ph) => {
			const input = document.createElement("input");
			input.placeholder = ph;
			input.value = p[f] || "";
			input.addEventListener("change", () => { p[f] = input.value.trim(); saveProfiles(); showSaved(); });
			return input;
		};

		const nameInput = textInput("name", "name");
		let oldName = p.name || "";
		nameInput.addEventListener("change", () => {
			const newName = nameInput.value.trim();
			if (newName && newName !== oldName && oldName) {
				post({ type: "renameProfileKey", oldName, newName });
				openCards.delete(oldName);
				openCards.add(newName);
				oldName = newName;
			}
		});
		fld("Name", nameInput);

		const provSel = document.createElement("select");
		for (const id of [...new Set([p.providerId, ...PROVIDER_IDS].filter(Boolean))]) {
			const opt = document.createElement("option");
			opt.value = id;
			opt.textContent = id;
			if (id === p.providerId) opt.selected = true;
			provSel.appendChild(opt);
		}
		provSel.addEventListener("change", () => { p.providerId = provSel.value; saveProfiles(); showSaved(); });
		fld("Provider", provSel);
		fld("Base URL", textInput("baseUrl", "https://…/v1"), true);

		const modelInput = textInput("modelId", p.models?.length ? "search " + p.models.length + " models…" : "model-id — fetch the catalog below to pick");
		const dl = document.createElement("datalist");
		dl.id = "mdl-" + (p.name || "x").replace(/[^a-z0-9]/gi, "");
		modelInput.setAttribute("list", dl.id);
		const fillModelSel = (models) => {
			dl.innerHTML = "";
			for (const m of models || []) {
				const opt = document.createElement("option");
				opt.value = m.id;
				if (m.label && m.label !== m.id) opt.label = m.label;
				dl.appendChild(opt);
			}
		};
		fillModelSel(p.models);
		fld("Model", modelInput, true);
		ed.appendChild(fields);
		ed.appendChild(dl);

		// ---- api key row ----
		const keyRow = el("div", "prov-keyrow", "");
		keyRow.appendChild(el("span", "fld-label", "API key"));
		if (keySet) keyRow.appendChild(el("code", "masked", "••••••••"));
		else keyRow.appendChild(el("em", "dim", "not set"));
		keyRow.appendChild(ghost(keySet ? "Update key" : "Set key", () => post({ type: "setProfileKey", name: p.name })));
		if (keySet) keyRow.appendChild(ghost("Remove", () => post({ type: "clearProfileKey", name: p.name })));
		ed.appendChild(keyRow);

		// ---- model catalog (renders from cache; explicit Refresh to fetch) ----
		const modelsSec = document.createElement("details");
		modelsSec.className = "prov-models";
		modelsSec.open = openModelLists.has(p.name);
		modelsSec.addEventListener("toggle", () => {
			if (modelsSec.open) openModelLists.add(p.name); else openModelLists.delete(p.name);
		});
		const cacheNote = el("em", "test-status",
			p.modelsFetchedAt ? "cached " + new Date(p.modelsFetchedAt).toLocaleString() : p.models?.length ? "cached" : "not fetched");
		const errNote = el("em", "test-status", "");
		const refreshBtn = mkBtn(p.models?.length ? "Refresh (" + p.models.length + ")" : "Fetch models", () => {
			refreshBtn.textContent = "Fetching…";
			errNote.textContent = "";
			fetchCatalog();
		});
		const mSum = document.createElement("summary");
		mSum.appendChild(el("span", "twisty", "›"));
		mSum.appendChild(el("strong", "", "Model catalog" + (p.models?.length ? " (" + p.models.length + ")" : "")));
		mSum.appendChild(cacheNote);
		mSum.appendChild(errNote);
		modelsSec.appendChild(mSum);
		const mHead = document.createElement("div");
		mHead.className = "row models-head";
		mHead.appendChild(refreshBtn);
		modelsSec.appendChild(mHead);

		const fmtDateCol = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "");
		const COLS = [
			{ id: "ctx", label: "Context", def: true, num: true, sort: (m) => m.contextWindow ?? 0, filter: "ctx", render: (m) => fmtToks(m.contextWindow) },
			{ id: "maxout", label: "Max out", def: true, num: true, sort: (m) => m.maxTokens ?? 0, render: (m) => fmtToks(m.maxTokens) },
			{ id: "modal", label: "Modalities", def: true, filter: "mod", render: (m) => fmtModalities(m.modalities) },
			{ id: "price", label: "Price / Mtok", def: true, num: true, sort: (m) => m.pricing?.input ?? Infinity, filter: "price",
				render: (m, td) => {
					td.textContent = m.pricing ? fmtPrice(m.pricing.input) + " / " + fmtPrice(m.pricing.output) : "—";
					if (m.pricing) td.title = "Input " + fmtPrice(m.pricing.input) + "/Mtok · Output " + fmtPrice(m.pricing.output) + "/Mtok";
				} },
			{ id: "tags", label: "Tags", def: true, cls: "model-tags", filter: "tag", render: (m) => (m.tags || []).join(", ") },
			{ id: "owner", label: "Owner", def: false, render: (m) => m.owner || "—" },
			{ id: "params", label: "Parameters", def: false, cls: "model-tags", render: (m) => (m.supportedParameters || []).join(", ") || "—" },
			{ id: "reasoning", label: "Reasoning", def: false, cls: "model-tags", render: (m) => (m.reasoning || []).join(", ") || "—" },
			{ id: "knowledge", label: "Knowledge", def: false, num: true, render: (m) => m.knowledgeCutoff || "—" },
			{ id: "released", label: "Released", def: false, num: true, sort: (m) => m.releasedAt ?? 0, render: (m) => fmtDateCol(m.releasedAt) || "—" },
		];
		const colState = new Set(COLS.filter((c) => c.def).map((c) => c.id));
		const visCols = () => COLS.filter((c) => colState.has(c.id));
		const filterState = { q: "", ctx: 0, price: 0, mod: "", tag: "" };
		let sortBy = null;
		let cur = [];

		const colPick = document.createElement("div");
		colPick.className = "colpick";
		const colPickBtn = ghost("Columns ▾", () => {
			colPickPanel.hidden = !colPickPanel.hidden;
		});
		const colPickPanel = el("div", "colpick-panel", "");
		colPickPanel.hidden = true;
		for (const c of COLS) {
			const lab = document.createElement("label");
			lab.className = "check colpick-item";
			const cb = document.createElement("input");
			cb.type = "checkbox";
			cb.checked = c.def;
			cb.addEventListener("change", () => {
				if (cb.checked) colState.add(c.id); else colState.delete(c.id);
				rebuildHead();
				apply();
			});
			lab.appendChild(cb);
			lab.appendChild(document.createTextNode(c.label));
			colPickPanel.appendChild(lab);
		}
		document.addEventListener("click", (e) => {
			if (!colPick.contains(e.target)) colPickPanel.hidden = true;
		});
		colPick.appendChild(colPickBtn);
		colPick.appendChild(colPickPanel);
		mHead.appendChild(colPick);

		const thead = document.createElement("thead");
		const tagSel = document.createElement("select");
		tagSel.className = "col-filter";
		tagSel.title = "Tag";
		tagSel.addEventListener("change", () => { filterState.tag = tagSel.value; apply(); });
		const numFilter = (ph, key) => {
			const i = document.createElement("input");
			i.className = "col-filter num";
			i.type = "number";
			i.min = "0";
			i.placeholder = ph;
			i.value = filterState[key] || "";
			i.addEventListener("input", () => { filterState[key] = Number(i.value) || 0; apply(); });
			return i;
		};
		const rebuildHead = () => {
			thead.innerHTML = "";
			const r1 = document.createElement("tr");
			r1.appendChild(el("th", "c-model", "Model"));
			for (const c of visCols()) {
				const th = el("th", (c.num ? "num " : "") + (c.sort ? "sortable" : ""),
					c.label + (sortBy?.id === c.id ? (sortBy.dir < 0 ? " ↓" : " ↑") : ""));
				if (c.sort) {
					th.title = "Sort";
					th.addEventListener("click", () => {
						if (sortBy?.id === c.id) {
							if (sortBy.dir < 0) sortBy = { id: c.id, dir: 1 };
							else sortBy = null;
						} else sortBy = { id: c.id, dir: -1 };
						rebuildHead();
						apply();
					});
				}
				r1.appendChild(th);
			}
			r1.appendChild(el("th", "", ""));
			thead.appendChild(r1);
			const r2 = document.createElement("tr");
			r2.className = "filter-row";
			const tdq = document.createElement("td");
			const q = document.createElement("input");
			q.className = "col-filter";
			q.placeholder = "Filter…";
			q.value = filterState.q;
			q.addEventListener("input", () => { filterState.q = q.value; apply(); });
			tdq.appendChild(q);
			r2.appendChild(tdq);
			for (const c of visCols()) {
				const td = document.createElement("td");
				if (c.filter === "ctx") td.appendChild(numFilter("≥", "ctx"));
				else if (c.filter === "price") td.appendChild(numFilter("$≤", "price"));
				else if (c.filter === "mod") {
					const s = document.createElement("select");
					s.className = "col-filter";
					for (const [v, l] of [["", "all"], ["image", "image"], ["audio", "audio"], ["file", "file"]])
						s.appendChild(Object.assign(document.createElement("option"), { value: v, textContent: l }));
					s.value = filterState.mod;
					s.addEventListener("change", () => { filterState.mod = s.value; apply(); });
					td.appendChild(s);
				} else if (c.filter === "tag") td.appendChild(tagSel);
				r2.appendChild(td);
			}
			r2.appendChild(document.createElement("td"));
			thead.appendChild(r2);
		};

		const rebuildTags = () => {
			const tags = [...new Set(cur.flatMap((m) => m.tags ?? []))].sort();
			const v = tagSel.value;
			tagSel.innerHTML = "<option value=\"\">any tag</option>";
			for (const t of tags) tagSel.appendChild(Object.assign(document.createElement("option"), { value: t, textContent: t }));
			tagSel.value = tags.includes(v) ? v : "";
		};
		function apply() {
			const q = filterState.q.toLowerCase();
			const ctx = filterState.ctx;
			const price = filterState.price;
			const mod = filterState.mod;
			const tag = filterState.tag;
			let out = cur.filter((m) => {
				if (q && !((m.label || "") + " " + m.id + " " + (m.description || "") + " " + (m.tags || []).join(" ")).toLowerCase().includes(q)) return false;
				if (ctx && (m.contextWindow ?? 0) < ctx) return false;
				if (price && (m.pricing?.input == null || m.pricing.input * 1e6 > price)) return false;
				if (mod && !(m.modalities?.input || []).includes(mod)) return false;
				if (tag && !(m.tags || []).includes(tag)) return false;
				return true;
			});
			if (sortBy) {
				const c = COLS.find((x) => x.id === sortBy.id);
				out = [...out].sort((a, b) => (c.sort(a) - c.sort(b)) * -sortBy.dir);
			}
			fill(out);
		}
		const setModels = (models) => { cur = models ?? []; rebuildTags(); apply(); };
		const table = document.createElement("table");
		table.className = "providers-table models-table";
		table.appendChild(thead);
		const tbody = document.createElement("tbody");
		table.appendChild(tbody);
		const fill = (models) => {
			tbody.innerHTML = "";
			const span = visCols().length + 2;
			if (!models || models.length === 0) {
				tbody.innerHTML = "<tr><td colspan=\"" + span + "\"><em>no models — fetch to load the catalog</em></td></tr>";
				return;
			}
			for (const m of models) {
				const tr = document.createElement("tr");
				const tdId = document.createElement("td");
				tdId.className = "c-model";
				const name = document.createElement("div");
				name.className = "model-name";
				name.textContent = m.label || m.id;
				tdId.appendChild(name);
				if (m.label && m.label !== m.id) {
					const idline = document.createElement("div");
					idline.className = "model-id";
					idline.textContent = m.id;
					tdId.appendChild(idline);
				}
				if (m.description) {
					const desc = document.createElement("div");
					desc.className = "model-desc";
					desc.textContent = m.description;
					desc.title = m.description;
					tdId.appendChild(desc);
				}
				tr.appendChild(tdId);
				for (const c of visCols()) {
					const td = document.createElement("td");
					if (c.num) td.className = "num";
					if (c.cls) td.classList.add(...c.cls.split(" "));
					c.render(m, td);
					tr.appendChild(td);
				}
				const tdUse = document.createElement("td");
				tdUse.className = "c-actions";
				if (p.modelId === m.id) tdUse.innerHTML = "<em>default</em>";
				tdUse.appendChild(mkBtn("ⓘ", () => {
					const next = tr.nextSibling;
					if (next?.classList?.contains("model-detail")) {
						next.remove();
						return;
					}
					tr.parentNode.insertBefore(detailRow(m, span), tr.nextSibling);
				}));
				tdUse.appendChild(mkBtn("Use", () => {
					p.modelId = m.id;
					saveProfiles();
					post({ type: "set", key: "provider.profile", value: p.name });
					post({ type: "set", key: "provider.modelId", value: m.id });
					showSaved();
				}));
				tr.appendChild(tdUse);
				tbody.appendChild(tr);
			}
		};
		const detailRow = (m, span) => {
			const tr = document.createElement("tr");
			tr.className = "model-detail";
			const td = document.createElement("td");
			td.colSpan = span;
			const dgrid = document.createElement("div");
			dgrid.className = "detail-grid";
			const perTok = (v) => (v == null ? "" : "$" + v + " / tok");
			const rows = [
				["ID", m.id],
				["Owner", m.owner],
				["Context", m.contextWindow?.toLocaleString() + " tok"],
				["Max output", m.maxTokens?.toLocaleString() + " tok"],
				["Modalities", fmtModalities(m.modalities)],
				["Input price", m.pricing?.input != null ? fmtPrice(m.pricing.input) + " / Mtok (" + perTok(m.pricing.input) + ")" : ""],
				["Output price", m.pricing?.output != null ? fmtPrice(m.pricing.output) + " / Mtok (" + perTok(m.pricing.output) + ")" : ""],
				["Tags", (m.tags || []).join(", ")],
				["Parameters", (m.supportedParameters || []).join(", ")],
				["Reasoning", (m.reasoning || []).join(", ")],
				["Knowledge", m.knowledgeCutoff],
				["Released", fmtDateCol(m.releasedAt)],
			];
			for (const [k, v] of rows) {
				if (!v) continue;
				const item = document.createElement("div");
				item.className = "detail-item";
				item.appendChild(el("span", "detail-key", k));
				item.appendChild(el("span", "detail-val", v));
				dgrid.appendChild(item);
			}
			td.appendChild(dgrid);
			if (m.description) {
				const d = document.createElement("p");
				d.className = "detail-desc";
				d.textContent = m.description;
				td.appendChild(d);
			}
			tr.appendChild(td);
			return tr;
		};
		rebuildHead();
		setModels(p.models);
		const applyFetch = (r) => {
			if (r?.models?.length) {
				p.models = r.models;
				p.modelsFetchedAt = Date.now();
				fillModelSel(r.models);
				setModels(r.models);
				cacheNote.textContent = "cached " + new Date().toLocaleString();
			}
			const n = r?.models?.length ?? 0;
			refreshBtn.textContent = n ? "Refresh (" + n + ")" : "Refresh failed";
			test.disabled = false;
			testStat.textContent = n ? "✓ " + n + " models" : "✗ " + (r?.error || "fetch failed");
			testStat.title = testStat.textContent;
			errNote.textContent = n ? "" : r?.error || "";
		};
		const fetchCatalog = () =>
			Promise.resolve(post({ type: "fetchProfileModels", name: p.name, baseUrl: p.baseUrl }))
				.then(applyFetch)
				.catch((e) => {
					refreshBtn.textContent = "Refresh failed";
					test.disabled = false;
					testStat.textContent = "✗ " + String(e);
				});
		const tableWrap = el("div", "prov-tablewrap", "");
		tableWrap.appendChild(table);
		modelsSec.appendChild(tableWrap);
		ed.appendChild(modelsSec);

		// ---- footer ----
		const foot = el("div", "prov-foot", "");
		const del = ghost("Delete provider", () => {
			if (keySet && !confirm("Delete provider " + p.name + " and its stored key?")) return;
			if (keySet) post({ type: "clearProfileKey", name: p.name });
			const i = profiles.indexOf(p);
			if (i >= 0) profiles.splice(i, 1);
			saveProfiles();
		});
		del.classList.add("danger");
		foot.appendChild(del);
		ed.appendChild(foot);

		card.appendChild(ed);
		return card;
	};
	const fmtToks = (n) => n == null ? "" : n >= 1e6 ? (n / 1e6) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
	const fmtPrice = (v) => {
		if (v == null) return "";
		const perM = v * 1e6;
		return "$" + (perM >= 100 ? perM.toFixed(0) : perM >= 1 ? perM.toFixed(2) : perM.toFixed(3));
	};
	const fmtModalities = (mod) => {
		if (!mod) return "";
		return [mod.input?.join("+"), mod.output?.join("+")].filter(Boolean).join("→");
	};

	document.getElementById("add-profile").addEventListener("click", () => {
		presetOpen = !presetOpen;
		renderPresetPicker();
	});
	document.getElementById("snapshot-profile").addEventListener("click", () => {
		profiles.push({
			name: "provider-" + (profiles.length + 1),
			providerId: lastValues["provider.id"] || "openai-compatible",
			baseUrl: lastValues["provider.baseUrl"] || "",
			modelId: lastValues["provider.modelId"] || "",
		});
		saveProfiles();
	});
	if (!vscodeApi) {
		window.addEventListener("message", (e) => { if (e.data?.type === "values") applyValues(e.data); });
	} else {
		window.addEventListener("message", (event) => {
			const msg = event.data;
			if (msg.type === "values") applyValues(msg);
			if (msg.type === "modelsResult") modelsResult.textContent = msg.text;
			if (msg.type === "profileModels") {
				const p = profiles.find((x) => x.name === msg.name);
				if (p && msg.models?.length) {
					p.models = msg.models;
					p.modelsFetchedAt = Date.now();
				}
				const resolve = modelRequests.get(msg.name);
				if (resolve) { modelRequests.delete(msg.name); resolve(msg); }
			}
		});
	}
	post({ type: "ready" });
})();`;
}
