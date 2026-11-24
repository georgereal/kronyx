/**
 * OpenAI-compatible execution engine (vscode-free). A parallel path to the
 * Cline SDK runner: same RunnerHost, same tool set, same policy pipeline, same
 * RunViewEvent stream — only the model transport differs.
 *
 * - `openai` provider → Responses API: each turn chains off the previous
 *   response (`previous_response_id`, `store: true`) and sends only the
 *   messages added since; server-side compaction handles long chains.
 * - other OpenAI-compatible providers → stateless chat completions with the
 *   full local history, projected through the same prepareTurn compaction.
 *
 * The local mirror (`mirror`) is always the canonical transcript: it feeds
 * the durable event log, recall_context, transcripts, and any non-chained
 * request.
 */

import { randomUUID } from "node:crypto";
import type { AgentMessage, AgentRuntimePrepareTurnContext, AgentToolResultPart } from "@cline/shared";
import type { AgentEngine } from "./engine";
import { clampResult, contextBudget, createPrepareTurn, sanitizeMessages } from "./compaction";
import { classifyRunError } from "./errorKind";
import { isConversationalTask } from "./taskGuard";
import { imageAttachmentParts, omitImageParts, stringify, summarizeMessages, WRITE_MODES, type ProviderSettings, type RunDigest, type RunnerAttachment, type RunnerHost } from "./runner";
import { assembleToolSet, type ToolSet } from "./toolSet";
import {
	chatBody,
	endpointFor,
	postStream,
	protocolFor,
	reduceChat,
	reduceResponses,
	responsesBody,
	sseEvents,
	toChatMessages,
	toResponsesInput,
	type ToolCallOut,
	type TurnOutcome,
	zeroUsage,
} from "./openaiWire";

const MAX_DIGESTS = 3;
const INTERRUPTED = "[interrupted — the run was stopped before this tool returned]";

type Chain = { responseId: string; from: number };
type Verdict = { ok: true; value: unknown } | { ok: false; error: string };

const parseArgs = (args: string): Verdict => {
	if (!args.trim()) return { ok: true, value: {} };
	try {
		return { ok: true, value: JSON.parse(args) };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
};

export class OpenAIEngine implements AgentEngine {
	/** Canonical local transcript for this engine instance. */
	private mirror: AgentMessage[] = [];
	/** Responses chain: server holds everything up to `responseId`; `from` is where the unsent delta starts. */
	private chain: Chain | undefined;
	private running = false;
	private stopRequested = false;
	private paused: { limit: number; iterations: number; text: string } | undefined;
	private abort: AbortController | undefined;
	private task = "";
	private digests: RunDigest[] = [];
	private stateNote: string | undefined;
	/** Set once the durable log has been considered for this instance (never re-read over a cleared context). */
	private seeded = false;
	private forceCompactRef = { current: false };
	private budgetRef = { current: 0 };
	private budget: number | undefined;
	private prepare: ReturnType<typeof createPrepareTurn> | undefined;
	private prepareKey = "";
	private totals = zeroUsage();
	private lastInputTokens: number | undefined;
	private runIterations = 0;
	private runToolCalls = 0;
	private lastText = "";

	constructor(private readonly host: RunnerHost) {}

	get isRunning(): boolean {
		return this.running;
	}

	get isPaused(): boolean {
		return this.paused !== undefined;
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

	setStateNote(note: string | undefined): void {
		this.stateNote = note;
	}

	reset(): void {
		this.abort?.abort("reset");
		this.mirror = [];
		this.chain = undefined;
		this.lastInputTokens = undefined;
		this.paused = undefined;
		this.digests = [];
		this.stateNote = undefined;
		this.seeded = false;
		this.totals = zeroUsage();
	}

	stop(): void {
		this.stopRequested = true;
		this.abort?.abort("Stopped by user");
		if (this.paused) this.endPaused();
	}

	private endPaused(): void {
		const paused = this.paused;
		this.paused = undefined;
		this.host.emit({ type: "run-finished", status: "stopped", text: paused?.text || "Stopped by user", iterations: paused?.iterations ?? 0 });
	}

	/** Next request drops the chain and runs the local compaction pass. */
	requestCompact(): boolean {
		if (!this.running) return false;
		this.forceCompactRef.current = true;
		this.host.emit({ type: "info", text: "Context compaction requested — applies on the next model turn." });
		return true;
	}

	clearContext(): boolean {
		if (this.running || this.paused || !this.mirror.length) return false;
		this.mirror = [];
		this.chain = undefined;
		this.host.emit({ type: "info", text: "Context cleared — the next task starts fresh, carrying run summaries forward." });
		return true;
	}

	async run(task: string, settings: ProviderSettings, attachments?: RunnerAttachment[], displayTask?: string): Promise<void> {
		if (this.running) throw new Error("A run is already in progress.");
		this.running = true;
		this.paused = undefined;
		this.task = task;
		this.runIterations = 0;
		this.runToolCalls = 0;
		this.lastText = "";
		this.budget = contextBudget(settings.contextWindow);
		this.host.emit({ type: "run-started", task: displayTask ?? task });
		this.abort = new AbortController();
		try {
			if (this.stopRequested) {
				this.host.emit({ type: "run-finished", status: "stopped", text: "Stopped by user", iterations: 0 });
				return;
			}
			await this.initialize();
			if (this.stateNote) {
				this.record({ id: `state-${Date.now()}`, role: "user", content: [{ type: "text", text: this.stateNote }], createdAt: Date.now() });
				this.stateNote = undefined;
			}
			const images = imageAttachmentParts(attachments);
			this.record({
				id: `task-${Date.now()}`,
				role: "user",
				content: [{ type: "text", text: task }, ...images],
				createdAt: Date.now(),
			});
			await this.loop(settings, settings.maxIterations);
		} catch (error) {
			this.fail(error);
		} finally {
			this.stopRequested = false;
			this.running = false;
			this.abort = undefined;
			this.host.transcripts?.save(omitImageParts(this.mirror));
		}
	}

	/** Continue a paused run on the same transcript with a fresh step budget. */
	async resume(settings?: ProviderSettings): Promise<void> {
		if (this.running) return;
		if (!this.paused || !settings) {
			this.fail("Nothing to continue — start a new task.");
			return;
		}
		const limit = this.paused.limit;
		this.running = true;
		this.paused = undefined;
		this.runIterations = 0;
		this.runToolCalls = 0;
		this.host.emit({ type: "info", text: `Continuing — another ${limit} steps` });
		this.abort = new AbortController();
		try {
			await this.loop(settings, limit);
		} catch (error) {
			this.fail(error);
		} finally {
			this.stopRequested = false;
			this.running = false;
			this.abort = undefined;
			this.host.transcripts?.save(omitImageParts(this.mirror));
		}
	}

	/**
	 * Start-of-run history: a cold instance restores the durable log once; an
	 * empty transcript after a clear carries run digests forward instead.
	 */
	private async initialize(): Promise<void> {
		if (!this.seeded) {
			this.seeded = true;
			const resumed = await this.host.resume?.resumeLog?.();
			if (resumed?.length) {
				this.mirror = sanitizeMessages(resumed).messages;
				this.host.events?.record({ type: "resumed-from-log", messages: resumed.length });
			}
		}
		if (this.mirror.length || !this.digests.length) return;
		const text = this.digests
			.map((d, i) => {
				const files = d.filesChanged.length ? ` Files changed: ${d.filesChanged.join(", ")}.` : "";
				return `${i + 1}) Task: ${d.task} — ${d.status}. Summary: ${d.summary.slice(0, 800)}.${files}`;
			})
			.join("\n");
		this.record({
			id: `seed-${Date.now()}`,
			role: "user",
			content: [
				{
					type: "text",
					text: `Earlier work in this session (oldest first):\n${text}\nUse this as context for the next task; file contents on disk are the source of truth — re-read them as needed.`,
				},
			],
			createdAt: Date.now(),
		});
	}

	private record(message: AgentMessage): void {
		this.mirror.push(message);
		this.host.events?.record({ type: "agent-message", message: omitImageParts([message])[0] });
	}

	private fail(error: unknown): void {
		const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
		if (this.stopRequested || this.abort?.signal.aborted) {
			this.host.emit({ type: "run-finished", status: "stopped", text: this.lastText, iterations: this.runIterations });
			return;
		}
		const { errorKind, retryable } = classifyRunError(message);
		this.host.emit({ type: "run-failed", error: message, errorKind, retryable });
	}

	private async loop(settings: ProviderSettings, limit: number): Promise<void> {
		const ts = await assembleToolSet(this.host, settings, this.task, () => this.stop());
		this.ensurePrepare(settings);
		let nudged = false;
		for (;;) {
			if (this.abort?.signal.aborted) {
				this.host.emit({ type: "run-finished", status: "stopped", text: this.lastText, iterations: this.runIterations });
				return;
			}
			if (this.runIterations >= limit) {
				this.paused = { limit, iterations: this.runIterations, text: this.lastText };
				this.host.emit({ type: "run-paused", iterations: this.runIterations, limit, text: this.lastText });
				return;
			}
			this.runIterations++;
			const turn = await this.requestTurn(settings, ts, this.runIterations);
			const content: AgentMessage["content"] = [
				...(turn.reasoning.trim() ? [{ type: "reasoning" as const, text: turn.reasoning }] : []),
				...(turn.text ? [{ type: "text" as const, text: turn.text }] : []),
				...turn.calls.map((c) => {
					const args = parseArgs(c.args);
					return { type: "tool-call" as const, toolCallId: c.callId, toolName: c.name, input: args.ok ? args.value : {} };
				}),
			];
			this.record({ id: `asst-${randomUUID()}`, role: "assistant", content, createdAt: Date.now() });
			this.chain = turn.responseId && protocolFor(settings.providerId) === "responses" ? { responseId: turn.responseId, from: this.mirror.length } : undefined;
			this.emitTurn(turn);
			if (turn.text) this.lastText = turn.text;
			if (!turn.calls.length) {
				if (!this.runToolCalls && !nudged && WRITE_MODES.has(this.host.currentMode()) && !isConversationalTask(this.task)) {
					nudged = true;
					this.host.emit({ type: "info", text: "Finished without using any tools — nudging the agent to proceed." });
					this.record({
						id: `nudge-${Date.now()}`,
						role: "user",
						content: [
							{
								type: "text",
								text:
									"You ended the run without calling any tools or changing files. " +
									"If the task asks for implementation or exploration, do it now using your tools. " +
									"If you are blocked on something only the user can provide, state exactly what is missing.",
							},
						],
						createdAt: Date.now(),
					});
					continue;
				}
				this.host.emit({ type: "run-finished", status: "completed", text: this.lastText, iterations: this.runIterations });
				return;
			}
			this.runToolCalls += turn.calls.length;
			const results = await this.runBatch(turn.calls, ts);
			this.record({ id: `tool-${randomUUID()}`, role: "tool", content: results, createdAt: Date.now() });
		}
	}

	private ensurePrepare(settings: ProviderSettings): void {
		const key = `${settings.providerId}|${settings.modelId}|${settings.contextWindow ?? ""}`;
		if (this.prepare && this.prepareKey === key) return;
		this.prepareKey = key;
		this.budgetRef.current = this.budget ?? 0;
		this.prepare = createPrepareTurn({
			contextWindow: settings.contextWindow,
			contextBudget: this.budget,
			budgetRef: this.budgetRef,
			forceCompactRef: this.forceCompactRef,
			maxTokens: settings.maxTokens,
			providerId: settings.providerId,
			modelId: settings.modelId,
			summarize: settings.baseUrl ? (messages) => summarizeMessages(settings, messages) : undefined,
			onCompact: (s) => {
				this.host.log?.("agent", `compaction ${JSON.stringify(s)}`);
				this.host.events?.record({ type: "compaction", stats: s });
			},
		});
	}

	/** Local projection of the transcript (compaction + clamps) for non-chained requests. */
	private async projected(settings: ProviderSettings, ts: ToolSet, iteration: number): Promise<readonly AgentMessage[]> {
		const ctx: AgentRuntimePrepareTurnContext = {
			agentId: "openai-engine",
			iteration,
			messages: this.mirror,
			systemPrompt: ts.systemPrompt,
			tools: ts.tools,
			model: { id: settings.modelId, provider: settings.providerId },
			signal: this.abort?.signal,
			previousRequestInputTokens: this.lastInputTokens,
		};
		return (await this.prepare?.(ctx))?.messages ?? this.mirror;
	}

	private async requestTurn(settings: ProviderSettings, ts: ToolSet, iteration: number): Promise<TurnOutcome> {
		const protocol = protocolFor(settings.providerId);
		const url = endpointFor(protocol, settings.baseUrl);
		if (this.forceCompactRef.current) this.chain = undefined;
		const send = async (chain: Chain | undefined): Promise<TurnOutcome> => {
			const body =
				protocol === "responses"
					? responsesBody({
							model: settings.modelId,
							instructions: ts.systemPrompt,
							input: toResponsesInput(chain ? this.mirror.slice(chain.from) : await this.projected(settings, ts, iteration)),
							tools: ts.tools,
							previousResponseId: chain?.responseId,
							maxOutputTokens: settings.maxTokens,
							compactThreshold: this.budget ? Math.max(1000, this.budget) : undefined,
						})
					: chatBody({
							model: settings.modelId,
							messages: toChatMessages(ts.systemPrompt, await this.projected(settings, ts, iteration)),
							tools: ts.tools,
							maxTokens: settings.maxTokens,
						});
			const stream = await postStream(url, settings.apiKey, body, this.abort?.signal);
			const hooks = {
				onText: (text: string) => this.host.emit({ type: "assistant-delta", text }),
				onReasoning: (text: string) => this.host.emit({ type: "reasoning-delta", text }),
			};
			return protocol === "responses" ? reduceResponses(sseEvents(stream), hooks) : reduceChat(sseEvents(stream), hooks);
		};
		let outcome: TurnOutcome;
		try {
			outcome = await send(this.chain);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!this.chain || !/previous_response|response.*not found|no response/i.test(message)) throw error;
			this.chain = undefined;
			this.host.emit({ type: "info", text: "The provider no longer has the previous response — resending the full history." });
			outcome = await send(undefined);
		}
		this.lastInputTokens = outcome.usage.inputTokens;
		return outcome;
	}

	private emitTurn(turn: TurnOutcome): void {
		const iteration = this.runIterations;
		if (turn.reasoning.trim()) this.host.emit({ type: "reasoning", iteration, text: turn.reasoning });
		if (turn.text.trim()) this.host.emit({ type: "assistant-text", iteration, text: turn.text });
		const u = turn.usage;
		this.totals = {
			inputTokens: this.totals.inputTokens + u.inputTokens,
			outputTokens: this.totals.outputTokens + u.outputTokens,
			cachedTokens: this.totals.cachedTokens + u.cachedTokens,
			reasoningTokens: this.totals.reasoningTokens + u.reasoningTokens,
		};
		this.host.emit({
			type: "usage",
			inputTokens: this.totals.inputTokens,
			outputTokens: this.totals.outputTokens,
			cacheReadTokens: this.totals.cachedTokens,
			cacheWriteTokens: 0,
			reasoningTokens: this.totals.reasoningTokens,
			iteration,
			contextMsgs: this.mirror.length,
			requestTokens: u.inputTokens,
			contextBudget: this.budgetRef.current,
		});
		if (turn.incomplete) this.host.emit({ type: "info", text: `Model output stopped early (${turn.incomplete}).` });
	}

	/** Runs one model batch with the Cline batch rule: adjacent parallel calls concurrently, sequential calls as ordered boundaries. */
	private async runBatch(calls: ToolCallOut[], ts: ToolSet): Promise<AgentToolResultPart[]> {
		const modeOf = (name: string) => ts.tools.find((t) => t.name === name)?.executionMode ?? "sequential";
		const results: (AgentToolResultPart | undefined)[] = new Array(calls.length);
		let i = 0;
		while (i < calls.length) {
			if (modeOf(calls[i].name) === "parallel") {
				let j = i;
				while (j < calls.length && modeOf(calls[j].name) === "parallel") j++;
				await Promise.all(calls.slice(i, j).map(async (c, k) => (results[i + k] = await this.runTool(c, ts))));
				i = j;
			} else {
				results[i] = await this.runTool(calls[i], ts);
				i++;
			}
		}
		return calls.map((c, k) => results[k] ?? { type: "tool-result", toolCallId: c.callId, toolName: c.name, output: INTERRUPTED, isError: true });
	}

	private async runTool(call: ToolCallOut, ts: ToolSet): Promise<AgentToolResultPart | undefined> {
		if (this.abort?.signal.aborted) return undefined;
		const started = Date.now();
		const parsed = parseArgs(call.args);
		const input = parsed.ok ? parsed.value : call.args;
		const iteration = this.runIterations;
		this.host.emit({ type: "tool-started", id: call.callId, name: call.name, input, iteration });
		const done = (output: string, ok: boolean): AgentToolResultPart => {
			this.host.emit({ type: "tool-finished", id: call.callId, name: call.name, ok, output: stringify(output), durationMs: Date.now() - started, iteration });
			return { type: "tool-result", toolCallId: call.callId, toolName: call.name, output, isError: !ok };
		};
		if (!parsed.ok) return done(`Tool call rejected: invalid JSON arguments (${parsed.error}). Resend the call with valid JSON.`, false);
		const tool = ts.tools.find((t) => t.name === call.name);
		if (!tool?.execute) return done(`Tool "${call.name}" is not available in this run.`, false);
		const verdict = await ts.pipeline.runPre({ name: tool.name, input });
		if (verdict.kind === "deny") return done(verdict.reason, false);
		if (verdict.kind === "ask") return done("This action needs approval but no approval channel answered.", false);
		try {
			const raw = await tool.execute(input, { agentId: "openai-engine", iteration: this.runIterations, toolCallId: call.callId, signal: this.abort?.signal });
			const out = await ts.pipeline.runPost({ name: tool.name, input }, raw);
			const text = typeof out === "string" ? out : JSON.stringify(out ?? "");
			const clamped = clampResult({ type: "tool-result", toolCallId: call.callId, toolName: call.name, output: text });
			return done(clamped ? String(clamped.output) : text, true);
		} catch (error) {
			return done(error instanceof Error ? error.message : String(error), false);
		}
	}
}
