import { Agent } from "@cline/agents";
import type { AgentMessage, AgentRuntimeEvent, AgentTool, AgentToolResultPart } from "@cline/shared";
import { createFileTools, type FileChangeKind, WRITE_TOOL_NAMES } from "../tools/fileTools";
import { createFetchTools } from "../tools/fetchTools";
import { buildSystemPrompt } from "./systemPrompt";
import { createPrepareTurn, taskContextBudget } from "./compaction";
import { createRecallTool, type PriorTranscript, type RecallScorer } from "./recall";
import { countTokens } from "./tokenize";

export interface ProviderSettings {
	providerId: string;
	baseUrl: string;
	modelId: string;
	apiKey: string;
	maxIterations: number;
	profile?: string;
	contextWindow?: number;
	maxTokens?: number;
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
	| { type: "tool-output-delta"; text: string }
	| { type: "info"; text: string; meta?: Record<string, unknown> }
	| { type: "check"; command: string; ok: boolean; durationMs: number; output: string }
	| { type: "plan-ready"; path: string }
	| { type: "permission-request"; id: string; tool: string; path: string; command?: string; input?: unknown; diff?: string }
	| { type: "permission-response"; id: string; decision: "allow" | "always" | "deny" | "alwaysTool" | "alwaysRule" | "stopped" | "timeout" }
	| { type: "loop-detected"; tool: string; count: number }
	| { type: "mode-blocked"; mode: AgentMode }
	| {
			type: "usage";
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens: number;
			cacheWriteTokens: number;
			reasoningTokens?: number;
			/** Provider-reported cumulative billed cost (not all providers report). */
			totalCost?: number;
			iteration?: number;
			contextMsgs?: number;
			/** Input size of the request this event covers — ≈ current context fill. */
			requestTokens?: number;
			contextWindow?: number;
			contextPct?: number;
			/** Effective context ceiling for this run's task profile (compaction triggers against this, not the model's max window). */
			contextBudget?: number;
		}
	| { type: "run-finished"; status: string; text: string; iterations: number }
	| { type: "run-failed"; error: string }
	// Multi-agent orchestration events (emitted by the executor, not the runner).
	| { type: "fanout"; slices: { index: number; title: string; owns: string[] }[] }
	| { type: "fanin"; results: { index: number; title: string; status: "merged" | "resolved" | "failed"; detail?: string }[] }
	| { type: "fanin-conflict"; index: number; files: string[] }
	| { type: "slice-status"; index: number; title: string; status: "running" | "done" | "failed" | "stopped"; summary?: string };

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
	/** Rule-file permission check (see agent/permissions.ts). Runs before mode defaults:
	 *  "deny" skips the call, "allow" bypasses prompting, "ask"/undefined → normal flow. */
	checkPermission?: (toolName: string, input: unknown) => Promise<"allow" | "ask" | "deny" | undefined>;
	/** Persisted transcripts of earlier runs, exposed to the recall_context tool. */
	priorTranscripts?: () => readonly PriorTranscript[];
	/** Semantic ranker for recall_context queries (embeddings); keyword search is the fallback. */
	recallScorer?: RecallScorer;
	/** Called after each run with the canonical transcript for cold-recall persistence. */
	saveTranscript?: (messages: readonly AgentMessage[]) => void;
}

const HANDOFF_FRACTION = 0.4;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const MAX_DIGESTS = 3;
const READ_ONLY_HIDDEN = new Set([
	"write_file",
	"edit_file",
	"append_file",
	"insert_lines",
	"file_editor",
	"run_command",
	"browser_use",
	"switch_environment",
	"rename_symbol",
]);

export class AgentRunner {
	private agent: Agent | undefined;
	private running = false;
	/** Effective context ceiling for the current run's task profile. */
	private contextBudget: number | undefined;
	/** Live budget holder — prepareTurn ratchets this toward the model's real
	 *  window; usage events stamp it so the UI meter tracks the ratchet. */
	private budgetRef = { current: 0 };
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

	private stopRequested = false;

	stop(): void {
		this.stopRequested = true;
		this.agent?.abort("Stopped by user");
	}

	/** True when the live transcript is large enough that a fresh digest-seeded agent is cheaper than full continuity. */
	private shouldHandoff(settings: ProviderSettings): boolean {
		if (!this.agent || this.digests.length === 0) return false;
		const window = settings.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
		return countTokens(JSON.stringify(this.agent.snapshot().messages)) > window * HANDOFF_FRACTION;
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
		this.contextBudget = taskContextBudget(task, this.host.currentMode());
		this.host.emit({ type: "run-started", task });
		try {
			// A stop that landed before run() (e.g. during worker sandbox setup) still halts here.
			if (this.stopRequested) {
				this.host.emit({ type: "run-finished", status: "stopped", text: "Stopped by user", iterations: 0 });
				return;
			}
			let agent = this.agent;
			if (agent && this.shouldHandoff(settings)) {
				const dropped = Math.round(countTokens(JSON.stringify(agent.snapshot().messages)) / 1000);
				this.host.emit({
					type: "info",
					text: `New task — carried ${this.digests.length} run summar${this.digests.length === 1 ? "y" : "ies"} forward (~${dropped}k tokens dropped from context)`,
				});
				agent = undefined;
			}
			if (!agent) {
				// New Agent = new prepareTurn closure seeded from budgetRef — a
				// reused agent keeps its ratcheted budget instead of resetting.
				this.budgetRef.current = this.contextBudget;
				agent = await this.createAgent(settings, task, this.seedMessages());
			}
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
			this.stopRequested = false;
			this.running = false;
		}
	}

	private async createAgent(settings: ProviderSettings, task: string, initialMessages?: AgentMessage[]): Promise<Agent> {
		const recentCalls: string[] = [];
		let modeWarned = false;
		const tools = this.host.createTools
			? await this.host.createTools()
			: [
					...createFileTools({
						root: this.host.workspaceRoot,
						isDirty: this.host.isDirty,
						onFileChanged: (abs, kind, stats) =>
							this.host.emit({ type: "file-changed", path: this.host.relativePath(abs), kind, ...stats }),
						onBeforeWrite: this.host.onBeforeWrite,
						execCommand: this.host.execCommand,
						planDir: this.host.planDir ? () => this.host.planDir! : undefined,
						onMemoryFact: this.host.onMemoryFact,
					}),
					...createFetchTools(),
				];
		const mode = this.host.currentMode();
		// Per-tool executionMode markers are honored only in write modes; ask/plan
		// runs strip them to sequential so every call is an ordered boundary.
		const allowParallel = mode !== "ask" && mode !== "plan";
		// Read-only modes don't ship the write/env tool schemas — the hook would
		// deny them anyway, and each schema costs tokens on every request.
		const visible =
			mode === "ask" || mode === "plan"
				? tools.filter((t) => !READ_ONLY_HIDDEN.has(t.name) && (mode === "plan" || t.name !== "save_plan"))
				: tools;
		const execTools = (list: AgentTool<any, string>[]) =>
			allowParallel ? list : list.map((t) => (t.executionMode === "parallel" ? { ...t, executionMode: "sequential" as const } : t));
		return new Agent({
			providerId: settings.providerId,
			modelId: settings.modelId,
			apiKey: settings.apiKey,
			baseUrl: settings.baseUrl || undefined,
			systemPrompt: buildSystemPrompt(
				this.host.workspaceRoot,
				mode,
				(await this.host.memoryContext?.(task, settings)) ?? "",
				this.host.environment,
			),
			tools: [
				...execTools(visible),
				...(this.host.enableRecall === false
					? []
					: execTools([createRecallTool({ priorTranscripts: this.host.priorTranscripts, scorer: this.host.recallScorer })])),
			],
			maxIterations: settings.maxIterations,
			...(settings.maxTokens ? { modelOptions: { maxTokens: settings.maxTokens } } : {}),
			toolExecution: "sequential",
			prepareTurn: createPrepareTurn({
				contextWindow: settings.contextWindow,
				contextBudget: this.contextBudget,
				budgetRef: this.budgetRef,
				maxTokens: settings.maxTokens,
				providerId: settings.providerId,
				modelId: settings.modelId,
				summarize: settings.baseUrl
					? (messages) => summarizeMessages(settings, messages)
					: undefined,
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
					// Rule-file permissions: deny short-circuits, allow bypasses the prompt.
					const rule = await this.host.checkPermission?.(tool.name, input);
					if (rule === "deny") {
						return { skip: true, reason: `Denied by permissions rules — ${tool.name} is not allowed here. Choose a different approach.` };
					}
					if (rule === "allow") return undefined;
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
					reasoningTokens: event.usage.reasoningTokenCount ?? 0,
					totalCost: event.usage.totalCost,
					iteration: event.snapshot.iteration,
					contextMsgs: event.snapshot.messages.length,
					contextBudget: this.budgetRef.current,
				});
				break;
			case "status-notice":
				this.host.emit({ type: "info", text: event.message, meta: event.metadata });
				break;
		}
	}
}

const SUMMARY_INPUT_CAP = 60_000;
const SUMMARY_MAX_TOKENS = 1200;

/**
 * Hard-compaction recap: one OpenAI-compatible /chat/completions call that
 * condenses the oldest turns. Best-effort — callers fall back to mechanical
 * stubbing when the endpoint rejects or the shape differs.
 */
async function summarizeMessages(settings: ProviderSettings, messages: readonly AgentMessage[]): Promise<string | undefined> {
	const transcript = messages
		.map((m) => `${m.role}: ${JSON.stringify(m.content).slice(0, 4000)}`)
		.join("\n")
		.slice(0, SUMMARY_INPUT_CAP);
	if (!transcript.trim()) return undefined;
	const res = await fetch(`${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
		body: JSON.stringify({
			model: settings.modelId,
			max_tokens: SUMMARY_MAX_TOKENS,
			messages: [
				{
					role: "user",
					content:
						"Write a brief for the SAME agent to continue this coding task — not a narrative summary of the transcript. " +
						"The original task message is preserved verbatim elsewhere, so do not restate it. In <=300 words of compact prose cover: " +
						"(1) the agent's current occupation — what it was doing and the live state; " +
						"(2) its intentions and planned next steps; " +
						"(3) remaining work and the criteria for considering the task complete; " +
						"(4) files read or changed, with paths; " +
						"(5) errors hit and their resolutions, if worth remembering; " +
						"(6) pointers to details it may need later (it can retrieve them with recall_context).\n\n" + transcript,
				},
			],
		}),
		signal: AbortSignal.timeout(60_000),
	});
	if (!res.ok) return undefined;
	const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
	const text = data.choices?.[0]?.message?.content;
	return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

function stringify(value: unknown): string {
	if (value === undefined || value === null) return "";
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return text.length > 4000 ? `${text.slice(0, 4000)}\n... (truncated)` : text;
}
