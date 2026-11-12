import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { dbg, swallow } from "../lib/log";
import { AgentRunner, type AgentMode, type ProviderSettings, type RunViewEvent } from "../../../src/agent/runner";
import { getProvider, type ProviderCreds, type SandboxHandle, type SandboxProvider } from "../../../src/sandbox/provider";
import { SandboxCore, openPr } from "../../../src/sandbox/sandboxCore";
import { createRemoteFileTools } from "../../../src/tools/remoteFileTools";
import { BROWSER_DRIVER, BROWSER_DRIVER_PATH, SCREENSHOT_PATH, createBrowserTools } from "../../../src/tools/browserTools";
import { createEnvTools } from "../../../src/tools/envTools";
import { isAgentCliTemplate, resolveTemplateName, type TemplateInfo } from "../../../src/sandbox/templateCatalog";
import { pickTemplate } from "./pickTemplate";
import { installationToken } from "../lib/githubApp";
import { fetchModels, type ModelOption } from "../lib/models";
import { getCache } from "./cache";
import { recordSandboxEvent } from "../lib/sandboxEvents";
import { githubPat, loadUserSettings, resolveProvider, type UserSettings } from "./settings";
import type { RunSink } from "./events";
import type { AgentMessage } from "@cline/shared";
import type { PriorTranscript } from "../../../src/agent/recall";
import { evaluate, parseModePermissions, parsePermissions, parsePermissionsText, type PermissionLayers } from "../../../src/agent/permissions";
import { DECOMPOSE_PROMPT, isSharedManifest, ownsMatch, parseSlices, type ParsedSlices, type SliceSpec } from "../../../src/agent/decompose";
import {
	createRecallScorer,
	loadTranscripts,
	memoryWriteTool,
	recordDigests,
	saveTranscript,
	type ProvenDigest,
	searchMemories,
	sessionMemoryContext,
	type ContextManifest,
	type EmbedProvider,
} from "./memory";

const REPO_DIR = "/home/user/repo";
/** Multi-agent slices each work in their own git worktree beside the repo. */
const SLICE_DIR = (i: number) => `/home/user/repo-wt${i}`;
const MAX_SLICES = 6;
const PLAN_DIR = "/home/user/.kronyx/plans";
const ATTACH_DIR = ".kronyx/attachments";
const SHOTS_DIR = ".kronyx/shots";
const COMMIT_EXCLUDES = [ATTACH_DIR, SHOTS_DIR, ".kronyx/permissions.local.json"];
const INLINE_TEXT_LIMIT = 20 * 1024;
const TEXT_EXT = /\.(txt|md|markdown|ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|py|go|rs|java|c|cc|cpp|h|hpp|cs|rb|php|sh|css|html|xml|sql|env|ini|cfg|log)$/i;

export interface CloudJob {
	jobId: string;
	uid: string;
	sessionId: string;
	runId: string;
	task: string;
	mode: "ask" | "plan" | "agent" | "multi";
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
	/** Ref to check out at clone time — feature branch or pull/<n>/head. */
	startRef?: string;
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
	/** Set on user stop — delegatingHandle refuses all further commands. */
	stopped?: boolean;
	/** Rebound per run — browser screenshots emit on the current run's sink. */
	onScreenshot?: (dataUrl: string, label?: string) => void;
	/** Set by the switch_environment tool while a swap is in flight (dedup). */
	templateRequest?: { template: string; reason: string; evidence: string };
	/** Rebound per run — performs the VM swap synchronously inside the tool call. */
	performSwitch?: (req: { template: string; reason: string; evidence: string }) => Promise<string>;
	/** Rebound per run — the account's usable E2B templates for switch validation. */
	templates?: TemplateInfo[];
}

const delegatingHandle = (live: LiveSlot): SandboxHandle => ({
	get id() {
		return live.handle?.id ?? "";
	},
	run: (command, opts) => {
		if (live.stopped) return Promise.resolve({ exitCode: 130, stdout: "", stderr: "interrupted" });
		return live.handle ? live.handle.run(command, opts) : Promise.reject(new Error("Sandbox handle not bound."));
	},
	readFile: (path) => {
		if (live.stopped) return Promise.reject(new Error("Sandbox stopped."));
		return live.handle ? live.handle.readFile(path) : Promise.reject(new Error("Sandbox handle not bound."));
	},
	writeFile: async (path, content) => {
			if (live.stopped) throw new Error("Sandbox stopped.");
			if (!live.handle) throw new Error("Sandbox handle not bound.");
			return live.handle.writeFile(path, content);
		},
	setTimeout: (timeoutMs) => live.handle?.setTimeout?.(timeoutMs) ?? Promise.resolve(),
	interrupt: () => live.handle?.interrupt?.() ?? Promise.resolve(),
});

export class E2bOrchestratedExecutor implements RunExecutor {
	private runner: AgentRunner | undefined;
	private live: LiveSlot | undefined;
	/** Warm per-session runners: the same AgentRunner serves all runs in a session. */
	private static runnerCache = new Map<string, { runner: AgentRunner; route: RunnerRoute; live: LiveSlot; lastUsedAt: number }>();
	private static readonly MAX_CACHED = 20;
	/** Idle runners hold tools + transcripts — evict after this much quiet time. */
	private static readonly RUNNER_TTL_MS = 30 * 60_000;
	/** Pending transcript saves — a list because parallel slice agents each save their own. */
	private pendingSaves: Promise<void>[] = [];
	/** Slice/coordinator runners that finished — their digests feed afterRun. */
	private finishedSliceRunners: { runner: AgentRunner; agentIndex: number }[] = [];
	private embedProvider: EmbedProvider | undefined;
	/** Per-run usage ledger for usage_events rows (web runs bypass /api/ingest). */
	private runProvider: ProviderSettings | undefined;
	private modelPricing: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined;
	/** Catalog entry for the run's model — contextWindow/maxTokens/pricing. */
	private modelMeta: ModelOption | undefined;
	/** Per-agent usage ledgers — key is agentIndex (0 = coordinator/main). */
	private usageLedgers = new Map<
		number,
		{
			lastUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; totalCost: number };
			lastUsageAt: number;
			runStartedAt: number;
		}
	>();
	/** Live slice agents of a multi run — requestStop fans out to all of them. */
	private sliceAgents: { runner: AgentRunner; live: LiveSlot }[] = [];
	/** The run's current sandbox (rebound on switch_environment) + its keepalive. */
	private activeSbx: SandboxCore | undefined;
	private keepaliveTimer: ReturnType<typeof setInterval> | undefined;

	/** Extend E2B lifetime + refresh janitor activity every 10 min while a run
	 *  is in flight — `lastActivityAt` is otherwise only stamped once at run
	 *  start, and a >60min run outlives the sandbox's initial timeout. */
	private startSandboxKeepalive(sbx: SandboxCore): void {
		this.stopSandboxKeepalive();
		this.activeSbx = sbx;
		this.keepaliveTimer = setInterval(() => {
			const cur = this.activeSbx;
			if (!cur) return;
			void cur.keepalive(60).catch(swallow("executor", "op"));
			void this.db
				.collection("sandboxes")
				.updateOne({ uid: this.sink.uid, sandboxId: cur.sandboxId }, { $set: { lastActivityAt: new Date() } })
				.catch(swallow("executor", "op"));
		}, 10 * 60_000);
	}

	private stopSandboxKeepalive(): void {
		if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
		this.keepaliveTimer = undefined;
		this.activeSbx = undefined;
	}
	/** process-wide: `${baseUrl}|${modelId}` → catalog entry (null = unknown) */
	private static modelMetaCache = new Map<string, ModelOption | null>();

	private async loadPricing(p: ProviderSettings): Promise<void> {
		const key = `${p.baseUrl}|${p.modelId}`;
		let meta = E2bOrchestratedExecutor.modelMetaCache.get(key);
		if (meta === undefined) {
			// Cross-worker cache first — a miss hits the provider's /models once.
			const cache = await getCache().catch(swallow("executor", "op", undefined));
			meta = ((await cache?.get(`modelmeta:${key}`).catch(() => undefined)) ?? undefined) as ModelOption | undefined;
			if (meta === undefined) {
				const models = await fetchModels(p.baseUrl, p.apiKey).catch(swallow("executor", "op", []));
				meta = models.find((m) => m.id === p.modelId) ?? null;
				void cache?.set(`modelmeta:${key}`, meta ?? null, 24 * 60 * 60_000).catch(() => {});
			}
			E2bOrchestratedExecutor.modelMetaCache.set(key, meta);
		}
		this.modelMeta = meta ?? undefined;
		this.modelPricing = meta?.pricing ?? undefined;
		// Real catalog limits — compaction/handoff thresholds and output cap.
		if (meta?.contextWindow) p.contextWindow = meta.contextWindow;
		if (meta?.maxTokens) p.maxTokens = meta.maxTokens;
	}

	constructor(
		private readonly db: Db,
		private readonly sink: RunSink,
	) {}

	get agentRunner(): AgentRunner | undefined {
		return this.runner;
	}

	private stopRequested = false;
	/** Mid-run VM swaps this job has already used (cap: 2). */
	private switchCount = 0;

	/** Stop at the next safe point: aborts a live agent AND gates setup/run phases. */
	requestStop(): void {
		this.stopRequested = true;
		this.stopSandboxKeepalive();
		this.flushToolOutput();
		void this.sink.emit({ type: "run-stopping", text: "Stopping — interrupting the run…" }).catch(swallow("executor", "op"));
		this.runner?.stop();
		if (this.live) {
			this.live.stopped = true;
			void this.live.handle?.interrupt?.().catch(swallow("executor", "op"));
		}
		for (const s of this.sliceAgents) {
			s.runner.stop();
			s.live.stopped = true;
		}
		// Slices share the sandbox handle — one interrupt kills every in-flight
		// command, which is what an all-or-nothing stop wants.
		void this.sliceAgents[0]?.live.handle?.interrupt?.().catch(swallow("executor", "op"));
	}

	private throwIfStopped(): void {
		if (this.stopRequested) throw new Error("Stopped by user");
	}

	/**
	 * Live terminal streaming: sandbox onOutput chunks are bursty — batch into
	 * 400ms tool-output-delta events instead of one row per chunk.
	 */
	/** Buffers are keyed by agentIndex — parallel slice agents batch independently. */
	private outBufs = new Map<number, { buf: string; timer: ReturnType<typeof setTimeout> | null }>();
	private queueToolOutput(chunk: string, agentIndex = 0): void {
		let b = this.outBufs.get(agentIndex);
		if (!b) this.outBufs.set(agentIndex, (b = { buf: "", timer: null }));
		b.buf += chunk;
		if (b.timer) return;
		b.timer = setTimeout(() => this.flushToolOutput(agentIndex), 400);
	}
	private flushToolOutput(agentIndex?: number): void {
		const keys = agentIndex === undefined ? [...this.outBufs.keys()] : [agentIndex];
		for (const k of keys) {
			const b = this.outBufs.get(k);
			if (!b) continue;
			if (b.timer) {
				clearTimeout(b.timer);
				b.timer = null;
			}
			if (!b.buf) continue;
			const text = b.buf;
			b.buf = "";
			void this.sink.emit({ type: "tool-output-delta", text }, k ? { agentIndex: k } : undefined).catch(swallow("executor", "op"));
		}
	}

	/**
	 * Interactive approvals ("controlled" securityProfile): emit a
	 * permission-request event, record a pending entry on the run doc, and
	 * poll for the decision the UI posts via POST /api/runs/:id/permissions/:permId.
	 * Denies on stop or after a 10-minute timeout.
	 */
	private async awaitPermission(job: CloudJob, toolName: string, input: unknown): Promise<boolean> {
		const permId = randomUUID();
		const inp = (input ?? {}) as Record<string, unknown>;
		const path = String(inp.path ?? inp.file ?? "");
		const command = String(inp.command ?? inp.cmd ?? "");
		await this.sink
			.emit({ type: "permission-request", id: permId, tool: toolName, path, command, input })
			.catch(swallow("executor", "op"));
		await this.db
			.collection("runs")
			.updateOne(
				{ uid: job.uid, runId: job.runId },
				{ $set: { [`permissions.${permId}`]: { tool: toolName, status: "pending", at: new Date() } } },
			)
			.catch(swallow("executor", "op"));
		const resolve = async (decision: "allow" | "deny" | "stopped" | "timeout", allowed: boolean): Promise<boolean> => {
			await this.sink
				.emit({ type: "permission-response", id: permId, decision })
				.catch(swallow("executor", "op"));
			return allowed;
		};
		const deadline = Date.now() + 10 * 60_000;
		while (Date.now() < deadline) {
			if (this.stopRequested) return resolve("stopped", false);
			const run = await this.db
				.collection("runs")
				.findOne(
					{ uid: job.uid, runId: job.runId },
					{ projection: { [`permissions.${permId}`]: 1, control: 1 } },
				)
				.catch(swallow("executor", "op", null));
			if (run?.control === "stop_requested") return resolve("stopped", false);
			const decision = String(
				((run as { permissions?: Record<string, { decision?: string }> } | null)?.permissions?.[permId]?.decision) ?? "",
			);
			if (decision === "allow" || decision === "deny") return resolve(decision, decision === "allow");
			await new Promise((r) => setTimeout(r, 1500));
		}
		return resolve("timeout", false);
	}

	/** Session-scoped runner: warm hit returns the live agent; cold start rehydrates transcripts + digests. */
	private async ensureRunner(
		job: CloudJob,
		session: SessionDoc,
		kind: "ask" | "sandboxed",
		mode: AgentMode,
		makeTools: () => Promise<import("@cline/shared").AgentTool<any, string>[]>,
		sandbox?: SandboxCore,
	): Promise<{ runner: AgentRunner; live: LiveSlot }> {
		// Provider fingerprint in the key: switching model/profile mid-session
		// rebuilds the agent instead of reusing one bound to stale credentials.
		const p = this.runProvider;
		const fp = p ? `${p.providerId}|${p.modelId}|${p.baseUrl}` : "none";
		const key = `${job.sessionId}:${kind}:${fp}`;
		const now = Date.now();
		for (const [k, e] of E2bOrchestratedExecutor.runnerCache) {
			if (!e.runner.isRunning && now - e.lastUsedAt > E2bOrchestratedExecutor.RUNNER_TTL_MS) {
				e.runner.stop();
				E2bOrchestratedExecutor.runnerCache.delete(k);
			}
		}
		const cached = E2bOrchestratedExecutor.runnerCache.get(key);
		if (cached) {
			cached.lastUsedAt = now;
			cached.live.stopped = false; // new run — clear a previous stop
			cached.route.job = job;
			cached.route.sink = this.sink;
			cached.route.track = (e) => this.trackUsage(e, job);
			return { runner: (this.runner = cached.runner), live: (this.live = cached.live) };
		}
		const transcripts: PriorTranscript[] = await loadTranscripts(this.db, job.uid, job.sessionId).catch(swallow("executor", "op", []));
		// Reloaded lazily (60s) — runs finished during this warm session must be
		// visible to recall_context's runIndex, not just cold-start transcripts.
		const transcriptBox = { list: transcripts, at: now };
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
		let permLayers: PermissionLayers | undefined;
		const runner = new AgentRunner({
			workspaceRoot: kind === "ask" ? "(none)" : REPO_DIR,
			relativePath: (abs) => abs.replace(`${REPO_DIR}/`, ""),
			isDirty: () => false,
			confirmWrite: async (toolName, input) => {
				if (kind === "ask") return false;
				if (session.securityProfile !== "controlled") return true;
				return this.awaitPermission(job, toolName, input);
			},
			currentMode: () => mode,
			planDir: kind === "ask" ? undefined : PLAN_DIR,
			memoryContext: async (task) => {
				const sessCache = await getCache().catch(() => undefined);
				const sessKey = `sessiondoc:${job.sessionId}`;
				const fresh = ((await sessCache?.get(sessKey).catch(() => undefined)) ??
					(await this.db.collection("sessions").findOne({ uid: job.uid, sessionId: job.sessionId }))) as SessionDoc | null;
				if (fresh) void sessCache?.set(sessKey, fresh, 5_000).catch(() => {});
				// Cold-start already searched for this exact task — reuse it.
				const mem =
					task === job.task
						? memories
						: await searchMemories(this.db, job.uid, job.sessionId, task, embed, session.repo ?? undefined).catch(
								swallow("executor", "op", memories),
							);
				return sessionMemoryContext({ ...session, ...fresh } as SessionDoc, planSlugs, mem);
			},
			recallScorer: embed ? createRecallScorer(embed) : undefined,
			checkPermission: async (toolName, input) => {
				// Lazy-load once per runner: global rules from the user's synced
				// settings (data.permissions object or permissionsJson string);
				// project rules from the repo's own clone.
				if (!permLayers) {
					const settings = await loadUserSettings(this.db, job.uid).catch(() => undefined);
					const raw = settings?.data.permissions ?? settings?.data.permissionsJson;
					const global = typeof raw === "string" ? parsePermissionsText(raw) : parsePermissions(raw);
					const modes = parseModePermissions(raw);
					const project = sandbox
						? parsePermissionsText((await sandbox.readFile(`${REPO_DIR}/.kronyx/permissions.json`).catch(() => null)) ?? "")
						: { allow: [] as string[], ask: [] as string[], deny: [] as string[] };
					permLayers = { global, project, local: { allow: [], ask: [], deny: [] }, modes };
				}
				return evaluate(permLayers, toolName, input, job.mode);
			},
			priorTranscripts: () => {
				if (Date.now() - transcriptBox.at > 60_000) {
					transcriptBox.at = Date.now();
					void loadTranscripts(this.db, job.uid, job.sessionId)
						.then((t) => {
							transcriptBox.list = t;
						})
						.catch(swallow("executor", "op"));
				}
				return transcriptBox.list;
			},
			saveTranscript: (messages: readonly AgentMessage[]) => {
				const j = route.job ?? job;
				transcriptBox.at = 0; // next recall reloads — this run just landed in the store
				this.pendingSaves.push(saveTranscript(this.db, j.uid, j.sessionId, j.runId, messages).catch(swallow("executor", "op")));
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
			let oldestKey: string | undefined;
			let oldestAt = Infinity;
			for (const [k, e] of E2bOrchestratedExecutor.runnerCache) {
				if (e.lastUsedAt < oldestAt) {
					oldestAt = e.lastUsedAt;
					oldestKey = k;
				}
			}
			if (oldestKey) {
				E2bOrchestratedExecutor.runnerCache.get(oldestKey)?.runner.stop();
				E2bOrchestratedExecutor.runnerCache.delete(oldestKey);
			}
		}
		E2bOrchestratedExecutor.runnerCache.set(key, { runner, route, live: {}, lastUsedAt: now });
		return { runner: (this.runner = runner), live: (this.live = E2bOrchestratedExecutor.runnerCache.get(key)!.live) };
	}

	/**
	 * Mirror of the extension's per-request ledger: cumulative `usage` events
	 * become delta rows in usage_events so the web Usage page sees cloud runs.
	 */
	private trackUsage(e: RunViewEvent, job: CloudJob, agentIndex = 0): void {
		let L = this.usageLedgers.get(agentIndex);
		if (!L) {
			L = {
				lastUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalCost: 0 },
				lastUsageAt: 0,
				runStartedAt: 0,
			};
			this.usageLedgers.set(agentIndex, L);
		}
		if (e.type === "run-started") {
			L.runStartedAt = Date.now();
			L.lastUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalCost: 0 };
			L.lastUsageAt = 0;
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
				agentIndex,
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
				tokensIn: diff(cur.inputTokens, L.lastUsage.inputTokens),
				tokensOut: diff(cur.outputTokens, L.lastUsage.outputTokens),
				cacheRead: diff(cur.cacheReadTokens, L.lastUsage.cacheReadTokens),
				cacheWrite: diff(cur.cacheWriteTokens, L.lastUsage.cacheWriteTokens),
				reasoningTokens: diff(cur.reasoningTokens, L.lastUsage.reasoningTokens),
				billedCost: Number(ev.totalCost) > 0 || L.lastUsage.totalCost > 0 ? diff(cur.totalCost, L.lastUsage.totalCost) : null,
			};
			L.lastUsage = cur;
			// Stamp context-fill fields onto the event — the UI's meter reads
			// requestTokens/contextWindow directly, no client-side diffing.
			const win = this.modelMeta?.contextWindow ?? p?.contextWindow;
			const stamped = e as { requestTokens?: number; contextWindow?: number; contextPct?: number };
			stamped.requestTokens = delta.tokensIn;
			if (win) {
				stamped.contextWindow = win;
				stamped.contextPct = Math.min(100, Math.round((delta.tokensIn / win) * 100));
			}
			void record("ok", delta, L.lastUsageAt ? now - L.lastUsageAt : now - L.runStartedAt, {
				iteration: ev.iteration,
				contextMsgs: ev.contextMsgs,
			});
			L.lastUsageAt = now;
		} else if (e.type === "run-failed" && (L.lastUsageAt || L.runStartedAt)) {
			void record("failed", { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, billedCost: null }, Date.now() - (L.lastUsageAt || L.runStartedAt));
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
			agentIndex?: number;
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
				agentIndex: fields.agentIndex ?? 0,
				contextWindow: this.modelMeta?.contextWindow ?? this.runProvider?.contextWindow ?? null,
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
		await Promise.allSettled(this.pendingSaves);
		this.flushToolOutput();
		// Events must land before terminal status — SSE reads run status to close.
		await this.sink.drain().catch(swallow("executor", "op"));
		if (this.runner?.runDigests.length) {
			const digests = this.runner.runDigests.map((d) => ({ ...d, runId: job.runId }));
			await recordDigests(this.db, job.uid, job.sessionId, digests).catch(swallow("executor", "op"));
		}
		// Multi-agent: each slice/coordinator runner has its own digests —
		// this.runner is unset for multi, so collect them here or they're lost.
		// recordDigests REPLACES sessions.digests — aggregate into ONE call
		// (existing history + all agents) or each writer clobbers the others.
		if (this.finishedSliceRunners.length) {
			const prior =
				(((await this.db
					.collection("sessions")
					.findOne({ uid: job.uid, sessionId: job.sessionId }, { projection: { digests: 1 } })
					.catch(swallow("executor", "op", null))) as { digests?: ProvenDigest[] } | null)?.digests ?? []);
			const all: ProvenDigest[] = [
				...prior,
				...this.finishedSliceRunners.flatMap((s) => s.runner.runDigests.map((d) => ({ ...d, runId: job.runId, agentIndex: s.agentIndex })) as ProvenDigest[]),
			];
			// Scale the cap with agent count — MAX_DIGESTS would truncate all but
			// the last few slices' digests, losing most of what just happened.
			const cap = prior.length + this.finishedSliceRunners.length + 3;
			await recordDigests(this.db, job.uid, job.sessionId, all, cap).catch(swallow("executor", "op"));
		}
	}

	async run(job: CloudJob): Promise<void> {
		const settings = await loadUserSettings(this.db, job.uid);
		const session = await this.db
			.collection<SessionDoc>("sessions")
			.findOne({ uid: job.uid, sessionId: job.sessionId });
		if (!session) throw new Error("Session not found.");
		try {
			if (job.kind === "push-plan") return await this.pushPlan(job, session, settings);
			if (job.kind === "open-pr") return await this.openPrJob(job, session, settings);
			if (job.mode === "ask") return await this.ask(job, session, settings);
			if (job.mode === "multi") return await this.multi(job, session, settings);
			return await this.sandboxed(job, session, settings);
		} finally {
			this.stopSandboxKeepalive();
		}
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

	/** Live template catalog per account, cached 10 min (public + account-built). */
	private static templateCache = new Map<string, { at: number; list: TemplateInfo[] }>();
	private templates: TemplateInfo[] = [];

	private async liveTemplates(provider: SandboxProvider, creds: ProviderCreds): Promise<TemplateInfo[]> {
		if (!provider.listTemplates) return [];
		const key = String(creds.secrets.e2bApiKey ?? "").slice(-12) || provider.name;
		const hit = E2bOrchestratedExecutor.templateCache.get(key);
		if (hit && Date.now() - hit.at < 10 * 60_000) return hit.list;
		// Shared cache — template catalogs rarely change; other workers hit this.
		const cache = await getCache().catch(swallow("executor", "op", undefined));
		const shared = (await cache?.get(`templates:${key}`).catch(() => undefined)) as TemplateInfo[] | undefined;
		if (shared?.length) {
			E2bOrchestratedExecutor.templateCache.set(key, { at: Date.now(), list: shared });
			return shared;
		}
		const list = await provider.listTemplates(creds).catch(swallow("executor", "op", []));
		dbg("executor", "liveTemplates", { provider: provider.name, count: list.length });
		if (list.length) {
			E2bOrchestratedExecutor.templateCache.set(key, { at: Date.now(), list });
			void cache?.set(`templates:${key}`, list, 10 * 60_000).catch(() => {});
		}
		return list;
	}

	private async ensureSandbox(
		session: SessionDoc,
		settings: UserSettings,
		opts: { template?: string; llm?: ProviderSettings; task?: string } = {},
	): Promise<SandboxCore> {
		const providerName = session.provider ?? String(settings.data.sandboxProvider ?? "e2b");
		const provider = getProvider(providerName);
		const creds: ProviderCreds = { secrets: settings.secrets, data: settings.data };
		const credErr = provider.validate(creds);
		if (credErr) throw new Error(credErr);
		for (const k of provider.secretKeys) {
			const v = settings.secrets[k];
			if (v) this.sink.mask(v);
		}
		// Template catalog is needed by switch_environment validation too —
		// cached 10 min, so this is usually a map read.
		this.templates = await this.liveTemplates(provider, creds);
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
		// Template resolution (only when a VM is actually created — warm
		// reconnects above never reach this): switch override > session
		// template > LLM pick > user's e2bTemplate default > stock base.
		let template = opts.template ?? session.template ?? undefined;
		if (!template && this.templates.length && opts.llm && opts.task) {
			const picked = await pickTemplate(opts.llm, opts.task, this.templates);
			if (picked) {
				template = picked;
				await this.sink.patchSession({ template: picked });
				await this.sink.emit({ type: "info", text: `Picked sandbox template "${picked}" for this task` });
			}
		}
		template ??= String(settings.data.e2bTemplate ?? "") || undefined;
		session.template = template ?? session.template;
		try {
			await sbx.create({ creds, provider: providerName, template, timeoutMs: 60 * 60_000 });
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
			await sbx.create({ creds, provider: providerName, template, timeoutMs: 60 * 60_000 });
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

	/** Shared sandboxed-run prologue: provider → sandbox → clone → attachments →
	 *  branch/preflight. Both `sandboxed` (single agent) and `multi` use it. */
	private async prepareSandboxed(
		job: CloudJob,
		session: SessionDoc,
		settings: UserSettings,
	): Promise<{
		provider: ProviderSettings;
		sbx: SandboxCore;
		token: string;
		atts: { filename: string; mime: string; text?: string; data?: Buffer }[];
		mode: AgentMode;
	}> {
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
		let sbx = await this.ensureSandbox(session, settings, { llm: provider, task: job.task });
		this.startSandboxKeepalive(sbx);
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
			await this.cloneStart(session, sbx, token);
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
			// Plan after an implement: read the session's feature branch — but
			// reconcile it first; a bare local checkout can sit behind origin.
			await sbx.runIn(REPO_DIR, `git checkout ${JSON.stringify(session.branch)}`, 60_000).catch(swallow("executor", "op"));
			await this.reconcileBranch(session, sbx);
		}

		return { provider, sbx, token, atts, mode };
	}

	private async sandboxed(job: CloudJob, session: SessionDoc, settings: UserSettings): Promise<void> {
		return this.agentTail(job, session, settings, await this.prepareSandboxed(job, session, settings));
	}

	/** Single-agent tail: runner wiring → run → afterRun → verify → push/PR.
	 *  Shared by `sandboxed` and by `multi`'s single-slice fallback. */
	private async agentTail(
		job: CloudJob,
		session: SessionDoc,
		settings: UserSettings,
		ctx: {
			provider: ProviderSettings;
			sbx: SandboxCore;
			token: string;
			atts: { filename: string; mime: string; text?: string; data?: Buffer }[];
			mode: AgentMode;
		},
	): Promise<void> {
		const { provider, token, atts, mode } = ctx;
		let sbx = ctx.sbx;
		this.throwIfStopped();
		const { runner, live } = await this.ensureRunner(job, session, "sandboxed", mode, () =>
			Promise.resolve([
				...createRemoteFileTools(delegatingHandle(live), REPO_DIR, {
					planDir: PLAN_DIR,
					onCommandOutput: (chunk) => this.queueToolOutput(chunk),
				}),
				memoryWriteTool(this.db, job.uid, job.sessionId, job.runId, this.embedProvider, session.repo ?? undefined),
				// browser_use drives a UI sub-agent; skip in plan mode (read-only).
				...(mode === "plan"
					? []
					: createBrowserTools(delegatingHandle(live), REPO_DIR, {
							apiKey: provider.apiKey,
							baseUrl: provider.baseUrl,
							modelId: provider.modelId,
							onScreenshot: (dataUrl, label) => live.onScreenshot?.(dataUrl, label),
						})),
				// switch_environment: mid-run VM image swap. Disabled by the
				// sandboxAutoSwitch setting — the agent reports missing tooling instead.
				...(settings.data.sandboxAutoSwitch === false
					? []
					: createEnvTools({
							requestSwitch: async (template, reason, evidence) => {
								const live_ = live.templates ?? this.templates;
								if (!live_.length) return "Template switching isn't available for this sandbox provider.";
								if (live.templateRequest) return `A switch to "${live.templateRequest.template}" is already in progress.`;
								if (this.switchCount >= 2) return "Refused: this run already used its VM-switch budget (2). Work around the missing tooling instead.";
								const name = resolveTemplateName(template, live_);
								if (!name) {
									const avail = live_.map((t) => t.names[0]?.split(":")[0] ?? t.id).join(", ");
									return `Unknown template "${template}". Available: ${avail}`;
								}
								if (name === session.template) return `Already running on "${name}".`;
								if (isAgentCliTemplate(name)) {
									return `Refused: "${name}" is a CLI-agent image — Kronyx's own agent loop runs in the VM, these images add nothing for it. Pick an environment image (e.g. desktop, code-interpreter-v1, or an account template).`;
								}
								const req = { template: name, reason, evidence };
								live.templateRequest = req;
								try {
									return (await live.performSwitch?.(req)) ?? "Switching is unavailable right now — no active VM swap handler.";
								} catch (err) {
									return `Switch to "${name}" failed: ${String(err).slice(0, 300)} — staying on the current environment.`;
								} finally {
									live.templateRequest = undefined;
								}
							},
						})),
			]),
			sbx,
		);
		// Rebind the handle AFTER runner selection — cached agents call through it.
		live.handle = sbx.inner!;
		live.onScreenshot = (dataUrl, label) => {
			void this.sink.emit({ type: "ui-screenshot", url: label ?? "", dataUrl });
		};
		live.templates = this.templates;
		// switch_environment blocks inside its tool call until the new VM is
		// live — subsequent tool calls route through the rebound handle.
		live.performSwitch = (req) =>
			this.performTemplateSwitch(
				job,
				session,
				settings,
				() => sbx,
				(next) => {
					sbx = next;
					this.activeSbx = next;
				},
				live,
				token,
				req,
			);
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
		this.throwIfStopped();
		await this.afterRun(job);

		if (mode === "plan") {
			await this.capturePlan(job, sbx);
			return;
		}
		this.throwIfStopped();
		// Checkpoint: committed work goes remote BEFORE the risky tail — a
		// sandbox death during verify/push loses only the verify output.
		await sbx
			.commitAndPush(REPO_DIR, session.branch!, "kronyx: checkpoint before verify", COMMIT_EXCLUDES)
			.catch(async () => this.sink.emit({ type: "info", text: "Checkpoint push failed — continuing to verify." }));
		await this.sink.patchRun({ status: "verifying" }).catch(swallow("executor", "op"));
		await this.verify(sbx);
		this.throwIfStopped();
		await this.sink.patchRun({ status: "pushing" }).catch(swallow("executor", "op"));
		await this.pushAndPr(job, session, settings, sbx, token);
	}

	// ------------------------------------------------------------------
	// Multi-agent mode: planner → worktree slices → merge fan-in → agent tail.
	// ------------------------------------------------------------------

	private async multi(job: CloudJob, session: SessionDoc, settings: UserSettings): Promise<void> {
		const ctx = await this.prepareSandboxed(job, session, settings);
		const { provider, sbx, token, atts, mode } = ctx;
		this.throwIfStopped();
		// Sweep stale state from a previously killed multi run: slice worktrees,
		// and any open merge/rebase or leftover edits in the main checkout —
		// a stale MERGE_HEAD would poison this run's merges and commits.
		await sbx
			.runIn(
				REPO_DIR,
				`git worktree prune; git merge --abort 2>/dev/null; git rebase --abort 2>/dev/null; git cherry-pick --abort 2>/dev/null; if [ -n "$(git diff --name-only --diff-filter=U 2>/dev/null)" ]; then git reset --hard HEAD; fi; rm -rf /home/user/repo-wt* 2>/dev/null; true`,
				30_000,
			)
			.catch(swallow("executor", "op"));

		const planned = await this.planSlices(job, provider, sbx, this.taskWithInline(job.task, atts));
		const slices = planned?.slices;
		if (!planned || !slices || slices.length < 2) {
			await this.sink.emit({
				type: "info",
				text: "Task doesn't decompose into independent slices — running a single agent.",
			});
			return this.agentTail(job, session, settings, ctx);
		}
		const droppedSlices = planned.dropped;
		if (droppedSlices.length)
			await this.sink.emit({
				type: "info",
				text: `${droppedSlices.length} proposed slice${droppedSlices.length > 1 ? "s" : ""} couldn't run in a bounded worktree (${[...new Set(droppedSlices.map((d) => d.reason))].join(", ")}) — the merge coordinator will handle that work.`,
			});

		const sliceRows = slices.map((s) => ({ index: s.index, title: s.title, status: "queued", summary: "" }));
		await this.sink.emit({ type: "fanout", slices: slices.map((s) => ({ index: s.index, title: s.title, owns: s.owns })) }, { agentIndex: 0 });
		await this.sink.patchRun({
			mode: "multi",
			slices: sliceRows,
			droppedSlices: droppedSlices.map((d) => ({ title: d.title, task: d.task.slice(0, 500), reason: d.reason })),
		});
		if (slices.some((s) => s.env?.template))
			await this.sink.emit({
				type: "info",
				text: "A slice flagged a different environment need — running it in the shared sandbox anyway (per-slice sandboxes aren't enabled yet).",
			});

		// Worktree per slice, forked from the session branch.
		this.throwIfStopped();
		for (const s of slices) {
			const r = await sbx
				// -B (not -b): a surviving part-N branch from a killed prior run
				// must not fail the retry — reset it onto HEAD.
				.runIn(REPO_DIR, `git worktree add ${SLICE_DIR(s.index)} -B ${JSON.stringify(`${session.branch}-part-${s.index}`)}`, 120_000)
				.catch(swallow("executor", "op", { exitCode: 1, stdout: "", stderr: "worktree add failed" }));
			if (r.exitCode !== 0) throw new Error(`Worktree setup failed for slice ${s.index}: ${r.stderr.slice(0, 300)}`);
		}

		/** Sub-run docs: slices are first-class runs (parent-linked) even though
		 *  events flow under the parent runId — queryable status/duration each. */
		const sliceStartedAt = new Map<number, number>();
		const patchSliceRun = (index: number, patch: Record<string, unknown>) =>
			this.db
				.collection("runs")
				.updateOne(
					{ uid: job.uid, runId: `${job.runId}-s${index}` },
					{ $set: { uid: job.uid, runId: `${job.runId}-s${index}`, sessionId: job.sessionId, parentRunId: job.runId, agentIndex: index, kind: "slice", mode: "multi-slice", ...patch, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
					{ upsert: true },
				)
				.catch(swallow("executor", "op"));

		const sliceState = new Map<number, { status: string; summary: string }>();
		const markSlice = async (s: SliceSpec, status: string, summary = "") => {
			sliceState.set(s.index, { status, summary });
			const row = sliceRows.find((r) => r.index === s.index);
			if (row) {
				row.status = status;
				row.summary = summary.slice(0, 500);
			}
			await this.sink.patchRun({ slices: sliceRows }).catch(swallow("executor", "op"));
			const sub: Record<string, unknown> = { task: s.title, status };
			if (status === "running") {
				sliceStartedAt.set(s.index, Date.now());
				sub.startedAt = new Date();
			} else {
				const started = sliceStartedAt.get(s.index);
				sub.finishedAt = new Date();
				if (started) sub.durationMs = Date.now() - started;
				if (summary) sub.summary = summary.slice(0, 500);
			}
			await patchSliceRun(s.index, sub);
			await this.sink.emit(
				{ type: "slice-status", index: s.index, title: s.title, status: status as "running" | "done" | "failed" | "stopped", summary: summary.slice(0, 500) },
				{ agentIndex: 0 },
			);
		};

		for (const s of slices) await patchSliceRun(s.index, { task: s.title, status: "queued" });

		const runSlice = async (s: SliceSpec): Promise<void> => {
			const sliceLive: LiveSlot = { handle: sbx.inner! };
			const finishText = { value: "" };
			const runner = this.makeSliceRunner(job, session, s, sbx, sliceLive, mode, finishText);
			this.sliceAgents.push({ runner, live: sliceLive });
			await markSlice(s, "running");
			try {
				await runner.run(this.sliceTask(s), provider);
				await markSlice(s, this.stopRequested ? "stopped" : "done", finishText.value || "Done.");
			} catch (err) {
				await markSlice(s, this.stopRequested ? "stopped" : "failed", String(err).slice(0, 400));
			} finally {
				const i = this.sliceAgents.findIndex((a) => a.runner === runner);
				if (i >= 0) this.sliceAgents.splice(i, 1);
				this.finishedSliceRunners.push({ runner, agentIndex: s.index });
			}
		};

		await Promise.allSettled(slices.map(runSlice));
		this.throwIfStopped();

		// Fan-in: merge each done slice's part branch into the session branch.
		await this.sink.emit({ type: "cloud-status", text: "Merging slice branches…" });
		const results: { index: number; title: string; status: "merged" | "resolved" | "failed"; detail?: string }[] = [];
		const depLines: string[] = [];
		const seenDepLines = new Set<string>();

		/** One coordinator invocation — resolves conflicts or applies deferred
		 *  manifest changes. Returns false when the pass itself errored.
		 *  `strong` uses the run's full model — for real feature work (dropped
		 *  slices), not mechanical conflict resolution. */
		const runCoordinator = async (task: string, strong = false): Promise<boolean> => {
			const coordLive: LiveSlot = { handle: sbx.inner! };
			const coordFinish = { value: "" };
			const coordinator = this.makeSliceRunner(
				job,
				session,
				{ index: 0, title: "Coordinator", task, owns: ["**"], env: null },
				sbx,
				coordLive,
				mode,
				coordFinish,
				true,
			);
			this.sliceAgents.push({ runner: coordinator, live: coordLive });
			const coordStarted = Date.now();
			await patchSliceRun(0, { task: "Merge coordinator", kind: "coordinator", status: "running", startedAt: new Date() });
			let coordErr: unknown;
			try {
				await coordinator.run(task, strong ? provider : await this.cheapProvider(provider));
			} catch (e) {
				coordErr = e;
			} finally {
				this.sliceAgents = this.sliceAgents.filter((a) => a.runner !== coordinator);
				this.finishedSliceRunners.push({ runner: coordinator, agentIndex: 0 });
				await patchSliceRun(0, {
					status: this.stopRequested ? "stopped" : coordErr ? "failed" : "done",
					finishedAt: new Date(),
					durationMs: Date.now() - coordStarted,
					...(coordErr ? { summary: String(coordErr).slice(0, 400) } : {}),
				});
			}
			if (coordErr)
				await this.sink.emit({ type: "info", text: `Coordinator pass failed: ${String(coordErr).slice(0, 200)}` });
			return !coordErr;
		};

		/** Seal whatever the coordinator left: finish an open merge, or commit
		 *  manifest/integration edits. Attachments/shots never commit. */
		const sealMerge = async (): Promise<void> => {
			const excludes = COMMIT_EXCLUDES.map((d) => `':(exclude)${d}'`).join(" ");
			const merging = await sbx.runIn(REPO_DIR, "git rev-parse -q --verify MERGE_HEAD", 15_000).catch(swallow("executor", "op"));
			if (merging?.exitCode === 0) {
				await sbx.runIn(REPO_DIR, `git add -A -- . ${excludes} && git commit --no-edit`, 60_000).catch(swallow("executor", "op"));
				return;
			}
			const dirty = await sbx.runIn(REPO_DIR, "git status --porcelain", 15_000).catch(swallow("executor", "op"));
			if (dirty?.stdout.trim())
				await sbx.runIn(REPO_DIR, `git add -A -- . ${excludes} && git commit -m ${JSON.stringify("multi: coordinator manifest/integration changes")}`, 60_000).catch(swallow("executor", "op"));
		};
		for (const s of slices) {
			const st = sliceState.get(s.index);
			if (st?.status !== "done") {
				results.push({ index: s.index, title: s.title, status: "failed", detail: st?.summary?.slice(0, 300) || "Slice did not complete" });
				continue;
			}
			const dep = /DEPENDENCY CHANGES:([\s\S]*)$/im.exec(st.summary ?? "")?.[1]?.trim();
			if (dep) {
				// Merge identical asks across slices — several agents often need the
				// same package; dedupe normalized lines, keep per-slice attribution.
				for (const line of dep.split("\n")) {
					const norm = line.trim().toLowerCase();
					if (norm && !seenDepLines.has(norm)) {
						seenDepLines.add(norm);
						depLines.push(`  ${line.trim()}  (slice ${s.index})`);
					}
				}
			}
			// Boundary audit: run_command bypasses guardWrite, so verify what the
			// slice actually changed (diff vs HEAD covers committed work too;
			// ls-files picks up new untracked files) and surface violations.
			const changed = await sbx
				.runIn(SLICE_DIR(s.index), "{ git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u", 30_000)
				.catch(swallow("executor", "op", { exitCode: 1, stdout: "", stderr: "" }));
			const violations = changed.stdout
				.trim()
				.split("\n")
				// COMMIT_EXCLUDES never land in the merge anyway — flagging them is noise.
				.filter((f) => f && !COMMIT_EXCLUDES.some((d) => f.startsWith(d)) && (!ownsMatch(s.owns, f) || isSharedManifest(f)));
			if (violations.length)
				await this.sink.emit(
					{ type: "info", text: `Slice ${s.index} (${s.title}) wrote outside its boundary: ${violations.slice(0, 5).join(", ")}${violations.length > 5 ? ` +${violations.length - 5}` : ""}` },
					{ agentIndex: 0 },
				);
			// Commit the slice's worktree changes onto its part branch — without
			// this the merge brings over nothing (writes stay uncommitted and
			// `worktree remove --force` would silently discard them).
			const dirty = await sbx
				.runIn(SLICE_DIR(s.index), "git status --porcelain", 15_000)
				.catch(swallow("executor", "op", { exitCode: 1, stdout: "", stderr: "" }));
			if (dirty.stdout.trim()) {
				await sbx
					.runIn(
						SLICE_DIR(s.index),
						`git add -A -- . ${COMMIT_EXCLUDES.map((d) => `':(exclude)${d}'`).join(" ")} && git commit -m ${JSON.stringify(`slice ${s.index}: ${s.title}`)}`,
						60_000,
					)
					.catch(swallow("executor", "op"));
			}
			const part = `${session.branch}-part-${s.index}`;
			const has = await sbx.runIn(REPO_DIR, `git rev-parse --verify ${JSON.stringify(part)}`, 15_000).catch(swallow("executor", "op"));
			if (!has || has.exitCode !== 0) {
				results.push({ index: s.index, title: s.title, status: "failed", detail: "part branch missing" });
				continue;
			}
			const m = await sbx
				.runIn(REPO_DIR, `git merge --no-ff ${JSON.stringify(part)} -m ${JSON.stringify(`merge slice ${s.index}: ${s.title}`)}`, 120_000)
				.catch(swallow("executor", "op", { exitCode: 1, stdout: "", stderr: "merge failed" }));
			if (m.exitCode === 0) {
				results.push({ index: s.index, title: s.title, status: "merged" });
				continue;
			}
			const files = (
				await sbx.runIn(REPO_DIR, "git diff --name-only --diff-filter=U", 30_000).catch(swallow("executor", "op", { stdout: "", exitCode: 1, stderr: "" }))
			).stdout
				.trim()
				.split("\n")
				.filter(Boolean);
			await this.sink.emit({ type: "fanin-conflict", index: s.index, files }, { agentIndex: 0 });
			// Resolve NOW: a conflicted repo refuses every later merge — leaving it
			// for the end would silently drop all subsequent slices' work.
			const resolved = await runCoordinator(
				[
					"A git merge is mid-conflict in this repo. Resolve the conflicted files (they contain <<<<<<< markers), keeping the intent of both sides.",
					`Conflicted files: ${files.join(", ") || "(run `git diff --name-only --diff-filter=U` to list them)"}`,
					"When done, ensure `git add -A` covers your resolutions — do NOT commit, push, or change branches.",
				].join("\n"),
			);
			if (resolved) await sealMerge();
			// An open merge blocks EVERY later merge — when the coordinator
			// failed (or left unmerged paths behind so `commit --no-edit`
			// couldn't seal it), abort back to a clean tree rather than
			// cascading the failure to all remaining slices.
			const stillMerging = await sbx.runIn(REPO_DIR, "git rev-parse -q --verify MERGE_HEAD", 15_000).catch(swallow("executor", "op"));
			const concluded = stillMerging?.exitCode !== 0;
			if (!concluded)
				await sbx.runIn(REPO_DIR, "git merge --abort", 30_000).catch(swallow("executor", "op"));
			this.throwIfStopped();
			results.push({
				index: s.index,
				title: s.title,
				status: concluded ? "resolved" : "failed",
				detail: concluded ? `conflicts in ${files.join(", ") || "unknown files"}` : "coordinator could not resolve conflicts",
			});
		}
		this.throwIfStopped();

		// Conflicts were resolved inline during the merge loop — the only
		// remaining coordinator work is deferred dependency/manifest changes
		// plus any proposed slices that couldn't run bounded (dropped work is
		// real feature work → strong model, not the mechanical cheap one).
		if (depLines.length || droppedSlices.length) {
			this.throwIfStopped();
			const parts = ["You are the merge coordinator for a parallel multi-agent run."];
			if (depLines.length)
				parts.push("Apply these deferred dependency/manifest changes reported by the slices:", depLines.join("\n"));
			if (droppedSlices.length)
				parts.push(
					"Also implement this work the planner proposed but that couldn't run as a bounded slice:",
					...droppedSlices.map((d) => `- ${d.title}: ${d.task}`),
				);
			parts.push("When done, ensure `git add -A` covers your changes — do NOT commit, push, or change branches.");
			await runCoordinator(parts.join("\n"), droppedSlices.length > 0);
		}
		await sealMerge();
		await this.sink.emit({ type: "fanin", results }, { agentIndex: 0 });
		// One-line outcome for the timeline — the fanin card shows detail, this
		// gives the partial-vs-total-failure signal at a glance.
		const cnt = (st: string) => results.filter((r) => r.status === st).length;
		await this.sink.emit({
			type: "info",
			text: `Fan-in complete: ${cnt("merged")} merged, ${cnt("resolved")} resolved, ${cnt("failed")} failed${droppedSlices.length ? `, ${droppedSlices.length} deferred to coordinator` : ""}.`,
		});

		// Worktree cleanup (branches stay — they're merged history).
		for (const s of slices) {
			await sbx.runIn(REPO_DIR, `git worktree remove --force ${SLICE_DIR(s.index)} 2>/dev/null || true`, 30_000).catch(swallow("executor", "op"));
		}

		this.throwIfStopped();
		await this.afterRun(job);
		this.throwIfStopped();
		// Checkpoint the merged fan-in tree before verify — same durability
		// argument as the single-agent tail.
		await sbx
			.commitAndPush(REPO_DIR, session.branch!, "kronyx: checkpoint before verify", COMMIT_EXCLUDES)
			.catch(async () => this.sink.emit({ type: "info", text: "Checkpoint push failed — continuing to verify." }));
		await this.sink.patchRun({ status: "verifying" }).catch(swallow("executor", "op"));
		await this.verify(sbx);
		this.throwIfStopped();
		await this.sink.patchRun({ status: "pushing" }).catch(swallow("executor", "op"));
		await this.pushAndPr(job, session, settings, sbx, token);
	}

	/**
	 * Cheapest model in the provider's catalog for mechanical calls (planner,
	 * merge coordinator) — same credentials, only modelId swapped. Falls back
	 * to the run's model when the catalog has no priced alternative.
	 */
	private cheap: ProviderSettings | undefined;
	private async cheapProvider(p: ProviderSettings): Promise<ProviderSettings> {
		if (this.cheap) return this.cheap;
		const models = await fetchModels(p.baseUrl, p.apiKey).catch(swallow("executor", "op", []));
		const price = (m: ModelOption | undefined) => (m?.pricing?.input ?? Infinity) + (m?.pricing?.output ?? Infinity);
		const cur = models.find((m) => m.id === p.modelId);
		const best = models.filter((m) => m.id !== p.modelId && price(m) < Infinity).sort((a, b) => price(a) - price(b))[0];
		if (!best || price(best) >= price(cur)) return p;
		this.cheap = { ...p, modelId: best.id };
		return this.cheap;
	}

	/** Planner: one cheap chat call returns the slice list (or null → single agent). */
	private async planSlices(
		job: CloudJob,
		provider: ProviderSettings,
		sbx: SandboxCore,
		fullTask: string,
	): Promise<ParsedSlices | null> {
		provider = await this.cheapProvider(provider);
		if (!provider.baseUrl || !provider.apiKey || !provider.modelId) return null;
		const tree = await sbx
			.runIn(REPO_DIR, `git ls-files | grep -v 'node_modules' | head -400 && echo '--- dirs ---' && find . -maxdepth 2 -type d | grep -v 'node_modules\\|\\.git' | head -60`, 30_000)
			.catch(swallow("executor", "op", { exitCode: 1, stdout: "", stderr: "" }));
		await this.sink.emit({ type: "cloud-status", text: "Planning agent slices…" });
		const base = provider.baseUrl.replace(/\/+$/, "");
		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
			body: JSON.stringify({
				model: provider.modelId,
				messages: [{ role: "user", content: DECOMPOSE_PROMPT(fullTask, tree.stdout, MAX_SLICES) }],
				max_tokens: 1500,
				temperature: 0,
			}),
			signal: AbortSignal.timeout(45_000),
		}).catch(swallow("planner", "op", null));
		if (!res?.ok) return null;
		const body = (await res.json().catch(swallow("planner", "op", null))) as { choices?: { message?: { content?: string } }[] } | null;
		return parseSlices(body?.choices?.[0]?.message?.content ?? "", MAX_SLICES);
	}

	private sliceTask(s: SliceSpec): string {
		return [
			`You are agent ${s.index} working on one slice of a larger task, in your own git worktree (an isolated checkout — use relative paths). Other agents are editing other parts of this same repository in parallel — stay strictly inside your assigned paths.`,
			"",
			`YOUR TASK: ${s.task}`,
			"",
			`WRITE BOUNDARY: you may only create/modify files matching: ${s.owns.join(", ")}. Writes outside these paths will be refused.`,
			`Shared root manifests (package.json, lockfiles, tsconfig, etc.) belong to a coordinator — do NOT edit them. If your work needs dependency or config changes there, finish your code and list the needed changes under a final line starting with "DEPENDENCY CHANGES:".`,
			`Do NOT run git commands that touch branches/commits (no checkout/merge/rebase/push) — the coordinator owns git.`,
			`Attachments (if any) live at ${REPO_DIR}/${ATTACH_DIR}/ — outside your worktree but readable.`,
			"",
			`End with a short summary of what you changed.`,
		].join("\n");
	}

	/** Slice/coordinator runner: minimal host — own worktree tools, boundary
	 *  guard on writes, events tagged with agentIndex. No browser/env tools. */
	private makeSliceRunner(
		job: CloudJob,
		session: SessionDoc,
		slice: SliceSpec,
		sbx: SandboxCore,
		sliceLive: LiveSlot,
		mode: AgentMode,
		finishText: { value: string },
		coordinator = false,
	): AgentRunner {
		const dir = coordinator ? REPO_DIR : SLICE_DIR(slice.index);
		const handle = delegatingHandle(sliceLive);
		let permLayers: PermissionLayers | undefined;
		const agentIndex = slice.index;
		return new AgentRunner({
			workspaceRoot: dir,
			relativePath: (abs) => abs.replace(`${dir}/`, ""),
			isDirty: () => false,
			confirmWrite: async (toolName, input) => {
				if (session.securityProfile !== "controlled") return true;
				return this.awaitPermission(job, toolName, input);
			},
			currentMode: () => mode,
			// Identical env string across slices → identical system-prompt
			// prefix → provider-side prompt caching can share it. Index-specific
			// context lives in the task text instead.
			environment: coordinator
				? "an E2B cloud sandbox — you are the merge coordinator finishing a parallel multi-agent run"
				: `an E2B cloud sandbox — one of several parallel agents working in a git worktree of the same repository`,
			log: (tag, msg) => console.log(`[slice${agentIndex}:${tag}] ${msg}`),
			checkPermission: async (toolName, input) => {
				if (!permLayers) {
					const settings = await loadUserSettings(this.db, job.uid).catch(() => undefined);
					const raw = settings?.data.permissions ?? settings?.data.permissionsJson;
					const global = typeof raw === "string" ? parsePermissionsText(raw) : parsePermissions(raw);
					const modes = parseModePermissions(raw);
					const project = parsePermissionsText((await sbx.readFile(`${dir}/.kronyx/permissions.json`).catch(() => null)) ?? "");
					permLayers = { global, project, local: { allow: [], ask: [], deny: [] }, modes };
				}
				return evaluate(permLayers, toolName, input, "agent");
			},
			saveTranscript: (messages) => {
				this.pendingSaves.push(saveTranscript(this.db, job.uid, job.sessionId, job.runId, messages, agentIndex).catch(swallow("executor", "op")));
			},
			createTools: () =>
				Promise.resolve([
					// save_plan is runner-gated to plan mode anyway — dropping it here
					// keeps a dead tool out of the slice schema.
					...createRemoteFileTools(handle, dir, {
						allowedPaths: coordinator ? undefined : slice.owns,
						onCommandOutput: (chunk) => this.queueToolOutput(chunk, agentIndex),
					}).filter((t) => t.name !== "save_plan"),
					memoryWriteTool(this.db, job.uid, job.sessionId, job.runId, this.embedProvider, session.repo ?? undefined),
				]) as Promise<never>,
			emit: (e) => {
				if (e.type === "run-finished") finishText.value = String(e.text ?? "");
				if (e.type !== "assistant-delta" && e.type !== "reasoning-delta") dbg("run", `s${agentIndex}:${e.type}`, e);
				this.trackUsage(e, job, agentIndex);
				void this.sink.emit(e, { agentIndex });
			},
		});
	}

	/**
	 * Fresh clone honoring the session's start point: lands the worktree on
	 * `startRef` (feature branch or pull/<n>/head) before the kronyx branch
	 * forks in ensureBranch. `base` is only healed to the detected default
	 * when it was never meaningfully set — a chosen feature branch stays.
	 */
	private async cloneStart(session: SessionDoc, sbx: SandboxCore, token: string): Promise<void> {
		const defaultBranch = await sbx.cloneRepo(`https://github.com/${session.repo}`, token, REPO_DIR);
		if (!session.base || (session.base === "main" && defaultBranch && defaultBranch !== "main")) {
			session.base = defaultBranch || session.base;
			await this.sink.patchSession({ base: session.base });
		}
		await this.sink.patchSession({ cloned: true });
		session.cloned = true;
		const startRef = String(session.startRef ?? session.base ?? "");
		if (!startRef || startRef === (defaultBranch || "main")) return;
		const r = await sbx
			.runIn(REPO_DIR, `git fetch origin ${JSON.stringify(startRef)} && git checkout -B .kronyx-start FETCH_HEAD`, 120_000)
			.catch(swallow("executor", "op", { exitCode: 1, stdout: "", stderr: "" }));
		await this.sink.emit({
			type: "info",
			text:
				r?.exitCode === 0
					? `Starting from ${startRef}`
					: `Could not fetch ${startRef} — starting from ${defaultBranch || "the default branch"}`,
		});
	}

	private async ensureBranch(job: CloudJob, session: SessionDoc, sbx: SandboxCore, token: string): Promise<void> {
		const base = session.base ?? "main";
		// Refresh the remote credential up front — the clone URL embeds a token
		// that expires, and every fetch/push below (plus the agent's own git
		// commands) hits the stale URL.
		if (session.repo && token) {
			await this.sink.emit({ type: "cloud-status", text: `Refreshing git credentials and syncing ${session.branch ?? base}…` });
			await this.syncGhAuth(sbx, session.repo, token);
		}
		if (!session.branch) {
			const branch = `kronyx/${slugify(job.task)}-${job.runId.replace(/^web-/, "").slice(0, 6)}`;
			// Fork from the fetched start point, not local HEAD — a warm clone
			// can be arbitrarily stale (ask/plan runs never sync the repo).
			// Same startRef semantics as cloneStart; falls back to local HEAD.
			const startRef = String(session.startRef ?? "").trim() || base;
			const f = await sbx
				.runIn(REPO_DIR, `git fetch origin ${JSON.stringify(startRef)}`, 120_000)
				.catch(swallow("executor", "op", { exitCode: 1, stdout: "", stderr: "" }));
			const c =
				f.exitCode === 0
					? await sbx.runIn(REPO_DIR, `git checkout -B ${JSON.stringify(branch)} FETCH_HEAD`, 60_000).catch(swallow("executor", "op"))
					: null;
			if (c?.exitCode === 0) {
				if (startRef !== base) await this.sink.emit({ type: "info", text: `Starting from ${startRef}` });
			} else {
				await this.sink.emit({ type: "info", text: `Could not check out ${startRef} — branching from the local checkout.` });
				await sbx.createBranch(REPO_DIR, branch);
			}
			await this.sink.patchSession({ branch });
			session.branch = branch;
			await this.sink.emit({ type: "info", text: `Created branch ${branch}` });
			// Push immediately — the branch should be visible on the remote from
			// the first tool call, not only at PR time. Non-fatal on failure.
			const p = await sbx
				.runIn(REPO_DIR, `git push -u origin ${JSON.stringify(branch)}`, 60_000)
				.catch(swallow("executor", "op", { exitCode: 1, stdout: "", stderr: "" }));
			if (p.exitCode !== 0)
				await this.sink.emit({ type: "info", text: "Couldn't push the new branch yet — it will be pushed with the first commits." });
			return;
		}
		// Reconcile local branch vs origin/<branch> BEFORE any work:
		// ahead/behind counts decide — pull clean, keep unpushed commits,
		// rebase divergence now, or stop and ask the user.
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
		// Uncommitted leftovers (usually crash debris) are stashed before a
		// sync, then restored — never silently orphaned in `git stash`.
		let stashed = false;
		const stash = async () => {
			if (!dirty) return;
			const r = await sbx.runIn(REPO_DIR, "git stash push -m kronyx-autosave").catch(swallow("executor", "op"));
			stashed = r?.exitCode === 0 && !r.stdout.includes("No local changes");
			if (stashed) await this.sink.emit({ type: "info", text: "Stashed uncommitted changes to sync the latest branch." });
		};
		const unstash = async () => {
			if (!stashed) return;
			const r = await sbx.runIn(REPO_DIR, "git stash pop").catch(swallow("executor", "op"));
			if (r?.exitCode !== 0)
				await this.sink.emit({ type: "info", text: "Stashed changes couldn't be auto-restored (conflict with the pulled code) — kept in `git stash`." });
		};
		if (ahead === 0) {
			// Strictly behind — pull latest.
			await stash();
			const r = await sbx.runIn(REPO_DIR, `git reset --hard origin/${branch}`).catch(swallow("executor", "op"));
			if (r?.exitCode === 0) await this.sink.emit({ type: "cloud-status", text: `Synced to origin/${branch} (${behind} commit(s)).` });
			await unstash();
			return;
		}
		// Diverged — rebase now rather than at push time.
		await this.sink.emit({ type: "info", text: `Branch diverged: ${ahead} local / ${behind} remote commit(s) — rebasing first…` });
		await stash();
		const ok = await sbx.rebaseOnto(REPO_DIR, branch);
		if (!ok) {
			throw new Error(
				`Remote branch ${branch} diverged and the auto-rebase hit conflicts. ` +
					"Resolve manually or start a new session branch — refusing to work on top of a conflicted state." +
					(stashed ? " Uncommitted changes are preserved in `git stash`." : ""),
			);
		}
		await this.sink.emit({ type: "cloud-status", text: `Rebased ${ahead} commit(s) onto origin/${branch}.` });
		await unstash();
	}

	/**
	 * Synchronous environment swap executed inside the switch_environment tool
	 * call: interim-commit → create the new VM FIRST (old stays usable on
	 * failure) → detach old → reclone + checkout the branch → rebind handles.
	 */
	private async performTemplateSwitch(
		job: CloudJob,
		session: SessionDoc,
		settings: UserSettings,
		getSbx: () => SandboxCore,
		setSbx: (next: SandboxCore) => void,
		live: LiveSlot,
		token: string,
		req: { template: string; reason: string; evidence: string },
	): Promise<string> {
		this.switchCount++;
		await this.sink.emit({
			type: "cloud-status",
			text: `Switching VM to template "${req.template}" — ${req.reason.slice(0, 160)}`,
		});
		await this.sink.emit({ type: "info", text: `Switch evidence: ${req.evidence.slice(0, 200)}` });
		const old = getSbx();
		// Interim commit so the new VM resumes from real pushed work (plan mode
		// is read-only — nothing to commit, branch may not exist yet).
		if (job.mode !== "plan" && session.branch && session.repo && token) {
			await this.sink.emit({ type: "info", text: "Committing work-in-progress before the switch…" });
			await old
				.commitAndPush(REPO_DIR, session.branch, "kronyx: interim commit before template switch", COMMIT_EXCLUDES)
				.catch((e) => this.sink.emit({ type: "info", text: `Interim commit skipped (${String(e).slice(0, 120)}) — continuing anyway` }));
		}
		// Detach the old sandbox BEFORE creating — ensureSandbox would otherwise
		// "reconnect" to it and return the same VM.
		session.sandboxId = undefined;
		session.cloned = false;
		await this.sink.patchSession({ sandboxId: null, cloned: false, template: req.template });
		const next = await this.ensureSandbox(session, settings, { template: req.template });
		if (session.repo && token) {
			const defaultBranch = await next.cloneRepo(`https://github.com/${session.repo}`, token, REPO_DIR);
			await this.sink.patchSession({ cloned: true, ...(defaultBranch ? { base: defaultBranch } : {}) });
			session.cloned = true;
			if (defaultBranch) session.base = defaultBranch;
			if (session.branch) {
				await next
					.runIn(REPO_DIR, `git fetch origin ${session.branch} && git checkout ${session.branch}`, 60_000)
					.catch(swallow("executor", "op"));
			}
		}
		setSbx(next);
		live.handle = next.inner!;
		await old.close().catch(swallow("executor", "op"));
		await this.sink.emit({ type: "cloud-status", text: `Switched to "${req.template}" — resuming on the new VM` });
		return (
			`Switched to "${req.template}". You are now on a fresh VM: the repo is recloned at ${REPO_DIR} ` +
				`on branch ${session.branch ?? session.base}, and your pushed work is there. ` +
				`Confirm the capability you needed is present, then continue the task.`
		);
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
		let skipped = "";
		if (cmd === "npm test --if-present") {
			// A fresh clone has no deps — the test run can only fail (or die
			// with the sandbox); skip it rather than burn the 5-min cap.
			const hasModules = await sbx.runIn(REPO_DIR, "test -d node_modules && echo yes").catch(swallow("executor", "op"));
			if (!hasModules?.stdout.includes("yes")) skipped = "skipped — no node_modules in the clone";
		}
		if (skipped) {
			await this.sink.emit({ type: "check", command: cmd, ok: true, durationMs: 0, output: skipped });
			results.push(`${cmd} → ${skipped}`);
		} else if (cmd) {
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
		await this.captureScreenshot(sbx, `http://localhost:${port}`);
		return `boot → ${ok ? "passed" : "failed"} (:${port} → ${code})`;
	}

	/** Tier-2 verify: Playwright screenshot of the booted app → run doc + timeline event. */
	private async captureScreenshot(sbx: SandboxCore, url: string): Promise<void> {
		const probe = await sbx.runIn("/", `python3 -c "import playwright" 2>/dev/null`, 15_000).catch(swallow("executor", "op"));
		if (!probe || probe.exitCode !== 0) return; // stock template — no browser tooling
		await sbx.writeFile(BROWSER_DRIVER_PATH, BROWSER_DRIVER);
		const r = await sbx
			.runIn(REPO_DIR, `python3 ${BROWSER_DRIVER_PATH} --shot ${JSON.stringify(url)} --out ${SCREENSHOT_PATH}`, 60_000)
			.catch(swallow("executor", "op"));
		const b64 = r?.stdout.split("\n").find((l) => l.startsWith("KRONYX_SHOT:"))?.slice("KRONYX_SHOT:".length);
		// Keep Mongo docs modest — skip pathological captures.
		if (!b64 || b64.length > 800_000) return;
		const dataUrl = `data:image/png;base64,${b64}`;
		await this.sink.emit({ type: "ui-screenshot", url, dataUrl });
		await this.sink.patchRun({ screenshot: dataUrl }).catch(swallow("executor", "op"));
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
		const wantPr = job.kind === "open-pr" || job.mode === "agent" || job.mode === "multi";
		const status = await sbx.runIn(REPO_DIR, "git status --porcelain");
		const dirty = status.stdout.trim() !== "";
		// For normal runs, clean tree = nothing to do; for open-pr jobs the
		// branch may be clean but still ahead — fall through to push/PR.
		if (!dirty && !wantPr) {
			await this.sink.emit({ type: "info", text: "No changes to push." });
			return;
		}
		// Clean tree on a PR run: only open one when the branch actually has
		// commits over base — an agent that changed nothing must not produce
		// an empty PR (e.g. it reported an environment limitation).
		if (!dirty && session.branch && session.base) {
			const ahead = await sbx
				.runIn(REPO_DIR, `git rev-list --count origin/${session.base}..HEAD 2>/dev/null || git rev-list --count ${session.base}..HEAD`, 30_000)
				.catch(swallow("executor", "op"));
			const commits = Number(ahead?.stdout.trim()) || 0;
			if (commits === 0) {
				await this.sink.emit({ type: "info", text: "No changes on the branch — skipping PR." });
				return;
			}
		}
		// Emit per-file diffs so the timeline shows editor-style change cards —
		// covers writes made via shell (cat >), which bypass fs-tool events.
		for (const line of status.stdout.split("\n").filter((l) => l.trim())) {
			const kind = line.slice(0, 2).trim();
			const rel = line.slice(3).trim().replace(/^"|"$/g, "");
			if (!rel || COMMIT_EXCLUDES.some((d) => rel.startsWith(d))) continue;
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
			await sbx.commitAndPush(REPO_DIR, session.branch, `kronyx: ${job.task.slice(0, 60)}`, COMMIT_EXCLUDES);
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
			await sbx.commitAndPush(REPO_DIR, session.branch, `kronyx: ${job.task.slice(0, 60)}`, COMMIT_EXCLUDES);
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
			await this.cloneStart(session, sbx, token);
		}
		await this.ensureBranch(job, session, sbx, token);
		await sbx.writeFile(`${REPO_DIR}/.kronyx/plans/${job.planSlug}.md`, String(plan.markdown));
		await sbx.runIn(REPO_DIR, "mkdir -p .kronyx/plans").catch(swallow("executor", "op"));
		await sbx.commitAndPush(REPO_DIR, session.branch!, `kronyx: plan ${job.planSlug}`, COMMIT_EXCLUDES);
		await this.sink.emit({ type: "info", text: `Pushed .kronyx/plans/${job.planSlug}.md to ${session.branch}` });
	}
}
