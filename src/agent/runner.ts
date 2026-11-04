import { Agent } from "@cline/agents";
import type { AgentRuntimeEvent, AgentTool, AgentToolResultPart } from "@cline/shared";
import { createFileTools, type FileChangeKind, WRITE_TOOL_NAMES } from "../tools/fileTools";
import { planDir } from "../config";
import { loadMemoryContext } from "./memory";
import { buildSystemPrompt } from "./systemPrompt";

export interface ProviderSettings {
	providerId: string;
	baseUrl: string;
	modelId: string;
	apiKey: string;
	maxIterations: number;
	profile?: string;
}

export type AgentMode = "code" | "smart" | "ask" | "plan" | "bypass";

export type RunViewEvent =
	| { type: "run-started"; task: string }
	| { type: "assistant-text"; iteration: number; text: string }
	| { type: "reasoning"; iteration: number; text: string; redacted?: boolean }
	| { type: "tool-started"; id: string; name: string; input: unknown }
	| { type: "tool-finished"; id: string; ok: boolean; output: string; durationMs: number }
	| { type: "file-changed"; path: string; kind: FileChangeKind; added?: number; removed?: number; diff?: string }
	| { type: "assistant-delta"; text: string }
	| { type: "reasoning-delta"; text: string }
	| { type: "info"; text: string }
	| { type: "check"; command: string; ok: boolean; durationMs: number; output: string }
	| { type: "plan-ready"; path: string }
	| { type: "permission-request"; id: string; tool: string; path: string }
	| { type: "permission-response"; id: string; decision: "allow" | "always" | "deny" | "alwaysTool" }
	| { type: "usage"; inputTokens: number; outputTokens: number }
	| { type: "run-finished"; status: string; text: string; iterations: number }
	| { type: "run-failed"; error: string };

export interface RunnerHost {
	workspaceRoot: string;
	isDirty: (absPath: string) => boolean;
	confirmWrite: (toolName: string, input: unknown) => Promise<boolean>;
	relativePath: (absPath: string) => string;
	onBeforeWrite?: (absPath: string, before: string | null) => void;
	execCommand?: (command: string) => Promise<string | null>;
	createTools?: () => Promise<AgentTool<any, string>[]>;
	currentMode: () => AgentMode;
	emit: (event: RunViewEvent) => void;
}

export class AgentRunner {
	private agent: Agent | undefined;
	private running = false;
	private readonly toolStarts = new Map<string, number>();

	constructor(private readonly host: RunnerHost) {}

	get isRunning(): boolean {
		return this.running;
	}

	reset(): void {
		this.agent?.abort("reset");
		this.agent = undefined;
	}

	stop(): void {
		this.agent?.abort("Stopped by user");
	}

	async run(task: string, settings: ProviderSettings): Promise<void> {
		if (this.running) throw new Error("A run is already in progress.");
		this.running = true;
		this.host.emit({ type: "run-started", task });
		try {
			const agent = this.agent ?? (await this.createAgent(settings, task));
			this.agent = agent;
			const result = await agent.run(task);
			if (result.status === "failed") {
				this.host.emit({ type: "run-failed", error: result.error?.message ?? "Run failed" });
			} else {
				this.host.emit({
					type: "run-finished",
					status: result.status,
					text: result.outputText,
					iterations: result.iterations,
				});
			}
		} catch (error) {
			this.host.emit({ type: "run-failed", error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.running = false;
		}
	}

	private async createAgent(settings: ProviderSettings, task: string): Promise<Agent> {
		const tools = this.host.createTools
			? await this.host.createTools()
			: createFileTools({
					root: this.host.workspaceRoot,
					isDirty: this.host.isDirty,
					onFileChanged: (abs, kind, stats) =>
						this.host.emit({ type: "file-changed", path: this.host.relativePath(abs), kind, ...stats }),
					onBeforeWrite: this.host.onBeforeWrite,
					execCommand: this.host.execCommand,
					planDir,
				});
		return new Agent({
			providerId: settings.providerId,
			modelId: settings.modelId,
			apiKey: settings.apiKey,
			baseUrl: settings.baseUrl || undefined,
			systemPrompt: buildSystemPrompt(
				this.host.workspaceRoot,
				this.host.currentMode(),
				await loadMemoryContext(this.host.workspaceRoot, task, settings),
			),
			tools,
			maxIterations: settings.maxIterations,
			toolExecution: "sequential",
			hooks: {
				beforeTool: async ({ tool, input }) => {
					const mode = this.host.currentMode();
					// save_plan is the single write permitted in Plan mode.
					if (tool.name === "save_plan") {
						return mode === "plan" ? undefined : { skip: true, reason: "Plans are saved in Plan mode only." };
					}
					if (!WRITE_TOOL_NAMES.has(tool.name)) return undefined;
					if (mode === "ask" || mode === "plan") {
						return {
							skip: true,
							reason: `Writes are disabled in ${mode} mode. Ask the user to switch to Code or Smart mode.`,
						};
					}
					if (mode === "smart" || mode === "bypass") return undefined;
					const allowed = await this.host.confirmWrite(tool.name, input);
					return allowed ? undefined : { skip: true, reason: "The user denied this change." };
				},
				onEvent: (event) => this.forward(event),
			},
		});
	}

	private forward(event: AgentRuntimeEvent): void {
		switch (event.type) {
			case "assistant-message": {
				const reasoning = event.message.content
					.filter((part) => part.type === "reasoning")
					.map((part) => (part as { text: string; redacted?: boolean }).text)
					.join("");
				if (reasoning.trim())
					this.host.emit({ type: "reasoning", iteration: event.iteration, text: reasoning });
				const text = event.message.content
					.filter((part) => part.type === "text")
					.map((part) => (part as { text: string }).text)
					.join("");
				if (text.trim()) this.host.emit({ type: "assistant-text", iteration: event.iteration, text });
				break;
			}
			case "tool-started":
				this.toolStarts.set(event.toolCall.toolCallId, Date.now());
				this.host.emit({
					type: "tool-started",
					id: event.toolCall.toolCallId,
					name: event.toolCall.toolName,
					input: event.toolCall.input,
				});
				break;
			case "tool-finished": {
				if (event.toolCall.toolName === "save_plan") {
					const slug = String((event.toolCall.input as { slug?: string })?.slug || "plan").replace(/[^\w-]+/g, "-").slice(0, 60);
					this.host.emit({ type: "plan-ready", path: `${planDir().replace(/\/+$/, "")}/${slug}.md` });
				}
				const result = event.message.content.find((part) => part.type === "tool-result") as
					| AgentToolResultPart
					| undefined;
				const started = this.toolStarts.get(event.toolCall.toolCallId) ?? Date.now();
				this.toolStarts.delete(event.toolCall.toolCallId);
				this.host.emit({
					type: "tool-finished",
					id: event.toolCall.toolCallId,
					ok: !result?.isError,
					output: stringify(result?.output),
					durationMs: Date.now() - started,
				});
				break;
			}
			case "assistant-text-delta":
				this.host.emit({ type: "assistant-delta", text: event.text });
				break;
			case "assistant-reasoning-delta":
				this.host.emit({ type: "reasoning-delta", text: event.text });
				break;
			case "usage-updated":
				this.host.emit({
					type: "usage",
					inputTokens: event.usage.inputTokens ?? 0,
					outputTokens: event.usage.outputTokens ?? 0,
				});
				break;
		}
	}
}

function stringify(value: unknown): string {
	if (value === undefined || value === null) return "";
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return text.length > 4000 ? `${text.slice(0, 4000)}\n... (truncated)` : text;
}
