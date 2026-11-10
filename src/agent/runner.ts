import { Agent } from "@cline/agents";
import type { AgentMessage, AgentRuntimeEvent, AgentTool, AgentToolResultPart } from "@cline/shared";
import { createFileTools, type FileChangeKind, WRITE_TOOL_NAMES } from "../tools/fileTools";
import { buildSystemPrompt } from "./systemPrompt";
import { createPrepareTurn } from "./compaction";
import { createRecallTool, type PriorTranscript } from "./recall";

export interface ProviderSettings {
	providerId: string;
	baseUrl: string;
	modelId: string;
	apiKey: string;
	maxIterations: number;
	profile?: string;
	contextWindow?: number;
}

/** What a finished run hands to the next task: summary + the files it touched. */
export interface RunDigest {
	task: string;
	status: string;
	summary: string;
	filesChanged: string[];
	at: number;
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
	| { type: "permission-request"; id: string; tool: string; path: string; diff?: string }
	| { type: "permission-response"; id: string; decision: "allow" | "always" | "deny" | "alwaysTool" }
	| { type: "loop-detected"; tool: string; count: number }
	| { type: "mode-blocked"; mode: AgentMode }
	| { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
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
	/** Directory for save_plan output; defaults to ".kronyx/plans" (relative to workspaceRoot for local tools, absolute for remote). */
	planDir?: string;
	/** Extra system-prompt context (memory recall); omit outside the extension. */
	memoryContext?: (task: string, settings: ProviderSettings) => Promise<string>;
	/** Environment descriptor for the system prompt, e.g. "the user's VS Code workspace". */
	environment?: string;
	/** Diagnostic sink; optional outside the extension. */
	log?: (tag: string, message: string) => void;
	/** Persist a durable fact for memory_write; omit outside the extension. */
	onMemoryFact?: (fact: string) => Promise<void>;
	/** Set false to omit the recall_context tool (e.g. tool-less ask runs). */
	enableRecall?: boolean;
	/** Persisted transcripts of earlier runs, exposed to the recall_context tool. */
	priorTranscripts?: () => readonly PriorTranscript[];
	/** Called after each run with the canonical transcript for cold-recall persistence. */
	saveTranscript?: (messages: readonly AgentMessage[]) => void;
}

const HANDOFF_FRACTION = 0.4;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const MAX_DIGESTS = 3;
const CHARS_PER_TOKEN = 4;

export class AgentRunner {
	private agent: Agent | undefined;
	private running = false;
	private digests: RunDigest[] = [];
	private readonly toolStarts = new Map<string, number>();

	constructor(private readonly host: RunnerHost) {}

	get isRunning(): boolean {
		return this.running;
	}

	get runDigests(): readonly RunDigest[] {
		return this.digests;
	}

	addRunDigest(digest: RunDigest): void {
		this.digests.push(digest);
		if (this.digests.length > MAX_DIGESTS) this.digests.shift();
	}

	setRunDigests(digests: RunDigest[]): void {
		this.digests = digests.slice(-MAX_DIGESTS);
	}

	reset(): void {
		this.agent?.abort("reset");
		this.agent = undefined;
		this.digests = [];
	}

	stop(): void {
		this.agent?.abort("Stopped by user");
	}

	/** True when the live transcript is large enough that a fresh digest-seeded agent is cheaper than full continuity. */
	private shouldHandoff(settings: ProviderSettings): boolean {
		if (!this.agent || this.digests.length === 0) return false;
		const window = settings.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
		const chars = JSON.stringify(this.agent.snapshot().messages).length;
		return chars / CHARS_PER_TOKEN > window * HANDOFF_FRACTION;
	}

	private seedMessages(): AgentMessage[] | undefined {
		if (this.digests.length === 0) return undefined;
		const lines = this.digests.map((d, i) => {
			const files = d.filesChanged.length ? ` Files changed: ${d.filesChanged.join(", ")}.` : "";
			return `${i + 1}) Task: ${d.task} — ${d.status}. Summary: ${d.summary.slice(0, 800)}.${files}`;
		});
		return [
			{
				id: `seed-${Date.now()}`,
				role: "user",
				content: [
					{
						type: "text",
						text: `Earlier work in this session (oldest first):\n${lines.join("\n")}\nUse this as context for the next task; file contents on disk are the source of truth — re-read them as needed. Earlier details are retrievable with recall_context.`,
					},
				],
				createdAt: Date.now(),
			},
		];
	}

	async run(task: string, settings: ProviderSettings): Promise<void> {
		if (this.running) throw new Error("A run is already in progress.");
		this.running = true;
		this.host.emit({ type: "run-started", task });
		try {
			let agent = this.agent;
			if (agent && this.shouldHandoff(settings)) {
				const dropped = Math.round(JSON.stringify(agent.snapshot().messages).length / CHARS_PER_TOKEN / 1000);
				this.host.emit({
					type: "info",
					text: `New task — carried ${this.digests.length} run summar${this.digests.length === 1 ? "y" : "ies"} forward (~${dropped}k tokens dropped from context)`,
				});
				agent = undefined;
			}
			agent ??= await this.createAgent(settings, task, this.seedMessages());
			this.agent = agent;
			const result = await agent.run(task);
			this.host.saveTranscript?.(agent.snapshot().messages);
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

	private async createAgent(settings: ProviderSettings, task: string, initialMessages?: AgentMessage[]): Promise<Agent> {
		const recentCalls: string[] = [];
		let modeWarned = false;
		const tools = this.host.createTools
			? await this.host.createTools()
			: createFileTools({
					root: this.host.workspaceRoot,
					isDirty: this.host.isDirty,
					onFileChanged: (abs, kind, stats) =>
						this.host.emit({ type: "file-changed", path: this.host.relativePath(abs), kind, ...stats }),
					onBeforeWrite: this.host.onBeforeWrite,
					execCommand: this.host.execCommand,
					planDir: this.host.planDir ? () => this.host.planDir! : undefined,
					onMemoryFact: this.host.onMemoryFact,
				});
		return new Agent({
			providerId: settings.providerId,
			modelId: settings.modelId,
			apiKey: settings.apiKey,
			baseUrl: settings.baseUrl || undefined,
			systemPrompt: buildSystemPrompt(
				this.host.workspaceRoot,
				this.host.currentMode(),
				(await this.host.memoryContext?.(task, settings)) ?? "",
				this.host.environment,
			),
			tools: [
				...tools,
				...(this.host.enableRecall === false ? [] : [createRecallTool({ priorTranscripts: this.host.priorTranscripts })]),
			],
			maxIterations: settings.maxIterations,
			toolExecution: "sequential",
			prepareTurn: createPrepareTurn({
				contextWindow: settings.contextWindow,
				onCompact: (s) => this.host.log?.("agent", `compaction ${JSON.stringify(s)}`),
			}),
			...(initialMessages?.length ? { initialMessages } : {}),
			hooks: {
				beforeTool: async ({ tool, input }) => {
					// Repetition guard: nudge at 3 identical calls, hard-stop at 5.
					const sig = tool.name + ":" + JSON.stringify(input ?? {}).replace(/\s+/g, "");
					recentCalls.push(sig);
					if (recentCalls.length > 12) recentCalls.shift();
					const dupes = recentCalls.filter((s) => s === sig).length;
					if (dupes >= 5) {
						this.host.emit({ type: "loop-detected", tool: tool.name, count: dupes });
						this.stop();
						return { skip: true, reason: `Stopped: this exact action was attempted ${dupes} times without progress.` };
					}
					if (dupes >= 3) {
						return {
							skip: true,
							reason: `You already ran this exact action ${dupes} times without fixing the problem. Change approach — different command, different file, or re-read the relevant code.`,
						};
					}
					const mode = this.host.currentMode();
					// save_plan is the single write permitted in Plan mode.
					if (tool.name === "save_plan") {
						return mode === "plan" ? undefined : { skip: true, reason: "Plans are saved in Plan mode only." };
					}
					// file_editor's read commands never need write permission.
					if (tool.name === "file_editor") {
						const cmd = (input as { command?: string })?.command;
						if (cmd === "view" || cmd === "symbols") return undefined;
					}
					if (!WRITE_TOOL_NAMES.has(tool.name)) return undefined;
					if (mode === "ask" || mode === "plan") {
						if (!modeWarned) {
							modeWarned = true;
							this.host.emit({ type: "mode-blocked", mode });
						}
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
					this.host.emit({
						type: "plan-ready",
						path: `${(this.host.planDir ?? ".kronyx/plans").replace(/\/+$/, "")}/${slug}.md`,
					});
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
					cacheReadTokens: event.usage.cacheReadTokens ?? 0,
					cacheWriteTokens: event.usage.cacheWriteTokens ?? 0,
				});
				break;
			case "status-notice":
				this.host.emit({ type: "info", text: event.message });
				break;
		}
	}
}

function stringify(value: unknown): string {
	if (value === undefined || value === null) return "";
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return text.length > 4000 ? `${text.slice(0, 4000)}\n... (truncated)` : text;
}
