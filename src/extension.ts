import * as path from "node:path";
import * as vscode from "vscode";
import { AgentRunner } from "./agent/runner";
import { autoApproveWrites, clearApiKey, promptForApiKey, readProviderSettings } from "./config";
import { RunViewProvider, type WebviewMessage } from "./ui/runViewProvider";

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel("Kronyx");
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	status.command = "kronyx.focus";
	setStatus(status, "idle");
	status.show();

	let runner: AgentRunner | undefined;
	let runner_root: string | undefined;

	const view = new RunViewProvider(context.extensionUri, (message) => void handle(message));

	const getRunner = (): AgentRunner | undefined => {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			void vscode.window.showErrorMessage("Kronyx: open a folder first.");
			return undefined;
		}
		const root = folder.uri.fsPath;
		if (!runner || runner_root !== root) {
			runner_root = root;
			runner = new AgentRunner({
				workspaceRoot: root,
				relativePath: (abs) => path.relative(root, abs).split(path.sep).join("/"),
				isDirty: (abs) =>
					vscode.workspace.textDocuments.some((doc) => doc.isDirty && doc.uri.fsPath === abs),
				confirmWrite: (toolName, input) => confirmWrite(root, toolName, input),
				emit: (event) => {
					view.post(event);
					output.appendLine(`[${event.type}] ${summarize(event)}`);
					if (event.type === "run-started") setStatus(status, "running");
					if (event.type === "run-finished") setStatus(status, "idle");
					if (event.type === "run-failed") setStatus(status, "failed");
				},
			});
		}
		return runner;
	};

	const startRun = async (task: string) => {
		const active = getRunner();
		if (!active) return;
		let settings = await readProviderSettings(context.secrets);
		if (settings && !settings.apiKey) {
			if (!(await promptForApiKey(context.secrets))) {
				view.post({ type: "run-failed", error: "No API key set. Run 'Kronyx: Set API key'." });
				return;
			}
			settings = await readProviderSettings(context.secrets);
		}
		if (!settings) return;
		output.appendLine(`Run with ${settings.providerId} ${settings.modelId} at ${settings.baseUrl}`);
		await active.run(task, settings);
	};

	async function handle(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case "run":
				await startRun(message.task);
				break;
			case "stop":
				runner?.stop();
				break;
			case "new":
				runner?.reset();
				view.post({ type: "reset" });
				setStatus(status, "idle");
				break;
			case "setApiKey":
				await promptForApiKey(context.secrets);
				break;
		}
	}

	context.subscriptions.push(
		output,
		status,
		vscode.window.registerWebviewViewProvider(RunViewProvider.viewId, view, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand("kronyx.focus", () =>
			vscode.commands.executeCommand(`${RunViewProvider.viewId}.focus`),
		),
		vscode.commands.registerCommand("kronyx.runTask", async () => {
			const task = await vscode.window.showInputBox({ title: "Kronyx: run task", prompt: "Describe the change" });
			if (task) {
				await vscode.commands.executeCommand(`${RunViewProvider.viewId}.focus`);
				await startRun(task);
			}
		}),
		vscode.commands.registerCommand("kronyx.stop", () => runner?.stop()),
		vscode.commands.registerCommand("kronyx.newTask", () => handle({ type: "new" })),
		vscode.commands.registerCommand("kronyx.setApiKey", () => promptForApiKey(context.secrets)),
		vscode.commands.registerCommand("kronyx.clearApiKey", async () => {
			await clearApiKey(context.secrets);
			void vscode.window.showInformationMessage("Kronyx: API key cleared.");
		}),
	);
}

export function deactivate(): void {}

let approveAllUntilReset = false;

async function confirmWrite(root: string, toolName: string, input: unknown): Promise<boolean> {
	if (autoApproveWrites() || approveAllUntilReset) return true;
	const file = (input as { path?: string })?.path ?? "(unknown file)";
	const choice = await vscode.window.showInformationMessage(
		`Kronyx wants to run ${toolName} on ${file}`,
		{ modal: true, detail: `Workspace: ${root}` },
		"Allow",
		"Allow all this session",
	);
	if (choice === "Allow all this session") approveAllUntilReset = true;
	return choice === "Allow" || choice === "Allow all this session";
}

function setStatus(item: vscode.StatusBarItem, state: "idle" | "running" | "failed"): void {
	const icon = state === "running" ? "$(sync~spin)" : state === "failed" ? "$(error)" : "$(hubot)";
	item.text = `${icon} Kronyx`;
	item.tooltip = `Kronyx: ${state}`;
}

function summarize(event: { type: string } & Record<string, unknown>): string {
	const { type: _type, ...rest } = event;
	const text = JSON.stringify(rest);
	return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}
