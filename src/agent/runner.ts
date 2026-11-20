import { Agent } from "@cline/agents";
import { DEFAULT_MAX_IMAGE_DECODED_BYTES, SUPPORTED_IMAGE_MEDIA_TYPES } from "@cline/shared";
import type { AgentImagePart, AgentMessage, AgentRuntimeEvent, AgentTool, AgentToolResultPart } from "@cline/shared";
import { createFileTools, type FileChangeKind, WRITE_TOOL_NAMES } from "../tools/fileTools";
import { createFetchTools } from "../tools/fetchTools";
import { createDispatchTool, DEFERRED_TOOLS } from "../tools/dispatchTools";
import { createLoadSkillTool, parseSkill, skillsIndex } from "./skills";
import { createExploreTool } from "../tools/exploreTools";
import { buildSystemPrompt } from "./systemPrompt";
import { createPrepareTurn, taskContextBudget } from "./compaction";
import { createRecallTool } from "./recall";
import { countMessageTokens } from "./tokenize";
import { ToolPipeline } from "./pipeline";
import { createRepeatGuard } from "./guards/repeatGuard";
import { createPermissionGuard } from "./guards/permissionGuard";
import { createSavePlanGuard, createWriteModeGuard } from "./guards/modeGuard";
import { createApprovalGuard } from "./guards/approvalGuard";
import type { ApprovalsProvider, EventsProvider, FilesProvider, MemoryProvider, RecallProvider, ResumeProvider, ToolsProvider, TranscriptsProvider } from "./seams";

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
	/** HEAD sha at the end of this run — used to verify the work is still in the tree after a restore. */
	endSha?: string;
}

export type AgentMode = "code" | "smart" | "ask" | "plan" | "bypass";

/** A user-attached file carried into the run; image/* bytes reach the model as image parts. */
export interface RunnerAttachment {
	filename: string;
	mediaType: string;
	data?: Uint8Array;
}

export type RunViewEvent =
	| { type: "run-started"; task: string }
	| { type: "assistant-text"; iteration: number; text: string }
	| { type: "reasoning"; iteration: number; text: string; redacted?: boolean }
	| { type: "tool-started"; id: string; name: string; input: unknown }
	| { type: "tool-finished"; id: string; name?: string; ok: boolean; output: string; durationMs: number }
	| { type: "file-changed"; path: string; kind: FileChangeKind; added?: number; removed?: number; diff?: string }
	| { type: "assistant-delta"; text: string }
	| { type: "reasoning-delta"; text: string }
	| { type: "tool-output-delta"; text: string }
	| { type: "info"; text: string; key?: string; meta?: Record<string, unknown> }
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
	relativePath: (absPath: string) => string;
	currentMode: () => AgentMode;
	emit: (event: RunViewEvent) => void;
	/** Directory for save_plan output; defaults to ".kronyx/plans" (relative to workspaceRoot for local tools, absolute for remote). */
	planDir?: string;
	/** Environment descriptor for the system prompt, e.g. "the user's VS Code workspace". */
	environment?: string;
	/** Diagnostic sink; optional outside the extension. */
	log?: (tag: string, message: string) => void;
	/** Tool provider seam: the agent's full tool set. Default: local file + fetch tools. */
	tools?: ToolsProvider;
	/** Approval seam: rule check + interactive confirm for writes. */
	approvals?: ApprovalsProvider;
	/** Memory seam: prompt context + durable fact persistence. */
	memory?: MemoryProvider;
	/** Recall seam: prior transcripts + semantic scorer for recall_context. */
	recall?: RecallProvider;
	/** Transcript seam: canonical transcript persistence after each run. */
	transcripts?: TranscriptsProvider;
	/** Files seam: pre-write snapshots + host-side command execution. */
	files?: FilesProvider;
	/** Events seam: durable KronyxEvent record sink (canonical run log). */
	events?: EventsProvider;
	/** Resume seam: seed messages from a prior run's durable log. */
	resume?: ResumeProvider;
}

const HANDOFF_FRACTION = 0.4;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const MAX_DIGESTS = 3;
/** Modes where a run that ends with zero tool calls gets one "proceed" nudge. */
const WRITE_MODES: ReadonlySet<AgentMode> = new Set(["code", "smart", "bypass"]);

/** Supported, size-capped attachments → image parts on the task's user message. */
function imageAttachmentParts(attachments: readonly RunnerAttachment[] | undefined): AgentImagePart[] {
	const parts: AgentImagePart[] = [];
	for (const a of attachments ?? []) {
		if (!a.data?.byteLength || !(SUPPORTED_IMAGE_MEDIA_TYPES as readonly string[]).includes(a.mediaType)) continue;
		if (a.data.byteLength > DEFAULT_MAX_IMAGE_DECODED_BYTES) continue;
		parts.push({ type: "image", image: a.data, mediaType: a.mediaType });
	}
	return parts;
}

/** Image parts are bulky base64 — persisted transcripts/events keep a text marker instead. */
function omitImageParts(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.map((m) => ({
		...m,
		content: m.content.map((p) => (p.type === "image" ? { type: "text" as const, text: `[image attachment omitted (${p.mediaType ?? "image"})]` } : p)),
	}));
}

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
	/** Set by requestCompact(); consumed by prepareTurn → hard compaction next turn. */
	private forceCompactRef = { current: false };
	private digests: RunDigest[] = [];
	/** Restore-reconciliation note seeded into a freshly created agent. */
	private stateNote: string | undefined;
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

	/** One-shot restore note — applied to the next freshly created agent's seed. */
	setStateNote(note: string | undefined): void {
		this.stateNote = note;
	}

	reset(): void {
		this.agent?.abort("reset");
		this.agent = undefined;
		this.digests = [];
		this.stateNote = undefined;
	}

	private stopRequested = false;

	stop(): void {
		this.stopRequested = true;
		this.agent?.abort("Stopped by user");
	}

	/** Manual "compact now": the next model turn runs the hard-tier compaction
	 *  (same path as provider overflow). Returns false when nothing is loaded —
	 *  there's no context to compact before the first turn of a run. */
	requestCompact(): boolean {
		if (!this.agent || !this.running) return false;
		this.forceCompactRef.current = true;
		this.host.emit({ type: "info", text: "Context compaction requested — applies on the next model turn." });
		return true;
	}

	/** Drop the live agent; run digests carry forward so the next task seeds a
	 *  fresh agent (soft clear — same as the automatic handoff, on demand). */
	clearContext(): boolean {
		if (this.running || !this.agent) return false;
		this.agent = undefined;
		this.host.emit({ type: "info", text: "Context cleared — the next task starts fresh, carrying run summaries forward." });
		return true;
	}

	/** True when the live transcript is large enough that a fresh digest-seeded agent is cheaper than full continuity. */
	private shouldHandoff(settings: ProviderSettings): boolean {
		if (!this.agent || this.digests.length === 0) return false;
		const window = settings.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
		return countMessageTokens(this.agent.snapshot().messages) > window * HANDOFF_FRACTION;
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

	async run(task: string, settings: ProviderSettings, attachments?: RunnerAttachment[]): Promise<void> {
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
				const dropped = Math.round(countMessageTokens(agent.snapshot().messages) / 1000);
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
				let initial = this.seedMessages();
				// Resume seam: a prior run's durable log beats digest seeds.
				const resumed = await this.host.resume?.resumeLog?.();
				if (resumed?.length) {
					initial = resumed;
					this.host.events?.record({ type: "resumed-from-log", messages: resumed.length });
				}
				if (this.stateNote) {
					// Attach to whichever seed won (digests or resume log) — the
					// note describes the actual restored tree, not the history.
					initial = [
						...(initial ?? []),
						{
							id: `state-${Date.now()}`,
							role: "user",
							content: [{ type: "text" as const, text: this.stateNote }],
							createdAt: Date.now(),
						},
					];
					this.stateNote = undefined;
				}
				for (const m of initial ?? []) this.host.events?.record({ type: "agent-message", message: m });
				agent = await this.createAgent(settings, task, initial);
			}
			this.agent = agent;
			const beforeCount = agent.snapshot().messages.length;
			// Image attachments ride as image parts on the task's user message —
			// disk copies under .kronyx/attachments/ stay for tool-side inspection.
			const images = imageAttachmentParts(attachments);
			const input: string | AgentMessage = images.length
				? {
						id: `task-${Date.now()}`,
						role: "user",
						content: [{ type: "text", text: task }, ...images],
						createdAt: Date.now(),
					}
				: task;
			let result = await agent.run(input);
			// A "completed" write-mode run with zero tool calls is almost always the
			// model answering in prose instead of working — give it one nudge.
			const toolCalls = result.messages
				.slice(beforeCount)
				.reduce((n, m) => n + m.content.filter((p) => p.type === "tool-call").length, 0);
			if (result.status === "completed" && toolCalls === 0 && WRITE_MODES.has(this.host.currentMode())) {
				this.host.emit({ type: "info", text: "Finished without using any tools — nudging the agent to proceed." });
				result = await agent.continue(
					"You ended the run without calling any tools or changing files. " +
						"If the task asks for implementation or exploration, do it now using your tools. " +
						"If you are blocked on something only the user can provide, state exactly what is missing.",
				);
			}
			this.host.transcripts?.save(omitImageParts(agent.snapshot().messages));
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
		const pipeline = new ToolPipeline();
		pipeline.pre(
			createRepeatGuard({
				onLoopDetected: (tool, count) => this.host.emit({ type: "loop-detected", tool, count }),
				onStop: () => this.stop(),
			}),
		);
		pipeline.pre(createSavePlanGuard(this.host.currentMode));
		if (this.host.approvals?.check) pipeline.pre(createPermissionGuard(this.host.approvals.check));
		pipeline.pre(
			createWriteModeGuard({
				currentMode: this.host.currentMode,
				writeTools: WRITE_TOOL_NAMES,
				onModeBlocked: (mode) => this.host.emit({ type: "mode-blocked", mode }),
			}),
		);
		pipeline.pre(createApprovalGuard(this.host.approvals));
		const tools = this.host.tools
			? await this.host.tools()
			: [
					...createFileTools({
						root: this.host.workspaceRoot,
						isDirty: this.host.isDirty,
						onFileChanged: (abs, kind, stats) =>
							this.host.emit({ type: "file-changed", path: this.host.relativePath(abs), kind, ...stats }),
						onBeforeWrite: this.host.files?.onBeforeWrite,
						execCommand: this.host.files?.execCommand,
						planDir: this.host.planDir ? () => this.host.planDir! : undefined,
						onMemoryFact: this.host.memory?.onFact,
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
		// Deferred tools (browser_use, switch_environment, fetch_url) stay out of
		// the per-request schemas; the model reaches them through use_tool.
		const deferred = visible.filter((t) => DEFERRED_TOOLS.has(t.name));
		// Repo skills: index into the prompt, bodies behind load_skill.
		const skills = (
			((await this.host.files?.listSkillFiles?.().catch(() => [])) ?? []) as { path: string; content: string }[]
		).map((f) => parseSkill(f.path, f.content));
		if (skills.length) deferred.push(createLoadSkillTool(skills));
		const loaded = visible.filter((t) => !DEFERRED_TOOLS.has(t.name));
		// aroundTool listeners wrap the tool body at registration time — the
		// agent loop exposes before/after hooks but no around-execution hook.
		const wrapAround = (list: AgentTool<any, string>[]): AgentTool<any, string>[] =>
			list.map((t) =>
				t.execute
					? {
							...t,
							execute: (input: any, ctx: Parameters<NonNullable<typeof t.execute>>[1]) =>
								pipeline.runAround({ name: t.name, input }, async () => t.execute!(input, ctx)),
						}
					: t,
			);
		return new Agent({
			providerId: settings.providerId,
			modelId: settings.modelId,
			apiKey: settings.apiKey,
			baseUrl: settings.baseUrl || undefined,
			systemPrompt: buildSystemPrompt(
				this.host.workspaceRoot,
				mode,
				(await this.host.memory?.context?.(task, settings)) ?? "",
				this.host.environment,
				skillsIndex(skills),
			),
			tools: wrapAround([
				...execTools(loaded),
				...(deferred.length ? [createDispatchTool(deferred)] : []),
				createExploreTool({
					settings,
					tools: visible,
					onEvent: (text) => this.host.emit({ type: "info", text }),
				}),
				...(this.host.recall?.enabled === false
					? []
					: execTools([createRecallTool({ priorTranscripts: this.host.recall?.transcripts, scorer: this.host.recall?.scorer })])),
			]),
			maxIterations: settings.maxIterations,
			...(settings.maxTokens ? { modelOptions: { maxTokens: settings.maxTokens } } : {}),
			toolExecution: "sequential",
			prepareTurn: createPrepareTurn({
				contextWindow: settings.contextWindow,
				contextBudget: this.contextBudget,
				budgetRef: this.budgetRef,
				forceCompactRef: this.forceCompactRef,
				maxTokens: settings.maxTokens,
				providerId: settings.providerId,
				modelId: settings.modelId,
				summarize: settings.baseUrl
					? (messages) => summarizeMessages(settings, messages)
					: undefined,
				onCompact: (s) => {
					this.host.log?.("agent", `compaction ${JSON.stringify(s)}`);
					this.host.events?.record({ type: "compaction", stats: s });
				},
			}),
			...(initialMessages?.length ? { initialMessages } : {}),
			hooks: {
				beforeTool: async ({ tool, input }) => {
					const verdict = await pipeline.runPre({ name: tool.name, input });
					if (verdict.kind === "deny") return { skip: true, reason: verdict.reason };
					if (verdict.kind === "ask") {
						// Chain tail with no approval resolution — same as a denial.
						return { skip: true, reason: "This action needs approval but no approval channel answered." };
					}
					return undefined;
				},
				afterTool: async ({ tool, input, result }) => {
					const out = await pipeline.runPost({ name: tool.name, input }, result);
					return out === result ? undefined : { result: out };
				},
				onEvent: (event) => this.forward(event),
			},
		});
	}

	private forward(event: AgentRuntimeEvent): void {
		switch (event.type) {
			// Canonical transcript commits → durable record. message-added covers
			// user inputs and tool-result messages; assistant-message covers the
			// model's replies (dedupe by id in deriveMessages).
			case "message-added":
			case "assistant-message":
				this.host.events?.record({ type: "agent-message", message: omitImageParts([event.message])[0] });
				break;
		}
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
					name: event.toolCall.toolName,
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
