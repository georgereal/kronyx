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
	["provider", "Provider"],
	["models", "Models"],
	["agent", "Agent"],
	["checks", "Checks"],
	["memory", "Memory &amp; Evals"],
	["sandbox", "Sandbox / Cloud"],
	["git", "Git"],
];

const SECTIONS = `
<section id="sec-provider" class="page active">
  <h2>Provider</h2>
  <h3>Saved providers <span class="planned">one is active for runs</span></h3>
  <datalist id="provider-ids">
    <option value="openai-compatible"></option>
    <option value="openai"></option>
    <option value="anthropic"></option>
    <option value="openrouter"></option>
    <option value="vercel-ai-gateway"></option>
    <option value="azure"></option>
    <option value="ollama"></option>
  </datalist>
  <div id="profiles-list"></div>
  <div class="row">
    <button id="add-profile" class="secondary">+ Add provider</button>
    <button id="snapshot-profile" class="secondary">Save current as provider</button>
  </div>
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

<section id="sec-models" class="page">
  <h2>Models</h2>
  <p class="note">Fetch each provider's catalog and pick its default model. The "apply" radio sets the active provider+model for runs.</p>
  <div id="models-list"></div>
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
		pendingModelFills.clear();
		renderProfiles(msg);
		renderModelsPage(msg);
	};

	let profiles = [];
	const pendingModelFills = new Map();
	const onModels = (name, fn) => {
		if (!pendingModelFills.has(name)) pendingModelFills.set(name, new Set());
		pendingModelFills.get(name).add(fn);
	};
	const profilesList = document.getElementById("profiles-list");
	const saveProfiles = () => post({ type: "set", key: "provider.profiles", value: profiles });

	const renderProfiles = (msg) => {
		try { profiles = JSON.parse(msg.values["provider.profiles"] || "[]"); } catch { profiles = []; }
		profilesList.innerHTML = "";
		if (profiles.length === 0) {
			profilesList.innerHTML = '<p class="note">No saved providers — add one for each config.</p>';
			return;
		}
		const table = document.createElement("table");
		table.className = "providers-table";
		table.innerHTML = "<thead><tr><th>Name</th><th>Provider</th><th>Base URL</th><th>Model</th><th>Key</th><th>Active</th><th></th></tr></thead>";
		const tbody = document.createElement("tbody");
		const activeName = msg.values["provider.profile"] || "";
		profiles.forEach((p, i) => {
			const row = document.createElement("tr");
			const cell = () => { const td = document.createElement("td"); row.appendChild(td); return td; };
			const mkInput = (field, ph, list) => {
				const input = document.createElement("input");
				input.placeholder = ph;
				input.value = p[field] || "";
				if (list) input.setAttribute("list", list);
				input.addEventListener("change", () => { p[field] = input.value.trim(); saveProfiles(); showSaved(); });
				return input;
			};
			const nameInput = mkInput("name", "name");
			let oldName = p.name || "";
			nameInput.addEventListener("change", () => {
				const newName = nameInput.value.trim();
				if (newName && newName !== oldName && oldName) {
					Promise.resolve(post({ type: "renameProfileKey", oldName, newName }));
					oldName = newName;
				}
			});
			cell().appendChild(nameInput);
			cell().appendChild(mkInput("providerId", "provider", "provider-ids"));
			cell().appendChild(mkInput("baseUrl", "https://…/v1"));
			const mcell = cell();
			const select = document.createElement("select");
			const fill = (models) => {
				select.innerHTML = "";
				if (!models || models.length === 0) return;
				for (const m of models) {
					const opt = document.createElement("option");
					opt.value = m.id; opt.textContent = m.label || m.id;
					if (m.id === p.modelId) opt.selected = true;
					select.appendChild(opt);
				}
				if (!models.find((m) => m.id === p.modelId)) {
					const opt = document.createElement("option");
					opt.value = p.modelId || ""; opt.textContent = p.modelId || "(set model)";
					opt.selected = true;
					select.appendChild(opt);
				}
			};
			onModels(p.name, (msg) => fill(msg.models ?? msg));
			select.addEventListener("change", () => { p.modelId = select.value; saveProfiles(); showSaved(); });
			const fetchBtn = Object.assign(document.createElement("button"), { textContent: "⌄ fetch" });
			fetchBtn.className = "secondary tiny";
			fetchBtn.title = "Fetch models from this provider (no key needed for open catalogs)";
			fetchBtn.addEventListener("click", () => {
				fetchBtn.textContent = "…";
				Promise.resolve(post({ type: "fetchProfileModels", name: p.name, baseUrl: p.baseUrl }))
					.then((m) => {
						const models = m?.models ?? [];
						fill(models);
						fetchBtn.textContent = models.length ? String(models.length) : "✗";
						fetchBtn.title = models.length ? models.length + " models" : (m?.error || "Fetch failed");
					})
					.catch(() => { fetchBtn.textContent = "✗"; });
			});
			const modelInput = mkInput("modelId", "model-id");
			mcell.appendChild(modelInput);
			mcell.appendChild(select);
			mcell.appendChild(fetchBtn);
			const kcell = cell();
			const keySet = msg.profileKeys && msg.profileKeys[p.name];
			const badge = document.createElement("em");
			badge.textContent = keySet ? "key set" : "no key";
			badge.title = keySet ? "Profile-specific key stored" : "Set an API key for this provider";
			kcell.appendChild(badge);
			const setKey = Object.assign(document.createElement("button"), { textContent: "key" });
			setKey.className = "secondary tiny";
			setKey.addEventListener("click", () => post({ type: "setProfileKey", name: p.name }));
			const clrKey = Object.assign(document.createElement("button"), { textContent: "✗" });
			clrKey.className = "secondary tiny";
			clrKey.addEventListener("click", () => post({ type: "clearProfileKey", name: p.name }));
			kcell.appendChild(setKey);
			kcell.appendChild(clrKey);
			const acell = cell();
			const radio = document.createElement("input");
			radio.type = "radio";
			radio.name = "active-provider";
			radio.checked = p.name === activeName;
			radio.addEventListener("change", () => {
				post({ type: "set", key: "provider.profile", value: p.name });
				showSaved();
			});
			acell.appendChild(radio);
			const dcell = cell();
			const test = Object.assign(document.createElement("button"), { textContent: "test" });
			test.className = "secondary tiny";
			test.title = "Test the provider's /models endpoint (works without a key on open catalogs)";
			const stat = document.createElement("em");
			stat.className = "test-status";
			test.addEventListener("click", () => {
				test.textContent = "…";
				stat.textContent = "";
				Promise.resolve(post({ type: "fetchProfileModels", name: p.name, baseUrl: p.baseUrl }))
					.then((m) => {
						const n = m?.models?.length ?? 0;
						test.textContent = n ? "✓ " + n : "✗";
						stat.textContent = n ? "" : " " + (m?.error || "fetch failed");
						stat.title = stat.textContent;
					})
					.catch((e) => { test.textContent = "✗"; stat.textContent = " " + String(e); });
			});
			dcell.appendChild(test);
			dcell.appendChild(stat);
			const del = Object.assign(document.createElement("button"), { textContent: "✗" });
			del.className = "secondary tiny";
			del.addEventListener("click", () => {
				if (keySet && !confirm("Delete provider " + p.name + " and its stored key?")) return;
				if (keySet) Promise.resolve(post({ type: "clearProfileKey", name: p.name }));
				profiles.splice(i, 1);
				saveProfiles();
			});
			dcell.appendChild(del);
			tbody.appendChild(row);
		});
		table.appendChild(tbody);
		profilesList.appendChild(table);
	};

	const modelsList = document.getElementById("models-list");
	const fmtToks = (n) => n == null ? "" : n >= 1e6 ? (n / 1e6) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
	const fmtPrice = (v) => {
		if (v == null) return "";
		const perM = v * 1e6;
		return "$" + (perM >= 100 ? perM.toFixed(0) : perM >= 1 ? perM.toFixed(2) : perM.toFixed(3));
	};
	const fmtModalities = (mod) => {
		if (!mod) return "";
		const io = [mod.input?.join("+"), mod.output?.join("+")].filter(Boolean).join("→");
		return io;
	};
	const renderModelsPage = (msg) => {
		if (!modelsList) return;
		modelsList.innerHTML = "";
		if (profiles.length === 0) {
			modelsList.innerHTML = '<p class="note">No providers configured — add them under Provider first.</p>';
			return;
		}
		const activeName = msg.values["provider.profile"] || "";
		profiles.forEach((p) => {
			const block = document.createElement("div");
			block.className = "profile-card";
			const head = document.createElement("div");
			head.className = "row";
			head.appendChild(Object.assign(document.createElement("strong"), { textContent: p.name }));
			head.appendChild(Object.assign(document.createElement("em"), { textContent: p.baseUrl || "no base URL" }));
			if (p.modelId) head.appendChild(Object.assign(document.createElement("code"), { textContent: p.modelId }));
			if (p.name === activeName) head.appendChild(Object.assign(document.createElement("em"), { textContent: "· active" }));
			block.appendChild(head);
			const controls = document.createElement("div");
			controls.className = "model-controls";
			const filter = Object.assign(document.createElement("input"), { placeholder: "Filter models…" });
			filter.className = "model-filter";
			filter.addEventListener("input", apply);
			controls.appendChild(filter);
			const mkSel = (opts, title) => {
				const s = document.createElement("select");
				s.className = "model-sel";
				s.title = title;
				for (const [v, l] of opts) {
					const o = document.createElement("option");
					o.value = v; o.textContent = l;
					s.appendChild(o);
				}
				s.addEventListener("change", apply);
				return s;
			};
			const ctxSel = mkSel([["", "Ctx: any"], ["32768", "Ctx ≥32k"], ["131072", "Ctx ≥128k"], ["262144", "Ctx ≥256k"], ["1048576", "Ctx ≥1M"]], "Minimum context window");
			const priceSel = mkSel([["", "Price: any"], ["0.25", "≤ $0.25/M"], ["0.5", "≤ $0.50/M"], ["1", "≤ $1/M"], ["3", "≤ $3/M"], ["15", "≤ $15/M"]], "Max input price per Mtok");
			const modSel = mkSel([["", "Modalities: all"], ["image", "Image input"], ["audio", "Audio"], ["file", "File input"]], "Input modality");
			const tagSel = mkSel([["", "Tag: any"]], "Tag");
			const sortSel = mkSel([["", "Sort: default"], ["ctx", "Context ↓"], ["price-asc", "Price ↑"], ["price-desc", "Price ↓"]], "Sort order");
			for (const s of [ctxSel, priceSel, modSel, tagSel, sortSel]) controls.appendChild(s);
			block.appendChild(controls);
			let cur = [];
			const rebuildTags = () => {
				const tags = [...new Set(cur.flatMap((m) => m.tags ?? []))].sort();
				const v = tagSel.value;
				tagSel.innerHTML = "<option value=\"\">Tag: any</option>";
				for (const t of tags) tagSel.appendChild(Object.assign(document.createElement("option"), { value: t, textContent: t }));
				tagSel.value = tags.includes(v) ? v : "";
			};
			function apply() {
				const q = filter.value.toLowerCase();
				const ctx = Number(ctxSel.value) || 0;
				const price = Number(priceSel.value) || 0;
				const mod = modSel.value;
				const tag = tagSel.value;
				let out = cur.filter((m) => {
					if (q && !((m.label || "") + " " + m.id + " " + (m.description || "") + " " + (m.tags || []).join(" ")).toLowerCase().includes(q)) return false;
					if (ctx && (m.contextWindow ?? 0) < ctx) return false;
					if (price && (m.pricing?.input == null || m.pricing.input * 1e6 > price)) return false;
					if (mod && !(m.modalities?.input || []).includes(mod)) return false;
					if (tag && !(m.tags || []).includes(tag)) return false;
					return true;
				});
				if (sortSel.value === "ctx") out = [...out].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));
				if (sortSel.value === "price-asc") out = [...out].sort((a, b) => (a.pricing?.input ?? Infinity) - (b.pricing?.input ?? Infinity));
				if (sortSel.value === "price-desc") out = [...out].sort((a, b) => (b.pricing?.input ?? -Infinity) - (a.pricing?.input ?? -Infinity));
				fill(out);
			}
			const setModels = (models) => { cur = models ?? []; rebuildTags(); apply(); };
			const table = document.createElement("table");
			table.className = "providers-table models-table";
			table.innerHTML = "<thead><tr><th>Model</th><th>Context</th><th>Max out</th><th>Modalities</th><th>Price / Mtok</th><th>Tags</th><th></th></tr></thead>";
			const tbody = document.createElement("tbody");
			table.appendChild(tbody);
			const fill = (models) => {
				tbody.innerHTML = "";
				if (!models || models.length === 0) {
					tbody.innerHTML = "<tr><td colspan=\"7\"><em>no models</em></td></tr>";
					return;
				}
				for (const m of models) {
					const tr = document.createElement("tr");
					const tdId = document.createElement("td");
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
					const num = (v) => { const td = document.createElement("td"); td.className = "num"; td.textContent = v || "—"; return td; };
					tr.appendChild(num(fmtToks(m.contextWindow)));
					tr.appendChild(num(fmtToks(m.maxTokens)));
					tr.appendChild(num(fmtModalities(m.modalities)));
					const tdPrice = document.createElement("td");
					tdPrice.className = "num";
					tdPrice.textContent = m.pricing ? fmtPrice(m.pricing.input) + " / " + fmtPrice(m.pricing.output) : "—";
					if (m.pricing) tdPrice.title = "Input " + fmtPrice(m.pricing.input) + "/Mtok · Output " + fmtPrice(m.pricing.output) + "/Mtok";
					tr.appendChild(tdPrice);
					const tdTags = document.createElement("td");
					tdTags.className = "model-tags";
					tdTags.textContent = (m.tags || []).join(", ");
					tr.appendChild(tdTags);
					const tdUse = document.createElement("td");
					tdUse.style.width = "1%";
					if (p.modelId === m.id) tdUse.innerHTML = "<em>default</em>";
					const info = Object.assign(document.createElement("button"), { textContent: "ⓘ" });
					info.className = "secondary tiny";
					info.title = "Model details";
					info.addEventListener("click", () => {
						const next = tr.nextSibling;
						if (next?.classList?.contains("model-detail")) { next.remove(); return; }
						tr.parentNode.insertBefore(detailRow(m), tr.nextSibling);
					});
					tdUse.appendChild(info);
					const use = Object.assign(document.createElement("button"), { textContent: "Use" });
					use.className = "secondary tiny";
					use.addEventListener("click", () => {
						p.modelId = m.id;
						saveProfiles();
						post({ type: "set", key: "provider.profile", value: p.name });
						post({ type: "set", key: "provider.modelId", value: m.id });
						showSaved();
					});
					tdUse.appendChild(use);
					tr.appendChild(tdUse);
					tbody.appendChild(tr);
				}
			};
			const detailRow = (m) => {
				const tr = document.createElement("tr");
				tr.className = "model-detail";
				const td = document.createElement("td");
				td.colSpan = 7;
				const grid = document.createElement("div");
				grid.className = "detail-grid";
				const fmtDate = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "");
				const perTok = (v) => (v == null ? "" : "$" + v + " / tok");
				const rows = [
					["ID", m.id],
					["Owner", m.owner],
					["Context", m.contextWindow ? m.contextWindow.toLocaleString() + " tok" : ""],
					["Max output", m.maxTokens ? m.maxTokens.toLocaleString() + " tok" : ""],
					["Modalities", fmtModalities(m.modalities)],
					["Input price", m.pricing?.input != null ? fmtPrice(m.pricing.input) + " / Mtok (" + perTok(m.pricing.input) + ")" : ""],
					["Output price", m.pricing?.output != null ? fmtPrice(m.pricing.output) + " / Mtok (" + perTok(m.pricing.output) + ")" : ""],
					["Tags", (m.tags || []).join(", ")],
					["Parameters", (m.supportedParameters || []).join(", ")],
					["Reasoning", (m.reasoning || []).join(", ")],
					["Knowledge", m.knowledgeCutoff],
					["Released", fmtDate(m.releasedAt)],
				];
				for (const [k, v] of rows) {
					if (!v) continue;
					const item = document.createElement("div");
					item.className = "detail-item";
					item.appendChild(Object.assign(document.createElement("span"), { className: "detail-key", textContent: k }));
					item.appendChild(Object.assign(document.createElement("span"), { className: "detail-val", textContent: v }));
					grid.appendChild(item);
				}
				td.appendChild(grid);
				if (m.description) {
					const d = document.createElement("p");
					d.className = "detail-desc";
					d.textContent = m.description;
					td.appendChild(d);
				}
				tr.appendChild(td);
				return tr;
			};
			setModels(p.models);
			onModels(p.name, (msg) => setModels(msg.models ?? msg));
			const fetchBtn = Object.assign(document.createElement("button"), {
				textContent: p.models?.length ? "Refresh (" + p.models.length + ")" : "Fetch models",
			});
			fetchBtn.className = "secondary";
			const cacheNote = Object.assign(document.createElement("em"), {
				className: "test-status",
				textContent: p.modelsFetchedAt ? " cached " + new Date(p.modelsFetchedAt).toLocaleString() : "",
			});
			fetchBtn.addEventListener("click", () => {
				fetchBtn.textContent = "Fetching…";
				Promise.resolve(post({ type: "fetchProfileModels", name: p.name, baseUrl: p.baseUrl }))
					.then((m) => {
						const models = m?.models ?? [];
						setModels(models);
						fetchBtn.textContent = models.length ? "Refresh (" + models.length + ")" : "Refresh failed";
						if (models.length) cacheNote.textContent = " cached " + new Date().toLocaleString();
						if (!models.length && m?.error) block.appendChild(Object.assign(document.createElement("p"), { className: "note", textContent: m.error }));
					})
					.catch(() => { fetchBtn.textContent = "Refresh failed"; });
			});
			block.appendChild(fetchBtn);
			block.appendChild(cacheNote);
			block.appendChild(table);
			modelsList.appendChild(block);
		});
	};

	document.getElementById("add-profile").addEventListener("click", () => {
		profiles.push({ name: "provider-" + (profiles.length + 1), providerId: "openai-compatible", baseUrl: "", modelId: "" });
		saveProfiles();
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
				const resolve = modelRequests.get(msg.name);
				if (resolve) { modelRequests.delete(msg.name); resolve(msg); }
				for (const fn of pendingModelFills.get(msg.name) ?? []) fn(msg);
			}
		});
	}
	post({ type: "ready" });
})();`;
}
