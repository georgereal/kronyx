import * as vscode from "vscode";
import type { ProviderSettings } from "./agent/runner";

const API_KEY_SECRET = "kronyx.provider.apiKey";

export async function readProviderSettings(secrets: vscode.SecretStorage): Promise<ProviderSettings | undefined> {
	const config = vscode.workspace.getConfiguration("kronyx");
	const apiKey = (await secrets.get(API_KEY_SECRET)) ?? "";
	return {
		providerId: config.get<string>("provider.id", "openai-compatible"),
		baseUrl: config.get<string>("provider.baseUrl", "https://ai-gateway.vercel.sh/v1"),
		modelId: config.get<string>("provider.modelId", "anthropic/claude-sonnet-4.6"),
		maxIterations: config.get<number>("agent.maxIterations", 40),
		apiKey,
	};
}

export function autoApproveWrites(): boolean {
	return vscode.workspace.getConfiguration("kronyx").get<boolean>("approval.autoApproveWrites", false);
}

export async function promptForApiKey(secrets: vscode.SecretStorage): Promise<boolean> {
	const value = await vscode.window.showInputBox({
		title: "Kronyx: API key",
		prompt: "API key for the configured OpenAI-compatible endpoint (stored in VS Code SecretStorage).",
		password: true,
		ignoreFocusOut: true,
	});
	if (!value) return false;
	await secrets.store(API_KEY_SECRET, value.trim());
	return true;
}

export async function clearApiKey(secrets: vscode.SecretStorage): Promise<void> {
	await secrets.delete(API_KEY_SECRET);
}
