/**
 * AgentEngine facade over the harness loop (vscode-free). This is the single
 * execution-engine implementation for hosts that still speak the legacy
 * AgentEngine surface (cloud worker, evals). Session continuity, compaction,
 * recovery and provider lifecycles come from the harness event ledger — the
 * facade only adapts construction and control methods.
 */

import type { AgentEngine } from "../agent/engine";
import { isConversationalTask } from "../agent/taskGuard";
import { assembleToolSet } from "../agent/toolSet";
import type { ProviderSettings, RunDigest, RunnerAttachment, RunnerHost } from "../agent/types";
import { WRITE_MODES } from "../agent/types";
import type { EventLog } from "./core/eventLog";
import type { VerifierPort } from "./core/contracts";
import type { ExecutionStateStore } from "../context/contracts/ports";
import type { EmbeddingProvider, KnowledgeRecord, KnowledgeStore } from "../context/knowledge/record";
import type { HarnessLoop, RunOutcome } from "./core/loop";
import { runHarness } from "./core/runner";
import { createModelAdapter, type TransportKind } from "./adapters";
import { resolveBehaviorProfile } from "./behaviors";
import { createHarnessToolPort } from "./tools/toolPort";
import { withRecall, type RunSearch } from "./tools/recall";
import { withExplore } from "./tools/explore";
import { withReadCache } from "./tools/readCache";
import { withBatchReads } from "./tools/batchReads";

const LEGACY_TRANSCRIPT_BUDGET = 12_000;
const LEGACY_PART_BUDGET = 600;

function clipLegacy(text: string, max = LEGACY_PART_BUDGET): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function legacyPartText(part: unknown): string {
	if (!part || typeof part !== "object") return "";
	const p = part as Record<string, unknown>;
	if (p.type === "text" && typeof p.text === "string") return clipLegacy(p.text);
	if (p.type === "tool-call") return `tool-call ${String(p.toolName ?? "tool")} ${clipLegacy(JSON.stringify(p.input ?? {}), 240)}`;
	if (p.type === "tool-result") {
		const out = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
		return `tool-result ${String(p.toolName ?? "tool")}${p.isError ? " (error)" : ""}: ${clipLegacy(out)}`;
	}
	if (typeof p.text === "string") return clipLegacy(p.text);
	return clipLegacy(JSON.stringify(p), 240);
}

/** Render a pre-harness AgentMessage transcript as bounded migration context.
 *  The harness cannot adopt legacy provider state verbatim (message ids and
 *  pending tool calls are transport-specific), so migration carries the facts
 *  forward as context and continues through the harness as the single path. */
export async function legacyTranscriptContext(host: RunnerHost): Promise<string | undefined> {
	const messages = await host.resume?.resumeLog?.().catch(() => undefined);
	if (!messages?.length) return undefined;
	const lines: string[] = [];
	let used = 0;
	for (const [index, message] of messages.entries()) {
		const content = Array.isArray(message.content) ? message.content.map(legacyPartText).filter(Boolean).join(" | ") : typeof message.content === "string" ? clipLegacy(message.content) : "";
		if (!content) continue;
		const line = `${index + 1}. ${message.role}: ${content}`;
		if (used + line.length > LEGACY_TRANSCRIPT_BUDGET) {
			lines.push(`… ${messages.length - index} messages omitted for migration budget …`);
			break;
		}
		lines.push(line);
		used += line.length;
	}
	if (!lines.length) return undefined;
	return [
		"Pre-harness execution transcript migration",
		"This session/run was interrupted before the harness migration. Treat the transcript below as prior work already performed in this same workspace; do not repeat completed investigation or edits blindly. Continue from its latest state.",
		lines.join("\n"),
	].join("\n\n");
}


/** Search pre-harness run transcripts through the recall seam. New harness runs
 *  are represented by closeout knowledge; this keeps pre-cutover cloud/IDE run
 *  memory reachable without keeping a legacy execution path. */
function legacyRunSearch(host: RunnerHost): RunSearch | undefined {
	if (!host.recall?.transcripts) return undefined;
	return async (query, filter) => {
		const transcripts = host.recall?.transcripts?.() ?? [];
		const chunks: { label: string; text: string; runLabel: string }[] = [];
		for (const transcript of transcripts) {
			for (const [index, message] of transcript.messages.entries()) {
				const content = Array.isArray(message.content) ? message.content.map(legacyPartText).filter(Boolean).join("\n") : typeof message.content === "string" ? clipLegacy(message.content, 1200) : "";
				if (!content.trim()) continue;
				chunks.push({ label: `${transcript.label} · ${message.role} ${index + 1}`, text: content, runLabel: transcript.label });
			}
		}
		const filtered = chunks.filter((chunk) => {
			if (filter.runId && !chunk.runLabel.includes(filter.runId) && !filter.runId.startsWith(chunk.runLabel.replace(/^run\s+/, ""))) return false;
			if (filter.task && !`${chunk.label}\n${chunk.text}`.toLowerCase().includes(filter.task.toLowerCase())) return false;
			return true;
		});
		if (!filtered.length) return [];
		const ranked = host.recall?.scorer
			? await host.recall.scorer(query, filtered.map((chunk, idx) => ({ idx, role: chunk.label, text: chunk.text }))).catch(() => undefined)
			: undefined;
		if (ranked?.length) {
			return ranked.slice(0, 5).map((hit) => ({
				label: filtered[hit.idx]!.label,
				text: filtered[hit.idx]!.text.slice(0, 1800),
				score: hit.score,
			}));
		}
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		return filtered
			.map((chunk) => ({ chunk, score: terms.reduce((n, term) => n + (chunk.text.toLowerCase().includes(term) ? 1 : 0), 0) / Math.max(1, terms.length) }))
			.filter((hit) => hit.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, 5)
			.map((hit) => ({ label: hit.chunk.label, text: hit.chunk.text.slice(0, 1800), score: hit.score }));
	};
}

export interface HarnessAgentEngineOptions {
	host: RunnerHost;
	log: EventLog;
	/** Harness run id for run(); resume() may override it with the paused run's id. */
	runId: string;
	sessionId: string;
	verifier?: VerifierPort;
	transport?: TransportKind;
	debug?: boolean;
	knowledgeStore?: KnowledgeStore;
	knowledgeScope?: KnowledgeRecord["scope"];
	knowledgeEmbedder?: EmbeddingProvider;
	executionStateStore?: ExecutionStateStore;
}

export class HarnessAgentEngine implements AgentEngine {
	private running = false;
	private stopped = false;
	private pausedRun = false;
	private activeLoop: HarnessLoop | undefined;
	private readonly digests: RunDigest[] = [];
	private stateNote: string | undefined;
	private seededLegacyState = false;
	private pendingClear: Promise<unknown> | undefined;

	constructor(private readonly opts: HarnessAgentEngineOptions) {}

	/** Warm cloud hosts reuse the facade across jobs; the durable lane is the
	 *  session, while each run/continuation gets its own harness run id. */
	setRunId(runId: string): void {
		this.opts.runId = runId;
	}

	get isRunning(): boolean {
		return this.running;
	}

	get isPaused(): boolean {
		return this.pausedRun;
	}

	get runDigests(): readonly RunDigest[] {
		return this.digests;
	}

	addRunDigest(digest: RunDigest): void {
		this.digests.push(digest);
		if (this.digests.length > 3) this.digests.shift();
	}

	setRunDigests(digests: RunDigest[]): void {
		this.digests.splice(0, this.digests.length, ...digests.slice(-3));
	}

	setStateNote(note: string | undefined): void {
		this.stateNote = note;
	}

	stop(): void {
		this.stopped = true;
		this.activeLoop?.stop();
	}

	reset(): void {
		this.stop();
		this.digests.length = 0;
		this.stateNote = undefined;
		this.pausedRun = false;
	}

	requestCompact(): boolean {
		return this.activeLoop?.requestCompact() ?? false;
	}

	/** Durable clear: the next replay starts after this event. Async append is
	 *  fire-and-forget because the legacy control surface is synchronous; cloud
	 *  clear operations wait on their own session update before enqueueing work. */
	clearContext(): boolean {
		if (this.running) return false;
		this.pendingClear = this.opts.log.append({ type: "context.cleared", runId: this.opts.runId }).catch(() => undefined);
		return true;
	}

	async run(task: string, settings: ProviderSettings, attachments?: RunnerAttachment[], displayTask?: string): Promise<void> {
		if (this.running) throw new Error("A run is already in progress.");
		this.running = true;
		this.pausedRun = false;
		try {
			// Worker crash/reclaim parity with the legacy runner: if this run id
			// already has an unfinished harness run in the durable lane, continue
			// that run instead of duplicating its objective and board. New tasks
			// use fresh run ids, so presence here can only mean recovery.
			const prior = await this.opts.log.read().catch(() => []);
			const ownStatuses = prior.filter((e) => e.runId === this.opts.runId && e.type === "run.status");
			const lastStatus = ownStatuses.at(-1);
			const interrupted = lastStatus?.type === "run.status" && (lastStatus as { status?: string }).status === "running";
			const outcome = await this.runHarnessOnce(task, settings, attachments, displayTask, { resume: interrupted, runId: this.opts.runId });
			this.pausedRun = outcome.status === "paused";
		} finally {
			this.stopped = false;
			this.running = false;
			this.activeLoop = undefined;
		}
	}

	async resume(settings?: ProviderSettings, runId = this.opts.runId): Promise<void> {
		if (this.running || !settings) return;
		this.running = true;
		try {
			// Pre-cutover cloud runs have legacy run_events but no harness lane. Import
			// their facts as bounded migration context and continue through the harness —
			// there is no legacy execution fallback.
			const migrateLegacy = !(await this.hasLaneEvents(runId));
			const outcome = await this.runHarnessOnce(
				migrateLegacy
					? "Continue the interrupted task from the migrated transcript context. Re-check the workspace state before repeating work."
					: "",
				settings,
				undefined,
				undefined,
				{ resume: !migrateLegacy, runId },
			);
			this.pausedRun = outcome.status === "paused";
		} finally {
			this.stopped = false;
			this.running = false;
			this.activeLoop = undefined;
		}
	}

	/** Resume the paused harness run with a host-authored recovery instruction
	 *  as durable user input (sandbox death recovery), preserving the same run
	 *  id and task board instead of starting a parallel plan. */
	async resumeWithMessage(input: string, settings: ProviderSettings, runId = this.opts.runId): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			try {
				const outcome = await this.runHarnessOnce("", settings, undefined, undefined, { resume: true, runId, resumeInput: input });
				this.pausedRun = outcome.status === "paused";
			} catch (err) {
				// A death can race a natural completion: then there is nothing to
				// resume, so the recovery note becomes an ordinary follow-up run.
				if (!/cannot resume from/i.test(err instanceof Error ? err.message : String(err))) throw err;
				const outcome = await this.runHarnessOnce(input, settings, undefined, undefined, { resume: false, runId });
				this.pausedRun = outcome.status === "paused";
			}
		} finally {
			this.stopped = false;
			this.running = false;
			this.activeLoop = undefined;
		}
	}

	private async hasLaneEvents(runId: string): Promise<boolean> {
		const events = await this.opts.log.read().catch(() => []);
		return events.some((event) => event.runId === runId);
	}

	private async runHarnessOnce(
		task: string,
		settings: ProviderSettings,
		attachments: RunnerAttachment[] | undefined,
		displayTask: string | undefined,
		control: { resume: boolean; runId: string; resumeInput?: string },
	): Promise<RunOutcome> {
		if (this.pendingClear) await this.pendingClear;
		this.pendingClear = undefined;
		if (this.stopped) {
			this.opts.host.emit({ type: "run-finished", status: "stopped", text: "Stopped by user", iterations: 0 });
			return { status: "paused", reason: "stopped", phases: [] };
		}
		const toolHost = control.resume && this.opts.host.memory ? { ...this.opts.host, memory: { ...this.opts.host.memory, context: undefined } } : this.opts.host;
		const assembled = await assembleToolSet(toolHost, settings, task, () => this.stop(), { repeatGuard: false });
		const model = createModelAdapter(this.opts.transport ?? settings.apiShape ?? "auto", {
			providerId: settings.providerId,
			baseUrl: settings.baseUrl,
			apiKey: settings.apiKey,
			modelId: settings.modelId,
			maxOutputTokens: settings.maxTokens,
			store: true,
			conversations: true,
			contextWindow: settings.contextWindow,
		});
		const behavior = resolveBehaviorProfile({
			providerId: settings.providerId,
			modelId: settings.modelId,
			profile: settings.profile,
			contextWindow: settings.contextWindow,
			maxOutputTokens: settings.maxTokens,
			capabilities: model.capabilities,
		});
		const basePort = createHarnessToolPort({
			tools: assembled.tools,
			hidden: new Set(),
			check: async (name, input, callId) => {
				const verdict = await assembled.pipeline.runPre({ name, input, callId });
				return verdict.kind === "allow" ? "allow" : verdict.kind === "deny" ? "deny" : "ask";
			},
			confirm: (name, input, callId) => this.opts.host.approvals?.confirm(name, input, callId) ?? Promise.resolve(false),
		});
		const retrievalScope = this.opts.knowledgeScope
			? (() => {
					const broad = { ...this.opts.knowledgeScope, sessionId: undefined, module: undefined };
					// Repo/workspace-scoped stores retrieve across sessions. A chat-only
					// scope has no enclosing workspace identity, so widening there would
					// leak across the user's unrelated sessions — keep it session-bound.
					return broad.repo || broad.repositoryId || broad.workspaceId || broad.root ? broad : { ...broad, sessionId: this.opts.knowledgeScope.sessionId };
				})()
			: undefined;
		const knowledgeRunSearch: RunSearch | undefined = this.opts.knowledgeStore && retrievalScope
			? async (query, filter) => {
					const hits = await this.opts.knowledgeStore!.query({ scope: retrievalScope, text: query, limit: 5 }).catch(() => []);
					return hits
						.filter((h) => !filter.runId || h.record.source.runId === filter.runId)
						.filter((h) => !filter.task || h.record.title.toLowerCase().includes(filter.task.toLowerCase()) || h.record.content.toLowerCase().includes(filter.task.toLowerCase()))
						.map((h) => ({
							label: `${h.record.title}${h.record.source.runId ? ` · run ${h.record.source.runId}` : ""}`,
							text: h.chunk?.text ?? h.record.content,
							score: h.score ?? 0,
						}));
				}
			: undefined;
		const transcriptRunSearch = legacyRunSearch(this.opts.host);
		const runSearch: RunSearch | undefined = knowledgeRunSearch || transcriptRunSearch
			? async (query, filter) => {
					const [knowledgeHits, transcriptHits] = await Promise.all([
						knowledgeRunSearch?.(query, filter).catch(() => undefined),
						transcriptRunSearch?.(query, filter).catch(() => undefined),
					]);
					return [...(knowledgeHits ?? []), ...(transcriptHits ?? [])].sort((a, b) => b.score - a.score).slice(0, 5);
				}
			: undefined;
		const toolPort = withRecall(
			withExplore(withReadCache(withBatchReads(basePort)), model),
			this.opts.log,
			this.opts.host.recall?.scorer,
			runSearch,
		);
		const images = (attachments ?? []).flatMap((a) =>
			a.data?.byteLength && a.mediaType.startsWith("image/") ? [{ mediaType: a.mediaType, base64: Buffer.from(a.data).toString("base64") }] : [],
		);
		const contextParts: string[] = [];
		const ledgerHasEvents = (await this.opts.log.read().catch(() => [])).length > 0;
		if (!ledgerHasEvents) {
			const legacyMigration = await legacyTranscriptContext(this.opts.host);
			if (legacyMigration) contextParts.push(legacyMigration);
		}
		if (!this.seededLegacyState && !ledgerHasEvents && this.digests.length) {
			contextParts.push(
				`Earlier work in this session (legacy digest migration, oldest first):\n${this.digests
					.map((d, i) => `${i + 1}) Task: ${d.task} — ${d.status}. Summary: ${d.summary.slice(0, 800)}.${d.filesChanged.length ? ` Files changed: ${d.filesChanged.join(", ")}.` : ""}`)
					.join("\n")}\nUse this as context; current files are the source of truth.`,
			);
		}
		if (!this.seededLegacyState && this.stateNote) contextParts.push(this.stateNote);
		this.seededLegacyState = true;
		this.stateNote = undefined;
		const outcome = await runHarness(
			{
				runId: control.runId,
				sessionId: this.opts.sessionId,
				log: this.opts.log,
				model,
				behavior,
				tools: toolPort,
				...(this.opts.verifier ? { verifier: this.opts.verifier } : {}),
				emit: (e) => {
					// Legacy cloud/eval surfaces expect the distinct run-paused card;
					// the harness itself reports paused as a run-finished status.
					if (e.type === "run-finished" && e.status === "paused") {
						this.opts.host.emit({ type: "run-paused", iterations: e.iterations, limit: settings.maxIterations, text: e.text });
					} else {
						this.opts.host.emit(e);
					}
				},
				system: assembled.systemPrompt,
				nudgeWrites: WRITE_MODES.has(this.opts.host.currentMode()),
				writable: () => WRITE_MODES.has(this.opts.host.currentMode()),
				limits: { maxTurns: settings.maxIterations },
				...(this.opts.knowledgeStore ? { knowledgeStore: this.opts.knowledgeStore, ...(this.opts.knowledgeScope ? { knowledgeScope: this.opts.knowledgeScope } : {}), ...(this.opts.knowledgeEmbedder ? { knowledgeEmbedder: this.opts.knowledgeEmbedder } : {}) } : {}),
				...(this.opts.executionStateStore ? { executionStateStore: this.opts.executionStateStore } : {}),
				debug: this.opts.debug,
				onLoop: (loop) => {
					this.activeLoop = loop;
				},
			},
			task,
			displayTask,
			{
				resume: control.resume,
				...(control.resumeInput ? { resumeInput: control.resumeInput } : {}),
				...(contextParts.length ? { context: contextParts.join("\n\n") } : {}),
				images,
				plan: !control.resume && !isConversationalTask(task),
			},
		);
		return outcome;
	}
}
