import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { dbg, swallow } from "../lib/log";
import { AgentRunner, type AgentMode, type ProviderSettings, type RunViewEvent } from "../../../src/agent/runner";
import { getProvider, type ProviderCreds, type SandboxHandle } from "../../../src/sandbox/provider";
import { SandboxCore, openPr } from "../../../src/sandbox/sandboxCore";
import { createRemoteFileTools } from "../../../src/tools/remoteFileTools";
import { installationToken } from "../lib/githubApp";
import { fetchModels } from "../lib/models";
import { recordSandboxEvent } from "../lib/sandboxEvents";
import { githubPat, loadUserSettings, resolveProvider, type UserSettings } from "./settings";
import type { RunSink } from "./events";
import type { AgentMessage } from "@cline/shared";
import type { PriorTranscript } from "../../../src/agent/recall";
import {
	loadTranscripts,
	memoryWriteTool,
	recordDigests,
	saveTranscript,
	searchMemories,
	sessionMemoryContext,
	type ContextManifest,
	type EmbedProvider,
} from "./memory";

const REPO_DIR = "/home/user/repo";
const PLAN_DIR = "/home/user/.kronyx/plans";
const ATTACH_DIR = ".kronyx/attachments";
const INLINE_TEXT_LIMIT = 20 * 1024;
const TEXT_EXT = /\.(txt|md|markdown|ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|py|go|rs|java|c|cc|cpp|h|hpp|cs|rb|php|sh|css|html|xml|sql|env|ini|cfg|log)$/i;

export interface CloudJob {
	jobId: string;
	uid: string;
	sessionId: string;
	runId: string;
	task: string;
	mode: "ask" | "plan" | "agent";
	modelId?: string;
	profile?: string;
	attachmentIds?: string[];
	kind?: "run" | "push-plan" | "open-pr";
	planSlug?: string | null;
}

interface SessionDoc {
	sessionId: string;
	repo?: string;
	base?: string;
	branch?: string;
	sandboxId?: string;
	installationId?: number;
	extraRepos?: { repo: string; installationId?: number | null }[];
	template?: string | null;
	provider?: string | null;
	securityProfile?: string;
	cloned?: boolean;
	prUrl?: string;
}

export interface RunExecutor {
	run(job: CloudJob): Promise<void>;
}

const slugify = (s: string) =>
	s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "run";

/** Executor that orchestrates the agent loop on the worker with remote file tools in E2B. */
/** Live routing for a cached runner — rebound to the current run's job/sink. */
interface RunnerRoute {
	job?: CloudJob;
	sink?: RunSink;
	track?: (e: RunViewEvent) => void;
}

/**
 * Tools are built once per agent and outlive any single sandbox handle
 * (pause/resume/recreate produces a new handle each run). Calls must resolve
 * the handle *per invocation* through this slot, or they hit a ghost sandbox.
 */
interface LiveSlot {
	handle?: SandboxHandle;
}

const delegatingHandle = (live: LiveSlot): SandboxHandle => ({
	get id() {
		return live.handle?.id ?? "";
	},
	run: (command, opts) =>
		live.handle ? live.handle.run(command, opts) : Promise.reject(new Error("Sandbox handle not bound.")),
	readFile: (path) =>
		live.handle ? live.handle.readFile(path) : Promise.reject(new Error("Sandbox handle not bound.")),
	writeFile: async (path, content) => {
			if (!live.handle) throw new Error("Sandbox handle not bound.");
			return live.handle.writeFile(path, content);
		},
	setTimeout: (timeoutMs) => live.handle?.setTimeout?.(timeoutMs) ?? Promise.resolve(),
});

export class E2bOrchestratedExecutor implements RunExecutor {
	private runner: AgentRunner | undefined;
	/** Warm per-session runners: the same AgentRunner serves all runs in a session. */
	private static runnerCache = new Map<string, { runner: AgentRunner; route: RunnerRoute; live: LiveSlot }>();
	private static readonly MAX_CACHED = 20;
	private pendingSave: Promise<void> | undefined;
	private embedProvider: EmbedProvider | undefined;
	/** Per-run usage ledger for usage_events rows (web runs bypass /api/ingest). */
	private runProvider: ProviderSettings | undefined;
	private modelPricing: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined;
	private lastUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalCost: 0 };
	private lastUsageAt = 0;
	private runStartedAt = 0;
	/** process-wide: `${baseUrl}|${modelId}` → per-token pricing (null = unknown) */
	private static pricingCache = new Map<
		string,
		{ input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | null
	>();

	private async loadPricing(p: ProviderSettings): Promise<void> {
		const key = `${p.baseUrl}|${p.modelId}`;
		if (E2bOrchestratedExecutor.pricingCache.has(key)) {
			this.modelPricing = E2bOrchestratedExecutor.pricingCache.get(key) ?? undefined;
			return;
		}
		const models = await fetchModels(p.baseUrl, p.apiKey).catch(swallow("executor", "op", []));
		const pricing = models.find((m) => m.id === p.modelId)?.pricing ?? null;
		E2bOrchestratedExecutor.pricingCache.set(key, pricing);
		this.modelPricing = pricing ?? undefined;
	}

	constructor(
		private readonly db: Db,
		private readonly sink: RunSink,
	) {}

	get agentRunner(): AgentRunner | undefined {
		return this.runner;
	}

	private stopRequested = false;

	/** Stop at the next safe point: aborts a live agent AND gates setup/run phases. */
	requestStop(): void {
		this.stopRequested = true;
		this.runner?.stop();
	}

	private throwIfStopped(): void {
		if (this.stopRequested) throw new Error("Stopped by user");
	}

	/** Session-scoped runner: warm hit returns the live agent; cold start rehydrates transcripts + digests. */
	private async ensureRunner(
		job: CloudJob,
		session: SessionDoc,
		kind: "ask" | "sandboxed",
		mode: AgentMode,
		makeTools: () => Promise<import("@cline/shared").AgentTool<any, string>[]>,
	): Promise<{ runner: AgentRunner; live: LiveSlot }> {
		const key = `${job.sessionId}:${kind}`;
		const cached = E2bOrchestratedExecutor.runnerCache.get(key);
		if (cached) {
			cached.route.job = job;
			cached.route.sink = this.sink;
			cached.route.track = (e) => this.trackUsage(e, job);
			return { runner: (this.runner = cached.runner), live: cached.live };
		}
		const transcripts: PriorTranscript[] = await loadTranscripts(this.db, job.uid, job.sessionId).catch(swallow("executor", "op", []));
		const planDocs = await this.db
			.collection("plans")
			.find({ uid: job.uid, sessionId: job.sessionId })
			.project({ slug: 1 })
			.toArray();
		const planSlugs = planDocs.map((p) => String(p.slug));
		// Context manifest (ADR §9): record what rehydration actually loaded.
		const embed: EmbedProvider | undefined = this.embedProvider;
		const memories = await searchMemories(this.db, job.uid, job.sessionId, job.task, embed, session.repo ?? undefined).catch(
			swallow("executor", "op", []),
		);
		const manifest: ContextManifest = {
			contextId: randomUUID(),
			transcriptsIncluded: transcripts.map((t) => t.label),
			digestCount: (session as { digests?: unknown[] }).digests?.length ?? 0,
			memoryIdsUsed: memories.map((m) => m.memoryId),
			planSlugs,
			builtAt: new Date(),
		};
		await this.sink.patchRun({ contextManifest: manifest }).catch(swallow("executor", "op"));
		const route: RunnerRoute = { job, sink: this.sink, track: (e) => this.trackUsage(e, job) };
		const runner = new AgentRunner({
			workspaceRoot: kind === "ask" ? "(none)" : REPO_DIR,
			relativePath: (abs) => abs.replace(`${REPO_DIR}/`, ""),
			isDirty: () => false,
			confirmWrite: async () => kind !== "ask",
			currentMode: () => mode,
			planDir: kind === "ask" ? undefined : PLAN_DIR,
			memoryContext: async (task) => {
				const fresh = await this.db.collection("sessions").findOne({ uid: job.uid, sessionId: job.sessionId });
				// Cold-start already searched for this exact task — reuse it.
				const mem =
					task === job.task
						? memories
						: await searchMemories(this.db, job.uid, job.sessionId, task, embed, session.repo ?? undefined).catch(
								swallow("executor", "op", memories),
							);
				return sessionMemoryContext({ ...session, ...fresh } as SessionDoc, planSlugs, mem);
			},
			priorTranscripts: () => transcripts,
			saveTranscript: (messages: readonly AgentMessage[]) => {
				const j = route.job ?? job;
				this.pendingSave = saveTranscript(this.db, j.uid, j.sessionId, j.runId, messages).catch(swallow("executor", "op"));
			},
			environment:
				kind === "ask"
					? "a cloud chat session with no repository attached — answer from the user's message, attached files and session context"
					: "an E2B cloud sandbox",
			log: (tag, msg) => console.log(`[${tag}] ${msg}`),
			createTools: makeTools as () => Promise<never>,
			emit: (e) => {
				if (e.type !== "assistant-delta" && e.type !== "reasoning-delta") dbg("run", e.type, e);
				route.track?.(e);
				void route.sink?.emit(e);
			},
		});
		const sessionDoc = session as SessionDoc & { digests?: import("../../../src/agent/runner").RunDigest[] };
		if (sessionDoc.digests?.length) runner.setRunDigests(sessionDoc.digests);
		if (E2bOrchestratedExecutor.runnerCache.size >= E2bOrchestratedExecutor.MAX_CACHED) {
			const oldest = E2bOrchestratedExecutor.runnerCache.keys().next().value;
			if (oldest) E2bOrchestratedExecutor.runnerCache.delete(oldest);
		}
		E2bOrchestratedExecutor.runnerCache.set(key, { runner, route, live: {} });
		return { runner: (this.runner = runner), live: E2bOrchestratedExecutor.runnerCache.get(key)!.live };
	}

	/**
	 * Mirror of the extension's per-request ledger: cumulative `usage` events
	 * become delta rows in usage_events so the web Usage page sees cloud runs.
	 */
	private trackUsage(e: RunViewEvent, job: CloudJob): void {
		if (e.type === "run-started") {
			this.runStartedAt = Date.now();
			this.lastUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalCost: 0 };
			this.lastUsageAt = 0;
			return;
		}
		const p = this.runProvider;
		const record = (
			status: string,
			delta: { tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number; reasoningTokens: number; billedCost: number | null },
			durationMs: number,
			extra?: { iteration?: number; contextMsgs?: number },
		) =>
			this.recordUsageRow(job, {
				status,
				provider: p?.providerId ?? "",
				baseUrl: p?.baseUrl ?? "",
				model: p?.modelId ?? job.modelId ?? "",
				profile: p?.profile ?? job.profile ?? "",
				keyLabel: p?.profile ?? job.profile ?? "default",
				delta,
				durationMs,
				kind: "chat",
				iteration: extra?.iteration,
				contextMsgs: extra?.contextMsgs,
			});
		if (e.type === "usage") {
			const ev = e as unknown as Record<string, number>;
			const now = Date.now();
			// Counter-reset safe: a new agent (handoff) restarts totals at ~0 —
			// treat a drop as the event's own value, not a clamped 0.
			const diff = (cur: number, prev: number) => (cur >= prev ? cur - prev : cur);
			const cur = {
				inputTokens: Number(ev.inputTokens ?? 0),
				outputTokens: Number(ev.outputTokens ?? 0),
				cacheReadTokens: Number(ev.cacheReadTokens ?? 0),
				cacheWriteTokens: Number(ev.cacheWriteTokens ?? 0),
				reasoningTokens: Number(ev.reasoningTokens ?? 0),
				totalCost: Number(ev.totalCost ?? 0),
			};
			const delta = {
				tokensIn: diff(cur.inputTokens, this.lastUsage.inputTokens),
				tokensOut: diff(cur.outputTokens, this.lastUsage.outputTokens),
				cacheRead: diff(cur.cacheReadTokens, this.lastUsage.cacheReadTokens),
				cacheWrite: diff(cur.cacheWriteTokens, this.lastUsage.cacheWriteTokens),
				reasoningTokens: diff(cur.reasoningTokens, this.lastUsage.reasoningTokens),
				billedCost: Number(ev.totalCost) > 0 || this.lastUsage.totalCost > 0 ? diff(cur.totalCost, this.lastUsage.totalCost) : null,
			};
			this.lastUsage = cur;
			void record("ok", delta, this.lastUsageAt ? now - this.lastUsageAt : now - this.runStartedAt, {
				iteration: ev.iteration,
				contextMsgs: ev.contextMsgs,
			});
			this.lastUsageAt = now;
		} else if (e.type === "run-failed" && (this.lastUsageAt || this.runStartedAt)) {
			void record("failed", { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, billedCost: null }, Date.now() - (this.lastUsageAt || this.runStartedAt));
		}
	}

	private usageSeq = 0;

	/** EmbedProvider wired to record each embeddings call as a usage row. */
	private embedProviderFor(job: CloudJob, p: ProviderSettings): EmbedProvider {
		return {
			baseUrl: p.baseUrl,
			apiKey: p.apiKey,
			onUsage: (u) =>
				this.recordUsageRow(job, {
					status: u.ok ? "ok" : "failed",
					provider: p.providerId,
					baseUrl: p.baseUrl,
					model: u.model,
					profile: p.profile ?? job.profile ?? "",
					keyLabel: p.profile ?? job.profile ?? "default",
					delta: { tokensIn: u.tokensIn, tokensOut: 0, cacheRead: 0, cacheWrite: 0 },
					durationMs: u.durationMs,
					kind: "embedding",
					op: u.op,
				}),
		};
	}

	/** Insert one usage_events row — unique clientRowId satisfies the sparse index. */
	private recordUsageRow(
		job: CloudJob,
		fields: {
			status: string;
			provider: string;
			baseUrl: string;
			model: string;
			profile: string;
			keyLabel: string;
			delta: { tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number; reasoningTokens?: number; billedCost?: number | null };
			durationMs: number;
			kind: "chat" | "embedding";
			op?: string;
			iteration?: number;
			contextMsgs?: number;
		},
	): void {
		const { delta } = fields;
		void this.db
			.collection("usage_events")
			.insertOne({
				uid: job.uid,
				deviceId: "web",
				clientRowId: `${job.runId}:${++this.usageSeq}`,
				at: new Date(),
				status: fields.status,
				provider: fields.provider,
				baseUrl: fields.baseUrl,
				model: fields.model,
				profile: fields.profile,
				keyLabel: fields.keyLabel,
				kind: fields.kind,
				op: fields.op ?? "",
				device: "web",
				tokensIn: delta.tokensIn,
				tokensOut: delta.tokensOut,
				cacheRead: delta.cacheRead,
				cacheWrite: delta.cacheWrite,
				reasoningTokens: delta.reasoningTokens ?? 0,
				billedCostUsd: delta.billedCost ?? null,
				iteration: fields.iteration ?? null,
				contextMsgs: fields.contextMsgs ?? null,
				costUsd: this.modelPricing
					? delta.tokensIn * (this.modelPricing.input ?? 0) +
						delta.tokensOut * (this.modelPricing.output ?? 0) +
						delta.cacheRead * (this.modelPricing.cacheRead ?? this.modelPricing.input ?? 0) +
						delta.cacheWrite * (this.modelPricing.cacheWrite ?? this.modelPricing.input ?? 0)
					: null,
				durationMs: fields.durationMs,
				session: job.sessionId,
				task: job.task,
				workspace: "",
				runId: job.runId,
				ingestedAt: new Date(),
			})
			.catch(swallow("usage", "insert"));
	}

	/** Persist transcript + digests after a run. */
	private async afterRun(job: CloudJob): Promise<void> {
		await this.pendingSave?.catch(swallow("executor", "op"));
		// Events must land before terminal status — SSE reads run status to close.
		await this.sink.drain().catch(swallow("executor", "op"));
		if (this.runner?.runDigests.length) {
			const digests = this.runner.runDigests.map((d) => ({ ...d, runId: job.runId }));
			await recordDigests(this.db, job.uid, job.sessionId, digests).catch(swallow("executor", "op"));
		}
	}

	async run(job: CloudJob): Promise<void> {
		const settings = await loadUserSettings(this.db, job.uid);
		const session = await this.db
			.collection<SessionDoc>("sessions")
			.findOne({ uid: job.uid, sessionId: job.sessionId });
		if (!session) throw new Error("Session not found.");
		if (job.kind === "push-plan") return this.pushPlan(job, session, settings);
		if (job.kind === "open-pr") return this.openPrJob(job, session, settings);
		if (job.mode === "ask") return this.ask(job, session, settings);
		return this.sandboxed(job, session, settings);
	}

	private async githubToken(session: SessionDoc, settings: UserSettings): Promise<string> {
		if (session.installationId) {
			const token = await installationToken(session.installationId).catch(swallow("executor", "op", ""));
			if (token) return token;
		}
		return githubPat(settings);
	}

	private async attachments(job: CloudJob): Promise<{ filename: string; mime: string; text?: string; data?: Buffer }[]> {
		if (!job.attachmentIds?.length) return [];
		const docs = await this.db
			.collection("attachments")
			.find({ uid: job.uid, attachmentId: { $in: job.attachmentIds } })
			.toArray();
		return docs.map((d) => ({
			filename: String(d.filename ?? "file"),
			mime: String(d.mime ?? "application/octet-stream"),
			text: typeof d.text === "string" ? d.text : undefined,
			data: d.data?.buffer as Buffer | undefined,
		}));
	}

	private taskWithInline(task: string, atts: { filename: string; text?: string }[]): string {
		const inline = atts.filter((a) => a.text && a.text.length <= INLINE_TEXT_LIMIT);
		if (!inline.length) return task;
		const blocks = inline.map((a) => `--- attached file: ${a.filename} ---\n${a.text}\n--- end ${a.filename} ---`);
		return `${task}\n\nAttached context:\n${blocks.join("\n\n")}`;
	}

	/** Ask mode: no sandbox, no repo — chat with memory_write only, attachments inlined. */
	private async ask(job: CloudJob, session: SessionDoc, settings: UserSettings): Promise<void> {
		this.throwIfStopped();
		const resolved = resolveProvider(settings, job);
		if (resolved.error) throw new Error(resolved.error);
		const s = resolved.settings!;
		this.runProvider = s;
		await this.loadPricing(s);
		this.sink.mask(s.apiKey);
		this.embedProvider = this.embedProviderFor(job, s);
		const atts = await this.attachments(job);
		const { runner } = await this.ensureRunner(job, session, "ask", "ask", () =>
			Promise.resolve([memoryWriteTool(this.db, job.uid, job.sessionId, job.runId, this.embedProvider, session.repo ?? undefined)]),
		);
		this.throwIfStopped();
		await this.sink.emit({ type: "cloud-status", text: "Contacting model…" });
		await runner.run(this.taskWithInline(job.task, atts), s);
		await this.afterRun(job);
	}

	private async ensureSandbox(session: SessionDoc, settings: UserSettings): Promise<SandboxCore> {
		const providerName = session.provider ?? String(settings.data.sandboxProvider ?? "e2b");
		const provider = getProvider(providerName);
		const creds: ProviderCreds = { secrets: settings.secrets, data: settings.data };
		const credErr = provider.validate(creds);
		if (credErr) throw new Error(credErr);
		for (const k of provider.secretKeys) {
			const v = settings.secrets[k];
			if (v) this.sink.mask(v);
		}
		const sbx = new SandboxCore();
		sbx.onLifecycle = (event, sandboxId) => {
			const state = event === "pause" ? "paused" : event === "start" ? "running" : event === "resume" ? "running" : undefined;
			void recordSandboxEvent(this.db, {
				uid: this.sink.uid,
				sandboxId,
				sessionId: session.sessionId,
				provider: providerName,
				event,
				state,
			});
			void this.db
				.collection("sandboxes")
				.updateOne(
					{ uid: this.sink.uid, sandboxId },
					{
						$set: { uid: this.sink.uid, sessionId: session.sessionId, sandboxId, provider: providerName, event, ...(state ? { state } : {}), at: new Date() },
						$setOnInsert: { createdAt: new Date() },
					},
					{ upsert: true },
				)
				.catch(swallow("executor", "op"));
		};
		sbx.setIdlePause(Number(process.env.SANDBOX_IDLE_PAUSE_MINUTES) || 15);
		// Session → sandbox is a relational link: reuse until dead, then replace.
		// Providers without reconnect (e.g. vercel — ephemeral) always create fresh.
		const oldId = session.sandboxId;
		if (oldId && provider.capabilities.reconnect) {
			// Retry connect before concluding it's dead — transient API/network
			// blips must not churn sandboxes.
			let connected = false;
			for (let attempt = 0; attempt < 3 && !connected; attempt++) {
				if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
				connected = !!(await sbx.connect(oldId, creds, providerName));
			}
			if (connected) {
				await sbx.keepalive(60);
				dbg("sandbox", "reused", { sandboxId: oldId });
				await this.sink.emit({ type: "info", text: `Reused warm sandbox ${oldId}` });
				return sbx;
			}
			dbg("sandbox", "unreachable after retries", { sandboxId: oldId });
		}
		try {
			await sbx.create({ creds, provider: providerName, template: session.template ?? undefined, timeoutMs: 60 * 60_000 });
		} catch (createErr) {
			// E2B quota hit safety valve: kill our oldest paused sandbox and retry once.
			if (provider.name !== "e2b") throw createErr;
			const oldestPaused = await this.db
				.collection("sandboxes")
				.findOne({ uid: this.sink.uid, state: "paused" }, { sort: { at: 1 } })
				.catch(swallow("executor", "op", null));
			if (!oldestPaused) throw createErr;
			const pausedId = String(oldestPaused.sandboxId);
			await this.sink.emit({ type: "info", text: `Sandbox quota hit — killing oldest paused sandbox ${pausedId} to make room` });
			console.log(`[executor] quota fallback: killing paused ${pausedId} for ${session.sessionId}`);
			await this.db.collection("sandboxes").updateOne(
				{ uid: this.sink.uid, sandboxId: pausedId },
				{ $set: { killPending: true, reason: "quota-fallback" } },
			).catch(swallow("executor", "op"));
			await provider.killById(pausedId, creds).catch(swallow("executor", "op"));
			await sbx.create({ creds, provider: providerName, template: session.template ?? undefined, timeoutMs: 60 * 60_000 });
		}
		await sbx.keepalive(60);
		const newId = sbx.sandboxId;
		// Old sandbox proven unreachable after retries — flag it for the janitor,
		// the single owner of kills.
		if (oldId) {
			await this.db
				.collection("sandboxes")
				.updateOne(
					{ uid: this.sink.uid, sandboxId: oldId },
					{ $set: { state: "replaced", replacedBy: newId, killPending: true, reason: "unreachable", replacedAt: new Date() } },
				)
				.catch(swallow("executor", "op"));
		}
		await this.db
			.collection("sandboxes")
			.updateOne(
				{ uid: this.sink.uid, sandboxId: newId },
				{ $set: { uid: this.sink.uid, sessionId: session.sessionId, sandboxId: newId, provider: providerName, state: "active", at: new Date() }, $setOnInsert: { createdAt: new Date() } },
				{ upsert: true },
			)
			.catch(swallow("executor", "op"));
		// A new sandbox is empty — clone state must reset with it.
		await this.sink.patchSession({ sandboxId: newId, cloned: false });
		await this.db
			.collection("sessions")
			.updateOne({ uid: this.sink.uid, sessionId: session.sessionId }, { $addToSet: { sandboxIds: newId } })
			.catch(swallow("executor", "op"));
		session.cloned = false;
		await this.sink.emit({ type: "info", text: `Created sandbox ${newId}` });
		return sbx;
	}

	private async sandboxed(job: CloudJob, session: SessionDoc, settings: UserSettings): Promise<void> {
		this.throwIfStopped();
		const resolved = resolveProvider(settings, job);
		if (resolved.error) throw new Error(resolved.error);
		const provider = resolved.settings!;
		this.runProvider = provider;
		await this.loadPricing(provider);
		this.sink.mask(provider.apiKey);
		this.embedProvider = this.embedProviderFor(job, provider);
		// Stamp sandbox activity — the janitor's idle-pause reads this, not ticks.
		if (session.sandboxId) {
			await this.db
				.collection("sandboxes")
				.updateOne({ uid: this.sink.uid, sandboxId: session.sandboxId }, { $set: { lastActivityAt: new Date() } })
				.catch(swallow("executor", "op"));
		}
		const mode: AgentMode =
			job.mode === "plan" ? "plan" : session.securityProfile === "bypass" ? "bypass" : "smart";
		await this.sink.emit({ type: "cloud-status", text: "Starting sandbox…" });
		const sbx = await this.ensureSandbox(session, settings);
		this.throwIfStopped();
		const token = await this.githubToken(session, settings);
		this.sink.mask(token);

		// The cloned flag can desync from reality (new/empty sandbox after an
		// expired one) — verify the repo dir actually exists before trusting it.
		if (session.cloned) {
			// `test -d .git` alone passes on an interrupted clone (.git exists, empty
			// worktree). Require a *valid* repo via git status, then repair an empty
			// worktree with reset --hard; wipe + reclone when the repo is corrupt.
			const probe = await sbx
				.runIn("/", `cd ${REPO_DIR} 2>/dev/null && git status >/dev/null 2>&1 && echo yes`, 15_000)
				.catch(swallow("executor", "op", ({ stdout: "", exitCode: 1, stderr: "" })));
			if (!probe.stdout.includes("yes")) {
				await sbx.runIn("/", `rm -rf ${REPO_DIR}`, 15_000).catch(swallow("executor", "op"));
				session.cloned = false;
				await this.sink.patchSession({ cloned: false });
			} else {
				const entries = await sbx
					.runIn("/", `ls -A ${REPO_DIR} | grep -vc '^\\.git$' || true`, 15_000)
					.catch(swallow("executor", "op", ({ stdout: "1", exitCode: 0, stderr: "" })));
				if (entries.stdout.trim() === "0") {
					await this.sink.emit({ type: "info", text: "Repo worktree empty — restoring from HEAD" });
					await sbx.runIn(REPO_DIR, "git reset --hard HEAD", 60_000).catch(swallow("executor", "op"));
				}
			}
			if (session.cloned && (!session.base || session.base === "main")) {
				// Heal stale base for sessions cloned before default-branch detection.
				const head = await sbx.runIn(REPO_DIR, "git symbolic-ref refs/remotes/origin/HEAD --short", 15_000).catch(swallow("executor", "op"));
				const base = head?.exitCode === 0 ? head.stdout.trim().replace(/^origin\//, "") : "";
				// Skip if the "default" resolves to our own kronyx branch — that
				// happens on empty repos where the first push is ours.
				if (base && !base.startsWith("kronyx/") && base !== session.base) {
					session.base = base;
					await this.sink.patchSession({ base });
				}
			}
		}
		if (!session.cloned) {
			if (!session.repo || !token) throw new Error("No repository or GitHub credential on this session.");
			await this.sink.emit({ type: "cloud-status", text: `Cloning ${session.repo}…` });
			const defaultBranch = await sbx.cloneRepo(`https://github.com/${session.repo}`, token, REPO_DIR);
			await this.sink.patchSession({ cloned: true, ...(defaultBranch ? { base: defaultBranch } : {}) });
			session.cloned = true;
			if (defaultBranch) session.base = defaultBranch;
		}

		const atts = await this.attachments(job);
		if (job.planSlug) {
			const plan = await this.db.collection("plans").findOne({ uid: job.uid, sessionId: job.sessionId, slug: job.planSlug });
			if (plan?.markdown) {
				job.task = `Implement this plan:\n\n${plan.markdown}\n\nOriginal request: ${job.task || job.planSlug}`;
			}
		}
		for (const a of atts) {
			const bytes = a.data ?? (a.text ? Buffer.from(a.text, "utf8") : undefined);
			if (bytes) await sbx.writeFile(`${REPO_DIR}/${ATTACH_DIR}/${a.filename.replace(/[/\\]+/g, "_")}`, bytes);
		}
		if (atts.length) {
			await this.sink.emit({
				type: "info",
				text: `Attachments available under ${ATTACH_DIR}/ (excluded from commits).`,
			});
		}

		if (mode !== "plan") {
			await this.ensureBranch(job, session, sbx, token);
			await this.preflight(job, session, sbx, token, settings);
		} else if (session.branch) {
			// Plan after an implement: read the session's feature branch, not stale base.
			await sbx
				.runIn(REPO_DIR, `git fetch origin ${session.branch} && git checkout ${session.branch}`, 60_000)
				.catch(swallow("executor", "op"));
		}

		this.throwIfStopped();
		const { runner, live } = await this.ensureRunner(job, session, "sandboxed", mode, () =>
			Promise.resolve([
				...createRemoteFileTools(delegatingHandle(live), REPO_DIR, { planDir: PLAN_DIR }),
				memoryWriteTool(this.db, job.uid, job.sessionId, job.runId, this.embedProvider, session.repo ?? undefined),
			]),
		);
		// Rebind the handle AFTER runner selection — cached agents call through it.
		live.handle = sbx.inner!;
		// Installation tokens expire in ~1h — re-mint + rewrite the remote URL
		// periodically so the agent's own git commands don't hit a dead token.
		const tokenRefresh =
			session.repo && session.installationId
				? setInterval(() => {
						void (async () => {
							const t = await this.githubToken(session, settings).catch(swallow("executor", "token refresh", ""));
							if (!t) return;
							this.sink.mask(t);
							await this.syncGhAuth(sbx, session.repo!, t);
						})();
					}, 45 * 60_000)
				: undefined;
		try {
			this.throwIfStopped();
			await runner.run(this.taskWithInline(job.task, atts), provider);
		} finally {
			if (tokenRefresh) clearInterval(tokenRefresh);
		}
		await this.afterRun(job);

		if (mode === "plan") {
			await this.capturePlan(job, sbx);
			return;
		}
		await this.verify(sbx);
		await this.pushAndPr(job, session, settings, sbx, token);
	}

	private async ensureBranch(job: CloudJob, session: SessionDoc, sbx: SandboxCore, token: string): Promise<void> {
		const base = session.base ?? "main";
		if (!session.branch) {
			const branch = `kronyx/${slugify(job.task)}-${job.runId.replace(/^web-/, "").slice(0, 6)}`;
			await sbx.createBranch(REPO_DIR, branch);
			await this.sink.patchSession({ branch });
			session.branch = branch;
			await this.sink.emit({ type: "info", text: `Created branch ${branch}` });
			return;
		}
		// Reconcile local branch vs origin/<branch> BEFORE any work:
		// ahead/behind counts decide — pull clean, keep unpushed commits,
		// rebase divergence now, or stop and ask the user.
		// Refresh the remote credential up front — the clone URL embeds a token
		// that expires, and the agent's own git commands hit the stale URL.
		if (session.repo && token) {
			await this.sink.emit({ type: "cloud-status", text: `Refreshing git credentials and syncing ${session.branch}…` });
			await this.syncGhAuth(sbx, session.repo, token);
		}
		await this.reconcileBranch(session, sbx);
		const behind = await sbx.driftBehind(REPO_DIR, base);
		if (behind > 0) {
			await this.sink.emit({ type: "info", text: `${base} moved ${behind} commit(s) ahead — rebasing…` });
			const ok = await sbx.rebaseOnto(REPO_DIR, base);
			await this.sink.emit({
				type: "info",
				text: ok ? `Rebased onto origin/${base}` : `Rebase onto origin/${base} hit conflicts — aborted; continuing on ${session.branch}`,
			});
		}
	}

	/**
	 * Write a fresh GitHub credential everywhere the sandbox needs it:
	 * the git remote URL (git push/fetch) and gh's hosts.yml (gh pr create).
	 * Installation tokens expire in ~1h — call this whenever a token is minted.
	 */
	private async syncGhAuth(sbx: SandboxCore, repo: string, token: string): Promise<void> {
		await sbx
			.runIn(REPO_DIR, `git remote set-url origin https://x-access-token:${token}@github.com/${repo}.git`)
			.catch(swallow("executor", "remote set-url"));
		// gh CLI reads ~/.config/gh/hosts.yml — no auth login needed.
		const hostsYml = `github.com:\n    oauth_token: ${token}\n    user: x-access-token\n    git_protocol: https\n`;
		await sbx
			.runIn("/", `mkdir -p ~/.config/gh && printf '%s' '${hostsYml.replace(/'/g, "'\\''")}' > ~/.config/gh/hosts.yml`)
			.catch(swallow("executor", "gh hosts.yml"));
	}

	/** Pre-run readiness: sandbox reachable, git remote auth works, provider key set. */
	private async preflight(job: CloudJob, session: SessionDoc, sbx: SandboxCore, token: string, settings: UserSettings): Promise<void> {
		const emit = async (name: string, ok: boolean, detail = "") =>
			this.sink.emit({ type: "check", command: `preflight: ${name}`, ok, durationMs: 0, output: detail.slice(0, 300) });

		const alive = await sbx.runIn("/", "echo ok", 10_000).then((r) => r.stdout.includes("ok")).catch(swallow("executor", "op", false));
		await emit("sandbox", alive, alive ? `${sbx.sandboxId ?? "sandbox"} reachable` : "sandbox not responding");

		if (session.repo && token) {
			const r = await sbx.runIn(REPO_DIR, "git ls-remote --heads origin HEAD", 30_000).catch(swallow("executor", "op"));
			await emit("git remote", !!r && r.exitCode === 0, r?.exitCode === 0 ? `${session.repo} reachable` : (r?.stderr || "ls-remote failed").replace(token, "•••"));
		}
		const res = resolveProvider(settings, job);
		await emit("provider", !res.error, res.error ?? `${res.settings!.modelId} (${res.settings!.profile ?? "default"})`);
	}

	/** Bring the sandbox's branch in line with origin before a run starts. */
	private async reconcileBranch(session: SessionDoc, sbx: SandboxCore): Promise<void> {
		const branch = session.branch;
		if (!branch) return;
		await sbx.runIn(REPO_DIR, "git fetch origin", 60_000).catch(swallow("executor", "op"));
		const remote = await sbx.runIn(REPO_DIR, `git rev-parse --verify origin/${branch} 2>/dev/null`).catch(swallow("executor", "op"));
		if (!remote || remote.exitCode !== 0) return; // no remote branch yet
		const [aheadR, behindR] = await Promise.all([
			sbx.runIn(REPO_DIR, `git rev-list --count origin/${branch}..HEAD`).catch(swallow("executor", "op")),
			sbx.runIn(REPO_DIR, `git rev-list --count HEAD..origin/${branch}`).catch(swallow("executor", "op")),
		]);
		const ahead = Number(aheadR?.stdout.trim()) || 0;
		const behind = Number(behindR?.stdout.trim()) || 0;
		if (behind === 0) {
			if (ahead > 0) await this.sink.emit({ type: "info", text: `${ahead} unpushed commit(s) will be pushed at the end of this run.` });
			return; // clean or strictly ahead — nothing to pull
		}
		const dirty = (await sbx.runIn(REPO_DIR, "git status --porcelain").catch(swallow("executor", "op")))?.stdout.trim() !== "";
		if (ahead === 0) {
			// Strictly behind — pull latest.
			if (dirty) {
				await sbx.runIn(REPO_DIR, "git stash push -m kronyx-autosave").catch(swallow("executor", "op"));
				await this.sink.emit({ type: "info", text: "Stashed uncommitted changes to pull the latest branch." });
			}
			const r = await sbx.runIn(REPO_DIR, `git reset --hard origin/${branch}`).catch(swallow("executor", "op"));
			if (r?.exitCode === 0) await this.sink.emit({ type: "cloud-status", text: `Synced to origin/${branch} (${behind} commit(s)).` });
			return;
		}
		// Diverged — rebase now rather than at push time.
		await this.sink.emit({ type: "info", text: `Branch diverged: ${ahead} local / ${behind} remote commit(s) — rebasing first…` });
		if (dirty) {
			await sbx.runIn(REPO_DIR, "git stash push -m kronyx-autosave").catch(swallow("executor", "op"));
		}
		const ok = await sbx.rebaseOnto(REPO_DIR, branch);
		if (!ok) {
			throw new Error(
				`Remote branch ${branch} diverged and the auto-rebase hit conflicts. ` +
					"Resolve manually or start a new session branch — refusing to work on top of a conflicted state.",
			);
		}
		await this.sink.emit({ type: "cloud-status", text: `Rebased ${ahead} commit(s) onto origin/${branch}.` });
	}

	private async capturePlan(job: CloudJob, sbx: SandboxCore): Promise<void> {
		const r = await sbx.runIn(PLAN_DIR, "ls -t *.md 2>/dev/null | head -1").catch(swallow("executor", "op"));
		const name = r?.stdout.trim();
		if (!name) return;
		const markdown = await sbx.readFile(`${PLAN_DIR}/${name}`);
		if (!markdown) return;
		const slug = name.replace(/\.md$/, "");
		await this.db.collection("plans").updateOne(
			{ uid: job.uid, sessionId: job.sessionId, slug },
			{ $set: { uid: job.uid, sessionId: job.sessionId, slug, markdown, runId: job.runId, updatedAt: new Date() }, $setOnInsert: { planId: randomUUID(), createdAt: new Date() } },
			{ upsert: true },
		);
	}

	private async verify(sbx: SandboxCore): Promise<string> {
		const probe = await sbx
			.runIn(REPO_DIR, "ls package.json go.mod requirements.txt pyproject.toml 2>/dev/null || true")
			.catch(swallow("executor", "op", ({ stdout: "", exitCode: 1, stderr: "" })));
		const cmd = probe.stdout.includes("package.json")
			? "npm test --if-present"
			: probe.stdout.includes("pyproject.toml") || probe.stdout.includes("requirements.txt")
				? "python -m pytest -q || true"
				: probe.stdout.includes("go.mod")
					? "go test ./..."
					: "";
		const results: string[] = [];
		if (cmd) {
			await this.sink.emit({ type: "cloud-status", text: `Verifying: ${cmd}` });
			const r = await sbx.runIn(REPO_DIR, cmd, 300_000).catch(swallow("executor", "op"));
			const ok = !!r && r.exitCode === 0;
			await this.sink.emit({ type: "check", command: cmd, ok, durationMs: 0, output: (r?.stdout || r?.stderr || "").slice(0, 1000) });
			results.push(`${cmd} → ${ok ? "passed" : "failed"}`);
		}
		const smoke = await this.bootSmoke(sbx, probe.stdout).catch(swallow("executor", "bootSmoke", "smoke: skipped (error)"));
		if (smoke) results.push(smoke);
		return results.join(" | ");
	}

	/** Tier-1 verify: boot the app in the background and curl its entry point. */
	private async bootSmoke(sbx: SandboxCore, probe: string): Promise<string> {
		let start = "";
		if (probe.includes("package.json")) {
			const pkg = await sbx.runIn(REPO_DIR, "cat package.json | grep -oE '\"(start|dev)\":[^,}]*' | head -3").catch(swallow("executor", "op"));
			if (pkg?.stdout.includes("\"dev\"")) start = "npm run dev";
			else if (pkg?.stdout.includes("\"start\"")) start = "npm start";
		} else if (probe.includes("requirements.txt") || probe.includes("pyproject.toml")) {
			const hasMain = await sbx.runIn(REPO_DIR, "ls main.py app.py 2>/dev/null || true").catch(swallow("executor", "op"));
			const f = hasMain?.stdout.trim().split("\n").find((l) => l.includes(".py"));
			if (f) start = `python3 ${f}`;
		}
		if (!start) return "";

		await this.sink.emit({ type: "cloud-status", text: `Boot check: ${start}` });
		await sbx
			.runIn(REPO_DIR, `nohup ${start} > /tmp/kronyx-app.log 2>&1 & echo $! > /tmp/kronyx-app.pid`, 15_000)
			.catch(swallow("executor", "op"));
		// Poll common ports for up to 20s.
		const found = await sbx
			.runIn(
				"/",
				`for i in $(seq 1 20); do for p in 3000 3001 5173 8000 8080 5000 8501; do if curl -sf -m 1 http://localhost:$p >/dev/null 2>&1; then echo $p; exit 0; fi; done; sleep 1; done; exit 1`,
				30_000,
			)
			.catch(swallow("executor", "op"));
		const port = found?.stdout.trim();
		if (!found || found.exitCode !== 0 || !port) {
			const log = (await sbx.runIn("/", "tail -20 /tmp/kronyx-app.log").catch(swallow("executor", "op")))?.stdout ?? "";
			await this.sink.emit({ type: "check", command: `boot: ${start}`, ok: false, durationMs: 20_000, output: log.slice(0, 800) });
			return "boot → failed (no port)";
		}
		const resp = await sbx.runIn("/", `curl -s -o /dev/null -w "%{http_code}" -m 5 http://localhost:${port}`).catch(swallow("executor", "op"));
		const code = resp?.stdout.trim() ?? "000";
		const ok = code.startsWith("2") || code.startsWith("3");
		await this.sink.emit({ type: "check", command: `boot: ${start} (port ${port}, HTTP ${code})`, ok, durationMs: 0, output: "" });
		return `boot → ${ok ? "passed" : "failed"} (:${port} → ${code})`;
	}

	private async pushAndPr(
		job: CloudJob,
		session: SessionDoc,
		_settings: UserSettings,
		sbx: SandboxCore,
		token: string,
	): Promise<void> {
		// Agent runs open a PR automatically on completion (openPr is
		// idempotent — reuses the open PR for the branch). Explicit open-pr
		// jobs and plan pushes keep working the same way.
		const wantPr = job.kind === "open-pr" || job.mode === "agent";
		const status = await sbx.runIn(REPO_DIR, "git status --porcelain");
		const dirty = status.stdout.trim() !== "";
		// For normal runs, clean tree = nothing to do; for open-pr jobs the
		// branch may be clean but still ahead — fall through to push/PR.
		if (!dirty && !wantPr) {
			await this.sink.emit({ type: "info", text: "No changes to push." });
			return;
		}
		// Emit per-file diffs so the timeline shows editor-style change cards —
		// covers writes made via shell (cat >), which bypass fs-tool events.
		for (const line of status.stdout.split("\n").filter((l) => l.trim())) {
			const kind = line.slice(0, 2).trim();
			const rel = line.slice(3).trim().replace(/^"|"$/g, "");
			if (!rel || rel.startsWith(ATTACH_DIR)) continue;
			const isNew = kind.includes("?");
			const diff = await sbx
				.runIn(REPO_DIR, isNew ? `git diff --no-index /dev/null "${rel}"` : `git diff HEAD -- "${rel}"`, 30_000)
				.catch(swallow("executor", "op"));
			const body = diff?.stdout ?? "";
			const added = body.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
			const removed = body.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
			await this.sink.emit({
				type: "file-changed",
				path: rel,
				kind: isNew ? "created" : "modified",
				added,
				removed,
				diff: body
					.split("\n")
					.filter((l) => l.startsWith("+") || l.startsWith("-") || l.startsWith("@@") || l.startsWith(" "))
					.filter((l) => !l.startsWith("+++") && !l.startsWith("---"))
					.slice(0, 250)
					.join("\n"),
			});
		}
		if (!token || !session.repo || !session.branch) return;
		// Mint a *fresh* token — the run-start token embedded in the remote URL
		// expires after ~1h, so long runs were pushing with a dead credential.
		const freshToken = (await this.githubToken(session, _settings).catch(swallow("executor", "token refresh", ""))) || token;
		this.sink.mask(freshToken);
		await this.syncGhAuth(sbx, session.repo, freshToken);
		dbg("run", "pushAndPr", { runId: job.runId, wantPr, branch: session.branch, base: session.base });
		await this.sink.emit({ type: "cloud-status", text: wantPr ? "Pushing branch and opening PR…" : `Pushing commits to ${session.branch}…` });
		try {
			await sbx.commitAndPush(REPO_DIR, session.branch, `kronyx: ${job.task.slice(0, 60)}`, [ATTACH_DIR]);
		} catch (err) {
			// Remote moved since run start — try fetch + rebase, then one retry.
			const msg = err instanceof Error ? err.message : String(err);
			await this.sink.emit({ type: "info", text: `Push rejected (${msg.slice(0, 200)}) — rebasing onto origin/${session.branch}…` });
			const rebased = await sbx.rebaseOnto(REPO_DIR, session.branch);
			if (!rebased) {
				throw new Error(
					`Remote branch ${session.branch} diverged and auto-rebase hit conflicts. ` +
						"Resolve the conflict in the sandbox or start a new session branch.",
				);
			}
			await sbx.commitAndPush(REPO_DIR, session.branch, `kronyx: ${job.task.slice(0, 60)}`, [ATTACH_DIR]);
		}
		if (!wantPr) {
			await this.sink.emit({ type: "cloud-status", text: `Pushed to ${session.branch}.` });
			return;
		}
		if (session.base === session.branch) {
			// Stale base (written before the kronyx-branch guard) — redetect the
			// real default branch from origin/HEAD before giving up.
			// Prefer main/master — origin/HEAD may point at our own kronyx
			// branch when it became the repo default on first push.
			// ls-remote queries GitHub directly — local remote refs may be
			// missing branches the repo actually has (shallow/partial clones).
			const head = await sbx
				.runIn(REPO_DIR, "git ls-remote --heads origin")
				.catch(swallow("executor", "op"));
			const branches = (head?.stdout ?? "")
				.split("\n")
				.map((l) => l.split("\t")[1]?.trim() ?? "")
				.map((l) => l.replace(/^refs\/heads\//, ""))
				.filter((b) => b && b !== session.branch && !b.startsWith("kronyx/"));
			let base = branches.find((b) => b === "main") ?? branches.find((b) => b === "master") ?? branches[0] ?? "";
			if (!base) {
				// Repo has only our branch — bootstrap main at the root commit so
				// the PR diff is branch-tip vs where we started.
				const root = (await sbx.runIn(REPO_DIR, "git rev-list --max-parents=0 HEAD").catch(swallow("executor", "op")))?.stdout.trim();
				if (root) {
					const r = await sbx.runIn(REPO_DIR, `git branch -f main ${root} && git push -u origin main`, 60_000).catch(swallow("executor", "op"));
					if (r?.exitCode === 0) {
						base = "main";
						await this.sink.emit({ type: "cloud-status", text: `No base branch — pushed main at the repo's first commit.` });
					}
				}
			}
			if (base && base !== session.branch) {
				session.base = base;
				await this.sink.patchSession({ base });
			}
			if (!base) {
				dbg("run", "no distinct base — skipping PR", { runId: job.runId, branch: session.branch, base: session.base });
				await this.sink.emit({ type: "info", text: `Branch pushed: ${session.branch} — no PR (no distinct base branch).` });
				return;
			}
		}
		dbg("run", "openPr", { runId: job.runId, repo: session.repo, head: session.branch, base: session.base });
		const pr = await openPr(
			session.repo,
			session.branch,
			session.base ?? "main",
			`Kronyx: ${job.task.slice(0, 80)}`,
			`Automated change by Kronyx cloud session.\n\nTask: ${job.task}`,
			token,
		);
		await this.sink.patchSession({ prUrl: pr.url });
		await this.db.collection("prs").updateOne(
			{ uid: job.uid, runId: job.runId },
			{ $set: { uid: job.uid, runId: job.runId, sessionId: job.sessionId, task: job.task, repo: session.repo, branch: session.branch, url: pr.url, title: `Kronyx: ${job.task.slice(0, 80)}`, status: "open", updatedAt: new Date() } },
			{ upsert: true },
		);
		await this.sink.emit({ type: "cloud-status", text: `PR ${pr.created ? "created" : "updated"}: ${pr.url}` });
	}

	/** Open a PR for the session branch (explicit user action — not automatic). */
	private async openPrJob(job: CloudJob, session: SessionDoc, settings: UserSettings): Promise<void> {
		dbg("run", "openPrJob", { runId: job.runId, branch: session.branch, base: session.base });
		const sbx = await this.ensureSandbox(session, settings);
		const token = await this.githubToken(session, settings);
		this.sink.mask(token);
		await this.pushAndPr(job, session, settings, sbx, token);
		dbg("run", "openPrJob done", { runId: job.runId });
	}

	/** Commit a saved plan markdown onto the session branch (creates the branch if needed). */
	private async pushPlan(job: CloudJob, session: SessionDoc, settings: UserSettings): Promise<void> {
		const plan = await this.db.collection("plans").findOne({ uid: job.uid, sessionId: job.sessionId, slug: job.planSlug });
		if (!plan) throw new Error("Plan not found.");
		const sbx = await this.ensureSandbox(session, settings);
		const token = await this.githubToken(session, settings);
		this.sink.mask(token);
		if (!session.cloned) {
			if (!session.repo || !token) throw new Error("No repository or GitHub credential on this session.");
			const defaultBranch = await sbx.cloneRepo(`https://github.com/${session.repo}`, token, REPO_DIR);
			await this.sink.patchSession({ cloned: true, ...(defaultBranch ? { base: defaultBranch } : {}) });
			session.cloned = true;
			if (defaultBranch) session.base = defaultBranch;
		}
		await this.ensureBranch(job, session, sbx, token);
		await sbx.writeFile(`${REPO_DIR}/.kronyx/plans/${job.planSlug}.md`, String(plan.markdown));
		await sbx.runIn(REPO_DIR, "mkdir -p .kronyx/plans").catch(swallow("executor", "op"));
		await sbx.commitAndPush(REPO_DIR, session.branch!, `kronyx: plan ${job.planSlug}`, [ATTACH_DIR]);
		await this.sink.emit({ type: "info", text: `Pushed .kronyx/plans/${job.planSlug}.md to ${session.branch}` });
	}
}
