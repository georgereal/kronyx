import { Agent } from "@cline/agents";
import type { AgentRuntimeEvent, AgentToolResultPart } from "@cline/shared";
import { createFileTools, type FileChangeKind, WRITE_TOOL_NAMES } from "../tools/fileTools";
import { buildSystemPrompt } from "./systemPrompt";

export interface ProviderSettings {
	providerId: string;
	baseUrl: string;
	modelId: string;
	apiKey: string;
	maxIterations: number;
}

export type RunViewEvent =
	| { type: "run-started"; task: string }
	| { type: "assistant-text"; iteration: number; text: string }
	| { type: "tool-started"; id: string; name: string; input: unknown }
	| { type: "tool-finished"; id: string; ok: boolean; output: string; durationMs: number }
	| { type: "file-changed"; path: string; kind: FileChangeKind }
	| { type: "usage"; inputTokens: number; outputTokens: number }
	| { type: "run-finished"; status: string; text: string; iterations: number }
	| { type: "run-failed"; error: string };

export interface RunnerHost {
	workspaceRoot: string;
	isDirty: (absPath: string) => boolean;
	confirmWrite: (toolName: string, input: unknown) => Promise<boolean>;
	relativePath: (absPath: string) => string;
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
			const agent = this.agent ?? this.createAgent(settings);
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

	private createAgent(settings: ProviderSettings): Agent {
		const tools = createFileTools({
			root: this.host.workspaceRoot,
			isDirty: this.host.isDirty,
			onFileChanged: (abs, kind) =>
				this.host.emit({ type: "file-changed", path: this.host.relativePath(abs), kind }),
		});
		return new Agent({
			providerId: settings.providerId,
			modelId: settings.modelId,
			apiKey: settings.apiKey,
			baseUrl: settings.baseUrl || undefined,
			systemPrompt: buildSystemPrompt(this.host.workspaceRoot),
			tools,
			maxIterations: settings.maxIterations,
			toolExecution: "sequential",
			hooks: {
				beforeTool: async ({ tool, input }) => {
					if (!WRITE_TOOL_NAMES.has(tool.name)) return undefined;
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
