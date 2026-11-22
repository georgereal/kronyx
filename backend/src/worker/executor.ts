import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Db } from "mongodb";
import { dbg, swallow } from "../lib/log";
import { AgentRunner, type AgentMode, type ProviderSettings, type RunnerAttachment, type RunViewEvent } from "../../../src/agent/runner";
import { acceptsImages } from "../../../src/agent/vision";
import { deriveMessages, type KronyxEvent } from "../../../src/agent/events";
import { getProvider, type ProviderCreds, type SandboxHandle, type SandboxProvider } from "../../../src/sandbox/provider";
import { SandboxCore, openPr } from "../../../src/sandbox/sandboxCore";
import { isSandboxDeath, isSandboxUnresponsive } from "../../../src/sandbox/errors";
import { createRemoteFileTools } from "../../../src/tools/remoteFileTools";
import { createFetchTools } from "../../../src/tools/fetchTools";
import { BROWSER_DRIVER, BROWSER_DRIVER_PATH, SCREENSHOT_PATH, createBrowserTools } from "../../../src/tools/browserTools";
import { createEnvTools } from "../../../src/tools/envTools";
import { createMcpTools, type McpServerConfig, type McpToolSet } from "../../../src/tools/mcpTools";
import { isAgentCliTemplate, resolveTemplateName, type TemplateInfo } from "../../../src/sandbox/templateCatalog";
import { pickTemplate } from "./pickTemplate";
import { installationToken } from "../lib/githubApp";
import { fetchModels, type ModelOption } from "../lib/models";
import { getCache } from "./cache";
import { recordSandboxEvent } from "../lib/sandboxEvents";
import { listPlans, loadPlan, savePlanFile } from "../lib/planStore";
import { newDumpRef, saveDump } from "../lib/dumpStore";
import { FLAGS, flag, flagOff } from "../lib/flags";
import { githubPat, loadUserSettings, resolveProvider, type UserSettings } from "./settings";
import { IMAGE_RECIPES } from "./imageRecipes";
import { buildE2bTemplate } from "../lib/e2bTemplateBuild";
import { DEP_FILES, decideWarm, depsFingerprint, stderrTail, type WarmDoc } from "./warmState";
import type { RunSink } from "./events";
import type { AgentMessage } from "@cline/shared";
import type { PriorTranscript } from "../../../src/agent/recall";
import { evaluate, parseModePermissions, parsePermissions, parsePermissionsText, type PermissionLayers } from "../../../src/agent/permissions";
import { DECOMPOSE_PROMPT, isSharedManifest, ownsMatch, parseSlices, type ParsedSlices, type SliceSpec } from "../../../src/agent/decompose";
import { isTrivialTask } from "../../../src/agent/taskGuard";
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
	type MemoryDoc,
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
/** Hard cap on sandbox start (connect/resume/create ladder) — interruptible sooner via stop. */
const SANDBOX_START_MS = Number(process.env.SANDBOX_START_TIMEOUT_MS) || 240_000;
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
	kind?: "run" | "push-plan" | "open-pr" | "bake" | "template-build";
	planSlug?: string | null;
	/** Image recipe key (kind: "bake") or template name (kind: "template-build"). */
	recipe?: string;
	/** Inline recipe from the UI wizard (kind: "bake") — wins over `recipe`. */
	customRecipe?: { imageName: string; commands: string; verify?: string; timeoutMs?: number };
	/** Repo-scoped bake: clone this repo before running the recipe → kronyx-repo-<key>. */
	repo?: string;
	installationId?: number;
	/** Generated Dockerfile (kind: "template-build") — wins over the bundled one. */
	dockerfile?: string;
}

interface SessionDoc {
	sessionId: string;
	repo?: string;
	base?: string;
	/** Ref to check out at clone time — feature branch or pull/<n>/head. */
	startRef?: string;
	/** Previous kronyx branch after a per-task start-point change — dirty
	 *  worktree state is checkpointed to it before the new branch forks. */
	resetFrom?: string | null;
	branch?: string;
	sandboxId?: string;
	installationId?: number;
	extraRepos?: { repo: string; installationId?: number | null }[];
	template?: string | null;
	provider?: string | null;
	securityProfile?: string;
	cloned?: boolean;
	prUrl?: string;
	/** Latest E2B snapshot of the session sandbox (WIP checkpoints) —
	 *  lets a dead VM resume its full disk instead of recloning. */
	lastSnapshotId?: string;
}

export interface RunExecutor {
	run(job: CloudJob): Promise<void>;
}

/** Filler words that make task-derived branch names useless ("ok lets fix these"). */
const SLUG_FILLER = new Set(
	`ok lets let's please can could would should need want make the a an this these that those it its to for and on in of my me we i do does before after go going ahead now just also them be is are up out all some any as per with use using changes change fix fixed fixes`.split(" "),
);

const slugify = (s: string) => {
	const words = s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !SLUG_FILLER.has(w));
	return (words.length ? words : s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)).slice(0, 6).join("-").slice(0, 32).replace(/-+$/g, "") || "run";
};

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
	/** Set when a tool call rejects with a sandbox-death signature — the
	 *  side-channel the executor recovers from (thrown tool errors reach the
	 *  agent as tool-result text, so the run can't rely on the throw alone). */
	dead?: unknown;
	/** Called the moment death is detected — aborts the in-flight run. */
	onDead?: (err: unknown) => void;
	/** Rebound per run — browser screenshots emit on the current run's sink. */
	onScreenshot?: (dataUrl: string, label?: string) => void;
	/** Set by the switch_environment tool while a swap is in flight (dedup). */
	templateRequest?: { template: string; reason: string; evidence: string };
	/** Rebound per run — performs the VM swap synchronously inside the tool call. */
	performSwitch?: (req: { template: string; reason: string; evidence: string }) => Promise<string>;
	/** Rebound per run — the account's usable E2B templates for switch validation. */
	templates?: TemplateInfo[];
}

export const delegatingHandle = (live: LiveSlot): SandboxHandle => {
	/** Consecutive deadline/timeout rejects — one slow command isn't a dead
	 *  VM, but sustained unresponsiveness means envd is wedged. */
	let unresponsive = 0;
	const latch = (err: unknown) => {
		live.dead = err;
		live.stopped = true;
		live.onDead?.(err);
	};
	/** A rejected call with a death signature latches the slot — every later
	 *  call fails fast and the executor's onDead hook stops the run. Wedged
	 *  VMs (deadline_exceeded on everything) latch after 3 consecutive
	 *  failures, confirmed by a probe before condemning — the recovery path
	 *  can still preserve the disk. */
	const died = async (err: unknown): Promise<never> => {
		if (isSandboxDeath(err)) latch(err);
		else if (isSandboxUnresponsive(err) && ++unresponsive >= 3) {
			const ok = live.handle
				? await live.handle.run("echo ok", { cwd: "/", timeoutMs: 20_000 }).then(() => true).catch(() => false)
				: false;
			if (ok) unresponsive = 0;
			else latch(err);
		}
		throw err;
	};
	return {
	get id() {
		return live.handle?.id ?? "";
	},
	run: (command, opts) => {
		if (live.stopped) return Promise.resolve({ exitCode: 130, stdout: "", stderr: "interrupted" });
		return live.handle
			? live.handle.run(command, opts).then((r) => {
					unresponsive = 0;
					return r;
				}, died)
			: Promise.reject(new Error("Sandbox handle not bound."));
	},
	readFile: (path) => {
		if (live.stopped) return Promise.reject(new Error("Sandbox stopped."));
		return live.handle
			? live.handle.readFile(path).then((r) => {
					unresponsive = 0;
					return r;
				}, died)
			: Promise.reject(new Error("Sandbox handle not bound."));
	},
	writeFile: async (path, content) => {
			if (live.stopped) throw new Error("Sandbox stopped.");
			if (!live.handle) throw new Error("Sandbox handle not bound.");
			return live.handle.writeFile(path, content).then(
				(r) => {
					unresponsive = 0;
					return r;
				},
				died,
			);
		},
	setTimeout: (timeoutMs) => live.handle?.setTimeout?.(timeoutMs) ?? Promise.resolve(),
	interrupt: () => live.handle?.interrupt?.() ?? Promise.resolve(),
	};
};

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
	/** MCP toolsets shared process-wide — server connections persist across
	 *  jobs like the runner cache; keyed by config so edits respawn. */
	private static mcpCache = new Map<string, { set: McpToolSet; secrets: Set<string>; lastUsedAt: number }>();
	private static readonly MCP_CACHE_MAX = 10;

	/** MCP servers from user settings → agent tools. Runs on the worker host
	 *  (not inside E2B) — tools see the host, not the cloned repo. */
	private async mcpToolsFor(settings: UserSettings): Promise<import("@cline/shared").AgentTool<any, string>[]> {
		const servers = (settings.data.mcpServers ?? []) as McpServerConfig[];
		if (!servers.length) return [];
		const key = JSON.stringify(servers);
		let entry = E2bOrchestratedExecutor.mcpCache.get(key);
		if (!entry) {
			const secrets = new Set<string>();
			const set = await createMcpTools({
				servers,
				onSecret: (v) => secrets.add(v),
				log: (m) => dbg("mcp", m),
			});
			entry = { set, secrets, lastUsedAt: Date.now() };
			E2bOrchestratedExecutor.mcpCache.set(key, entry);
			if (E2bOrchestratedExecutor.mcpCache.size > E2bOrchestratedExecutor.MCP_CACHE_MAX) {
				let oldestKey: string | undefined;
				let oldestAt = Infinity;
				for (const [k, e] of E2bOrchestratedExecutor.mcpCache) {
					if (e.lastUsedAt < oldestAt) {
						oldestAt = e.lastUsedAt;
						oldestKey = k;
					}
				}
				if (oldestKey && oldestKey !== key) {
					const old = E2bOrchestratedExecutor.mcpCache.get(oldestKey);
					E2bOrchestratedExecutor.mcpCache.delete(oldestKey);
					void old?.set.close().catch(() => {});
				}
			}
		}
		entry.lastUsedAt = Date.now();
		for (const s of entry.secrets) this.sink.mask(s);
		return entry.set.tools;
	}
	/** The run's current sandbox (rebound on switch_environment) + its keepalive. */
	private activeSbx: SandboxCore | undefined;
	private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
	/** Agent's run-finished text — carried into the run-completed card. */
	private lastRunSummary = "";
	/** Per-run outcome rollup for the run-completed event. */
	private lastPrUrl: string | undefined;
	private lastPushed = false;
	/** HEAD sha captured at run end — stamped onto this run's digests in afterRun. */
	private lastHeadSha: string | undefined;
	private readonly runChecks: { command: string; ok: boolean }[] = [];
	/** Last context-compaction stats — folded into the run-completed rollup. */
	private lastCompaction: { estTokensBefore?: number; estTokensAfter?: number } | undefined;

	/** Extend E2B lifetime + refresh janitor activity every 10 min while a run
	 *  is in flight — `lastActivityAt` is otherwise only stamped once at run
	 *  start, and a >60min run outlives the sandbox's initial timeout. */
	private startSandboxKeepalive(sbx: SandboxCore): void {
		this.stopSandboxKeepalive();
		this.activeSbx = sbx;
		this.keepaliveTimer = setInterval(() => {
			const cur = this.activeSbx;
			if (!cur) return;
			void cur.keepalive(60).catch((err: unknown) => {
				// Dead VM → keepalive is pointless; stop instead of logging every tick.
				if (isSandboxDeath(err)) {
					this.stopSandboxKeepalive();
					return;
				}
				swallow("executor", "op")(err);
			});
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
	/** Resolved by requestStop — lets blocking setup calls (sandbox create) bail mid-await. */
	private stopWaiters: (() => void)[] = [];
	/** Mid-run VM swaps this job has already used (cap: 2). */
	private switchCount = 0;
	/** Current run's session — stopCleanup needs it for the WIP checkpoint. */
	private activeSession: SessionDoc | undefined;

	/** Stop at the next safe point: aborts a live agent AND gates setup/run phases. */
	requestStop(): void {
		this.stopRequested = true;
		this.stopWaiters.splice(0).forEach((fn) => fn());
		// Capture before stopSandboxKeepalive clears activeSbx.
		const sbx = this.activeSbx;
		const session = this.activeSession;
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
		// Kill forked slice VMs first — a stop mid-fan-in otherwise leaves them
		// running until the janitor finds them idle.
		void this.killSliceForks().catch(swallow("executor", "op"));
		// Cleanup runs on a small delay: interrupt lands first, then detached
		// leftovers are killed and uncommitted work is checkpointed to the
		// session branch so a later sandbox death can't lose it.
		setTimeout(() => void this.stopCleanup(sbx, session).catch(swallow("executor", "op")), 1500);
	}

	/** Manual compact (POST /api/runs/:id/compact → control flag polled by the
	 *  worker loop): applies on each agent's next model turn. */
	requestCompact(): void {
		this.runner?.requestCompact();
		for (const s of this.sliceAgents) s.runner.requestCompact();
	}

	/** Post-interrupt housekeeping: kill detached agent processes (setsid'd
	 *  run_command scripts are invisible to handle.interrupt) and push the
	 *  worktree's uncommitted state to the session branch. All best-effort. */
	private async stopCleanup(sbx: SandboxCore | undefined, session: SessionDoc | undefined): Promise<void> {
		if (!sbx || !session) return;
		// Group-kill detached kronyx-cmd scripts (each is a setsid pgid leader —
		// killing the group takes backgrounded installs/builds with it) plus
		// the browser driver and any leftover checkpoint pushes.
		await sbx
			.runIn(
				"/",
				`for p in $(pgrep -f '/tmp/kronyx-cmd-' 2>/dev/null); do kill -KILL -"$p" 2>/dev/null; done; pkill -f 'kronyx_browser_use' 2>/dev/null; true`,
				15_000,
			)
			.catch(swallow("executor", "op"));
		if (!session.repo || !session.branch) return;
		const dirty = await sbx
			.runIn(REPO_DIR, "git status --porcelain", 15_000)
			.catch(swallow("executor", "op", { exitCode: 1, stdout: "", stderr: "" }));
		if (dirty.exitCode !== 0 || !dirty.stdout.trim()) return;
		await this.sink.emit({ type: "cloud-status", text: `Saving uncommitted work to ${session.branch}…` }).catch(swallow("executor", "op"));
		const ok = await sbx
			.commitAndPush(REPO_DIR, session.branch, "kronyx: checkpoint (stopped)", COMMIT_EXCLUDES)
			.then(() => true)
			.catch(swallow("executor", "op", false));
		await this.sink
			.emit({ type: "info", text: ok ? `Uncommitted work pushed to ${session.branch} (stop checkpoint).` : "Couldn't checkpoint uncommitted work — sandbox may be unreachable." })
			.catch(swallow("executor", "op"));
	}

	private throwIfStopped(): void {
		if (this.stopRequested) throw new Error("Stopped by user");
	}

	/**
	 * Race a blocking setup call (ensureSandbox, sbx.create) against the stop
	 * signal and a hard timeout. The underlying promise keeps running — if it
	 * eventually produces a SandboxCore we close it so no VM leaks untracked.
	 */
	private raceStop<T>(p: Promise<T>, ms: number, label: string, sessionSandboxId?: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const fail = (err: Error) => {
				clearTimeout(timer);
				p.then((v) => {
					// Close only a genuinely new VM — when ensureSandbox reused the
					// session's warm sandbox it returns the same id, and killing it
					// here would orphan the session's worktree for no reason.
					if (v instanceof SandboxCore && v.sandboxId !== sessionSandboxId) void v.close().catch(swallow("executor", "op"));
				}).catch(() => {});
				reject(err);
			};
			const timer = setTimeout(() => fail(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
			if (this.stopRequested) return fail(new Error("Stopped by user"));
			this.stopWaiters.push(() => fail(new Error("Stopped by user")));
			p.then(
				(v) => {
					clearTimeout(timer);
					resolve(v);
				},
				(err) => {
					clearTimeout(timer);
					reject(err);
				},
			);
		});
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

	/** Paths already streamed live via fs-tool writes — the tail git-diff skips
	 *  them so their cards don't double-render as orphan events. */
	private liveChangedPaths = new Set<string>();
	/** WIP checkpoint cadence: commit+push dirty work every ~10 writes or ~5min,
	 *  so a mid-run VM death can't lose uncommitted changes (Stop checkpoint
	 *  only covers user stops). */
	private writeCount = 0;
	private lastWipCheckpointAt = 0;
	private wipTimer: ReturnType<typeof setTimeout> | undefined;

	private emitLiveFileChanged(
		rel: string,
		kind: "created" | "modified",
		stats: { added: number; removed: number; diff: string },
		agentIndex = 0,
	): void {
		this.liveChangedPaths.add(`${agentIndex}:${rel}`);
		this.writeCount++;
		this.maybeWipCheckpoint();
		void this.sink
			.emit({ type: "file-changed", path: rel, kind, ...stats }, agentIndex ? { agentIndex } : undefined)
			.catch(swallow("executor", "op"));
	}

	private maybeWipCheckpoint(): void {
		if (this.stopRequested || this.wipTimer) return;
		const due = this.writeCount >= 10 || Date.now() - this.lastWipCheckpointAt > 5 * 60_000;
		if (!due) return;
		this.wipTimer = setTimeout(() => {
			this.wipTimer = undefined;
			void this.wipCheckpoint().catch(swallow("executor", "op"));
		}, 3000);
	}

	/** Commit+push the dirty worktree(s): main repo on session.branch, plus any
	 *  multi-slice worktrees (repo-wt<N>) on their -part-N branches. */
	private async wipCheckpoint(): Promise<void> {
		const sbx = this.activeSbx;
		const session = this.activeSession;
		if (!sbx || !session?.branch || !session.repo || this.stopRequested) return;
		this.lastWipCheckpointAt = Date.now();
		this.writeCount = 0;
		const dirty = await sbx.runIn(REPO_DIR, "git status --porcelain", 15_000).catch(swallow("executor", "op"));
		let pushed = false;
		if (dirty?.stdout.trim()) {
			pushed = await sbx
				.commitAndPush(REPO_DIR, session.branch, "kronyx: wip checkpoint", COMMIT_EXCLUDES)
				.then(() => true)
				.catch(swallow("executor", "op", false));
		}
		// Slice worktrees (multi runs): same deal, on their part branches.
		const wts = await sbx
			.runIn("/", "ls -d /home/user/repo-wt* 2>/dev/null", 15_000)
			.catch(swallow("executor", "op", { exitCode: 1, stdout: "", stderr: "" }));
		for (const line of wts.stdout.split("\n").map((l) => l.trim()).filter((l) => /\/repo-wt\d+$/.test(l))) {
			const n = line.match(/repo-wt(\d+)$/)![1];
			const d = await sbx.runIn(line, "git status --porcelain", 15_000).catch((err: unknown) => {
				if (isSandboxDeath(err)) return "dead" as const;
				swallow("executor", "op")(err);
				return undefined;
			});
			if (d === "dead") break; // VM gone — remaining slices would just re-log the same death
			if (!d?.stdout.trim()) continue;
			const partBranch = `${session.branch}-part-${n}`;
			const ok = await sbx
				.runIn(line, `git add -A && git -c user.name=Kronyx -c user.email=kronyx@local commit -qm "kronyx: wip checkpoint" && git push -u origin ${JSON.stringify(partBranch)}`, 60_000)
				.then((r) => r.exitCode === 0)
				.catch(() => false);
			if (ok) pushed = true;
		}
		// Forked VMs' TTL only extends via setTimeout — activity doesn't
		// keep them alive, so a long slice would die at the fork default.
		for (const h of this.sliceForks.values()) void h.setTimeout?.(60 * 60_000).catch(() => {});
		// Forked slices (flags.sliceFork): each lives on its own VM, invisible
		// to ls on the coordinator — checkpoint over their handles directly.
		for (const [n, h] of this.sliceForks) {
			const d = await h.run("git status --porcelain", { cwd: REPO_DIR, timeoutMs: 15_000 }).catch((err: unknown) => {
				if (isSandboxDeath(err)) return "dead" as const;
				swallow("executor", "op")(err);
				return undefined;
			});
			if (d === "dead") break; // forked VM gone — remaining probes would just re-log the same death
			if (!d?.stdout.trim()) continue;
			const partBranch = `${session.branch}-part-${n}`;
			const ok = await h
				.run(
					`git add -A && git -c user.name=Kronyx -c user.email=kronyx@local commit -qm "kronyx: wip checkpoint" && git push -u origin ${JSON.stringify(partBranch)}`,
					{ cwd: REPO_DIR, timeoutMs: 60_000 },
				)
				.then((r) => r.exitCode === 0)
				.catch(() => false);
			if (ok) pushed = true;
		}
		if (pushed) {
			this.lastPushed = true;
			await this.sink.emit({ type: "info", text: "Checkpointed uncommitted work to the branch." }).catch(swallow("executor", "op"));
		}
		// Full-disk snapshot: covers what git can't — node_modules, untracked
		// files, env/db state. A VM loss after this can resume the whole
		// worktree, not just pushed commits. Filesystem mode — recovery
		// cold-boots anyway, so skipping memory keeps it small/fast. The
		// session records the latest snapshot id; the superseded one is
		// deleted so checkpoints don't accumulate unboundedly.
		if (await flag(this.db, { uid: this.sink.uid, repo: session.repo ?? undefined, template: session.template ?? undefined, sessionId: session.sessionId }, FLAGS.snapshotCheckpoints)) {
			const snap = await sbx.checkpoint({ mode: "filesystem", name: `kronyx-wip-${session.sessionId}` }).catch(swallow("executor", "op", null));
			if (snap && snap !== session.lastSnapshotId) {
				const prev = session.lastSnapshotId;
				session.lastSnapshotId = snap;
				await this.sink.patchSession({ lastSnapshotId: snap });
				if (prev) await sbx.deleteSnapshot(prev).catch(swallow("executor", "op", false));
			}
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
		// Mode is part of the key — a plan-mode runner must never be reused for
		// an agent job (its currentMode/toolset are bound at creation).
		const key = `${job.sessionId}:${kind}:${mode}:${fp}`;
		const now = Date.now();
		for (const [k, e] of E2bOrchestratedExecutor.runnerCache) {
			if (!e.runner.isRunning && now - e.lastUsedAt > E2bOrchestratedExecutor.RUNNER_TTL_MS) {
				e.runner.stop();
				E2bOrchestratedExecutor.runnerCache.delete(k);
			}
		}
		const cached = E2bOrchestratedExecutor.runnerCache.get(key);
		if (cached) {
			// Manual "clear context" (POST /api/sessions/:id/clear) — drop the live
			// agent so this run starts fresh, digests still carried forward.
			if ((session as { clearRequested?: boolean }).clearRequested) {
				void this.db
					.collection("sessions")
					.updateOne({ uid: job.uid, sessionId: job.sessionId }, { $unset: { clearRequested: "" } })
					.catch(swallow("executor", "op"));
				cached.runner.clearContext();
			}
			cached.lastUsedAt = now;
			cached.live.stopped = false; // new run — clear a previous stop
			cached.route.job = job;
			cached.route.sink = this.sink;
			cached.route.track = (e) => this.trackUsage(e, job);
			return { runner: (this.runner = cached.runner), live: (this.live = cached.live) };
		}
		if ((session as { clearRequested?: boolean }).clearRequested) {
			void this.db
				.collection("sessions")
				.updateOne({ uid: job.uid, sessionId: job.sessionId }, { $unset: { clearRequested: "" } })
				.catch(swallow("executor", "op"));
		}
		const transcripts: PriorTranscript[] = await loadTranscripts(this.db, job.uid, job.sessionId).catch(swallow("executor", "op", []));
		// Reloaded lazily (60s) — runs finished during this warm session must be
		// visible to recall_context's runIndex, not just cold-start transcripts.
		const transcriptBox = { list: transcripts, at: now };
		const planSlugs = (await listPlans(this.db, job.uid, job.sessionId).catch(swallow("executor", "op", [] as { slug: string }[]))).map(
			(p) => p.slug,
		);
		// Context manifest (ADR §9): record what rehydration actually loaded.
		const embed: EmbedProvider | undefined = this.embedProvider;
		// Trivial tasks ("hi", "thanks") have no query substance — vector recall
		// returns noise that reads as a to-do list; skip injection entirely.
		const trivialTask = isTrivialTask(job.task);
		if (trivialTask) this.memoryReport({ op: "memory_recall", path: "trivial-skip", query: job.task.slice(0, 140) });
		const memories = trivialTask
			? []
			: await searchMemories(this.db, job.uid, job.sessionId, job.task, embed, session.repo ?? undefined, this.memoryReport, job.runId, session.base ?? undefined).catch(
					swallow("executor", "op", []),
				);
		// sessionMemoryContext injects the newest 10 — record exactly those, not
		// the whole recall set, or outcome credit lands on memories never seen.
		const injectedMemories = memories.slice(-10);
		const manifest: ContextManifest = {
			contextId: randomUUID(),
			transcriptsIncluded: transcripts.map((t) => t.label),
			digestCount: (session as { digests?: unknown[] }).digests?.length ?? 0,
			memoryIdsUsed: injectedMemories.map((m) => m.memoryId),
			memoryChars: injectedMemories.reduce((s, m) => s + m.content.length, 0),
			planSlugs,
			builtAt: new Date(),
		};
		await this.sink.patchRun({ contextManifest: manifest }).catch(swallow("executor", "op"));
		const route: RunnerRoute = { job, sink: this.sink, track: (e) => this.trackUsage(e, job) };
		let permLayers: PermissionLayers | undefined;
		const runner = new AgentRunner({
			events: {
				// Durable record → run_events (same collection, distinct types).
				record: (e) => void this.sink.emit(e as Record<string, unknown>),
			},
			resume: {
				// Worker restart / job re-claim mid-run: rebuild the transcript from
				// this run's durable agent-message records instead of starting blank.
				resumeLog: async () => {
					const docs = await this.db
						.collection("run_events")
						.find({ uid: job.uid, runId: job.runId, type: "agent-message" })
						.sort({ seq: 1 })
						.toArray()
						.catch(swallow("executor", "op", []));
					const msgs = deriveMessages(docs as unknown as KronyxEvent[]);
					return msgs.length ? msgs : undefined;
				},
			},
			workspaceRoot: kind === "ask" ? "(none)" : REPO_DIR,
			relativePath: (abs) => abs.replace(`${REPO_DIR}/`, ""),
			isDirty: () => false,
			approvals: {
				confirm: async (toolName, input) => {
					if (kind === "ask") return false;
					if (session.securityProfile !== "controlled") return true;
					return this.awaitPermission(job, toolName, input);
				},
				check: async (toolName, input) => {
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
			},
			currentMode: () => mode,
			planDir: kind === "ask" ? undefined : PLAN_DIR,
			memory: {
				context: async (task) => {
				const sessCache = await getCache().catch(() => undefined);
				const sessKey = `sessiondoc:${job.sessionId}`;
				const fresh = ((await sessCache?.get(sessKey).catch(() => undefined)) ??
					(await this.db.collection("sessions").findOne({ uid: job.uid, sessionId: job.sessionId }))) as SessionDoc | null;
				if (fresh) void sessCache?.set(sessKey, fresh, 5_000).catch(() => {});
				// Cold-start already searched for this exact task — reuse it.
				let mem = memories;
				if (task !== job.task) {
					mem = isTrivialTask(task)
						? []
						: await searchMemories(this.db, job.uid, job.sessionId, task, embed, session.repo ?? undefined, this.memoryReport, job.runId, session.base ?? undefined).catch(
								swallow("executor", "op", memories),
							);
					// A different recall set is being injected — merge it into the
					// manifest so recordMemoryOutcome credits the right memories.
					const newIds = mem.slice(-10).map((m) => m.memoryId);
					if (newIds.length)
						void this.db
							.collection("runs")
							.updateOne(
								{ uid: job.uid, runId: job.runId },
								{ $addToSet: { "contextManifest.memoryIdsUsed": { $each: newIds } } },
							)
							.catch(swallow("executor", "op"));
				}
				return sessionMemoryContext({ ...session, ...fresh } as SessionDoc, planSlugs, mem);
				},
			},
			recall: {
				scorer: embed ? createRecallScorer(embed, this.memoryReport) : undefined,
				transcripts: () => {
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
			},
			transcripts: {
				save: (messages: readonly AgentMessage[]) => {
					const j = route.job ?? job;
					transcriptBox.at = 0; // next recall reloads — this run just landed in the store
					this.pendingSaves.push(saveTranscript(this.db, j.uid, j.sessionId, j.runId, messages).catch(swallow("executor", "op")));
				},
			},
			environment:
				kind === "ask"
					? "a cloud chat session with no repository attached — answer from the user's message, attached files and session context"
					: "an E2B cloud sandbox",
			files: {
				// Repo skills ship with the clone — read them through this.live so a
				// recreated VM (mid-run death, switch_environment) keeps working.
				listSkillFiles: async () => {
					const h = kind === "ask" ? undefined : this.live?.handle;
					if (!h) return [];
					const ls = await h
						.run("ls .kronyx/skills/*/SKILL.md 2>/dev/null", { cwd: REPO_DIR, timeoutMs: 15_000 })
						.catch(swallow("executor", "op", null));
					if (!ls || ls.exitCode !== 0) return [];
					const out: { path: string; content: string }[] = [];
					for (const rel of ls.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
						const content = await h.readFile(`${REPO_DIR}/${rel}`).catch(swallow("executor", "op", null));
						if (content) out.push({ path: rel, content });
					}
					return out;
				},
			},
			log: (tag, msg) => console.log(`[${tag}] ${msg}`),
			tools: makeTools as () => Promise<never>,
			emit: (e) => {
				if (e.type !== "assistant-delta" && e.type !== "reasoning-delta") dbg("run", e.type, e);
				if (e.type === "run-finished" || e.type === "run-failed") {
					// Mirror of the extension's recordDigest — without this the
					// worker never populates runDigests, so sessions.digests stays
					// empty and every cold-start agent gets zero session history.
					runner.addRunDigest({
						task: route.job?.task ?? job.task,
						status: e.type === "run-finished" ? String(e.status ?? "completed") : "failed",
						summary: String(e.type === "run-finished" ? e.text : e.error ?? ""),
						filesChanged: [...this.liveChangedPaths]
							.filter((p) => p.startsWith("0:"))
							.map((p) => p.slice(2)),
						at: Date.now(),
					});
				}
				route.track?.(e);
				void route.sink?.emit(e);
			},
		});
		const sessionDoc = session as SessionDoc & { digests?: import("../../../src/agent/runner").RunDigest[]; stateNote?: string };
		if (sessionDoc.digests?.length) runner.setRunDigests(sessionDoc.digests);
		runner.setStateNote(sessionDoc.stateNote);
		sessionDoc.stateNote = undefined;
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
		// The main agent's closing report — the run-completed card reuses it.
		if (e.type === "run-finished" && agentIndex === 0) this.lastRunSummary = String(e.text ?? "");
		const meta = (e as { meta?: Record<string, unknown> & { kind?: string } }).meta;
		if (e.type === "info" && meta?.kind === "context_compaction") {
			this.lastCompaction = meta as { estTokensBefore?: number; estTokensAfter?: number };
			// The projected before/after context is too bulky for a run_events
			// doc — gzip it to disk (planStore convention) and keep a pointer.
			const { contextDump, ...rest } = meta;
			const dumpRef = contextDump ? newDumpRef(job.runId) : undefined;
			if (contextDump && dumpRef) void saveDump(job.uid, dumpRef, contextDump).catch(swallow("executor", "op"));
			// Flat first-class event — the /api/compactions feed queries these.
			void this.sink.emit({ type: "compaction", ...rest, ...(dumpRef ? { dumpRef } : {}) }, agentIndex ? { agentIndex } : undefined);
		}
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
			const stamped = e as { requestTokens?: number; contextWindow?: number; contextPct?: number; contextBudget?: number };
			stamped.requestTokens = delta.tokensIn;
			const effWin = stamped.contextBudget ?? win;
			if (effWin) {
				stamped.contextWindow = effWin;
				stamped.contextPct = Math.min(100, Math.round((delta.tokensIn / effWin) * 100));
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

	/** Memory/vector diagnostics → flat `memory` run_events (the /api/memory feed). */
	private memoryReport = (d: Record<string, unknown>): void => {
		void this.sink.emit({ type: "memory", ...d });
	};

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
			const digests = this.runner.runDigests.map((d) => ({ ...d, runId: job.runId, endSha: d.endSha ?? this.lastHeadSha }));
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
				...this.finishedSliceRunners.flatMap((s) => s.runner.runDigests.map((d) => ({ ...d, runId: job.runId, agentIndex: s.agentIndex, endSha: d.endSha ?? this.lastHeadSha })) as ProvenDigest[]),
			];
			// Scale the cap with agent count — MAX_DIGESTS would truncate all but
			// the last few slices' digests, losing most of what just happened.
			const cap = prior.length + this.finishedSliceRunners.length + 3;
			await recordDigests(this.db, job.uid, job.sessionId, all, cap).catch(swallow("executor", "op"));
		}
		// Tool telemetry rollup — feeds /api/tools/stats and per-run UI.
		const toolEvents = await this.db
			.collection("run_events")
			.find({ uid: job.uid, runId: job.runId, "event.type": "tool-finished" })
			.project({ "event.name": 1, "event.ok": 1, "event.durationMs": 1 })
			.toArray()
			.catch(swallow("executor", "op", [] as { event?: { name?: string; ok?: boolean; durationMs?: number } }[]));
		if (toolEvents.length) {
			const byTool: Record<string, { calls: number; fails: number; totalMs: number }> = {};
			let failures = 0;
			for (const e of toolEvents) {
				const ev = e.event ?? {};
				const s = (byTool[String(ev.name ?? "unknown")] ??= { calls: 0, fails: 0, totalMs: 0 });
				s.calls++;
				if (ev.ok === false) {
					s.fails++;
					failures++;
				}
				s.totalMs += Number(ev.durationMs) || 0;
			}
			await this.sink.patchRun({ toolStats: { calls: toolEvents.length, failures, byTool } }).catch(swallow("executor", "op"));
		}
	}

	/** Outcome feedback: memories injected at cold start get credited with the
	 *  run's result — the signal that separates "retrieved" from "useful". */
	private async recordMemoryOutcome(job: CloudJob, status: "completed" | "failed", runId = job.runId): Promise<void> {
		const run = await this.db
			.collection("runs")
			.findOne({ uid: job.uid, runId }, { projection: { contextManifest: 1 } })
			.catch(swallow("executor", "op", null));
		const ids = ((run?.contextManifest as { memoryIdsUsed?: string[] } | undefined)?.memoryIdsUsed ?? []).filter(Boolean);
		if (!ids.length) return;
		await this.db
			.collection("memories")
			.updateMany(
				{ uid: job.uid, memoryId: { $in: ids } },
				{ $inc: { [status === "completed" ? "helpedRuns" : "failedRuns"]: 1 }, $set: { lastOutcome: status, lastOutcomeRunId: runId } },
			)
			.catch(swallow("executor", "op"));
	}

	async run(job: CloudJob): Promise<void> {
		const settings = await loadUserSettings(this.db, job.uid);
		const session = await this.db
			.collection<SessionDoc>("sessions")
			.findOne({ uid: job.uid, sessionId: job.sessionId });
		if (!session) throw new Error("Session not found.");
		this.lastRunSummary = "";
		this.lastPrUrl = undefined;
		this.lastPushed = false;
		this.lastHeadSha = undefined;
		this.runChecks.length = 0;
		this.lastCompaction = undefined;
		try {
			if (job.kind === "push-plan") await this.pushPlan(job, session, settings);
			else if (job.kind === "open-pr") await this.openPrJob(job, session, settings);
			else if (job.mode === "ask") await this.ask(job, session, settings);
			else if (job.mode === "multi") await this.multi(job, session, settings);
			else await this.sandboxed(job, session, settings);
			if (!this.stopRequested) await this.recordMemoryOutcome(job, "completed");
			// True job end — the UI's single "completed" signal. run-finished is
			// only the agent's summary; this fires after push/PR/verify all land.
			await this.sink.emit({
				type: "run-completed",
				summary: this.lastRunSummary,
				prUrl: this.lastPrUrl ?? session.prUrl,
				pushed: this.lastPushed,
				checks: this.runChecks,
				compaction: this.lastCompaction,
			});
		} catch (e) {
			if (!this.stopRequested) await this.recordMemoryOutcome(job, "failed").catch(swallow("executor", "op"));
			throw e;
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

	private taskWithInline(task: string, atts: { filename: string; mime?: string; text?: string }[], location?: string): string {
		// Every attachment is named so the model knows it exists — binary files
		// (images) also reach it as image parts via RunnerAttachment.
		const manifest = atts.length
			? `\n\nUser attachments${location ? ` (saved under ${location})` : ""}: ${atts.map((a) => `${a.filename} (${a.mime ?? "file"})`).join(", ")}`
			: "";
		const inline = atts.filter((a) => a.text && a.text.length <= INLINE_TEXT_LIMIT);
		if (!inline.length) return task + manifest;
		const blocks = inline.map((a) => `--- attached file: ${a.filename} ---\n${a.text}\n--- end ${a.filename} ---`);
		return `${task}${manifest}\n\nAttached context:\n${blocks.join("\n\n")}`;
	}

	private runnerAttachments(atts: { filename: string; mime: string; data?: Buffer }[]): RunnerAttachment[] {
		return atts.map((a) => ({ filename: a.filename, mediaType: a.mime, data: a.data }));
	}

	/** Images go to the selected model only: a model that can't view them fails the run. */
	private assertCanViewImages(provider: ProviderSettings, atts: { mime: string; data?: Buffer }[]): void {
		const imgs = atts.filter((a) => a.mime.startsWith("image/") && a.data?.byteLength);
		if (imgs.length && !acceptsImages(this.modelMeta))
			throw new Error(`${provider.modelId} can't view images — pick a vision-capable model or remove the attached images.`);
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
			Promise.resolve([
				memoryWriteTool(this.db, job.uid, job.sessionId, job.runId, this.embedProvider, { repo: session.repo ?? undefined, branch: session.base }, this.memoryReport),
				...createFetchTools(),
			]),
		);
		this.throwIfStopped();
		await this.sink.emit({ type: "cloud-status", text: "Contacting model…" });
		this.assertCanViewImages(s, atts);
		await runner.run(this.taskWithInline(job.task, atts), s, this.runnerAttachments(atts));
		await this.afterRun(job);
	}

	/** Live template catalog per account, cached 10 min (public + account-built). */
	private static templateCache = new Map<string, { at: number; list: TemplateInfo[] }>();
	private templates: TemplateInfo[] = [];

	private async liveTemplates(provider: SandboxProvider, creds: ProviderCreds, force = false): Promise<TemplateInfo[]> {
		if (!provider.listTemplates) return [];
		const key = String(creds.secrets.e2bApiKey ?? "").slice(-12) || provider.name;
		const hit = E2bOrchestratedExecutor.templateCache.get(key);
		if (!force && hit && Date.now() - hit.at < 10 * 60_000) return hit.list;
		// Shared cache — template catalogs rarely change; other workers hit this.
		const cache = await getCache().catch(swallow("executor", "op", undefined));
		const shared = force ? undefined : ((await cache?.get(`templates:${key}`).catch(() => undefined)) as TemplateInfo[] | undefined);
		if (shared?.length) {
			E2bOrchestratedExecutor.templateCache.set(key, { at: Date.now(), list: shared });
			return shared;
		}
		const list: TemplateInfo[] = (await provider.listTemplates?.(creds).catch(swallow("executor", "op", []))) ?? [];
		// User-baked named snapshots are first-class selectable images.
		const baked = await this.db
			.collection("image_bakes")
			.find({ uid: this.sink.uid, status: "ready" })
			.toArray()
			.catch(swallow("executor", "op", []));
		for (const b of baked) {
			if (b.snapshotId && !list.some((t) => t.id === b.snapshotId || t.names.includes(b.name)))
				list.push({ id: b.snapshotId, names: [String(b.name)], public: false });
		}
		dbg("executor", "liveTemplates", { provider: provider.name, count: list.length });
		if (list.length) {
			E2bOrchestratedExecutor.templateCache.set(key, { at: Date.now(), list });
			void cache?.set(`templates:${key}`, list, 10 * 60_000).catch(() => {});
		}
		return list;
	}

	/**
	 * Warm per-repo boot (on by default; feature_flags.enabled=false disables):
	 * repo cloned + deps installed. `Sandbox.create({template: snapshotId})`
	 * boots straight onto the baked disk — cold start skips clone/install.
	 * Returns a ready snapshotId (<24h old) or kicks a background bake and
	 * returns null so the current run proceeds normally.
	 */
	private async warmSnapshotFor(session: SessionDoc, settings: UserSettings, creds: ProviderCreds): Promise<string | null> {
		if (!session.repo) return null;
		// On by default — warm snapshots are the core speedup, not an
		// experiment. Admins can still disable via feature_flags.enabled=false.
		if (await flagOff(this.db, FLAGS.warmTemplates)) return null;
		const key = createHash("sha256").update(`${this.sink.uid}:${session.repo}`).digest("hex").slice(0, 16);
		const col = this.db.collection("repo_templates");
		const doc = await col.findOne({ key }).catch(swallow("executor", "op", null));
		// Fingerprint the repo's live manifests only when the stored doc is a
		// warm candidate — the GitHub calls aren't worth it otherwise. A defined
		// hash that differs from doc.depsHash forces a rebake.
		const liveHash =
			doc?.status === "ready" && typeof doc.snapshotId === "string" && doc.depsOk !== false
				? await this.repoDepsFingerprint(session, settings).catch(swallow("executor", "op", undefined))
				: undefined;
		const decision = decideWarm(doc as WarmDoc | null, Date.now(), liveHash);
		if (decision.action === "use") return decision.snapshotId;
		if (decision.action === "wait" || decision.action === "skip") {
			if (decision.action === "skip") dbg("executor", `warm bake skipped for ${session.repo}: ${decision.reason}`);
			return null;
		}
		await this.sink
			.emit({ type: "info", key: "sandbox", text: `No ready warm snapshot for ${session.repo} — baking one in the background; this run boots a template` })
			.catch(swallow("executor", "op"));
		await col
			.updateOne(
				{ key },
				{ $set: { status: "building", uid: this.sink.uid, repo: session.repo, startedAt: new Date(), updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
				{ upsert: true },
			)
			.catch(swallow("executor", "op"));
		void this.bakeWarmSnapshot(key, session, settings, creds, doc?.snapshotId as string | undefined, (doc as { template?: string } | null)?.template).catch(async (e) => {
			console.log(`[executor] warm snapshot bake failed for ${session.repo}:`, e);
			await col
				.updateOne({ key }, { $set: { status: "failed", error: String(e).slice(0, 300), updatedAt: new Date(), failedAt: new Date() } })
				.catch(swallow("executor", "op"));
		});
		return null;
	}

	/** The repo's live manifest fingerprint via the GitHub contents API —
	 *  undefined when it can't be fetched (no token, private repo, network). */
	private async repoDepsFingerprint(session: SessionDoc, settings: UserSettings): Promise<string | undefined> {
		const token = await this.githubToken(session, settings).catch(swallow("executor", "op", ""));
		const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
		if (token) headers.Authorization = `Bearer ${token}`;
		const files: Record<string, string> = {};
		await Promise.all(
			DEP_FILES.map(async (f) => {
				const r = await fetch(`https://api.github.com/repos/${session.repo}/contents/${f}`, {
					headers,
					signal: AbortSignal.timeout(10_000),
				}).catch(() => null);
				if (!r?.ok) return;
				const d = (await r.json().catch(() => null)) as { content?: string; encoding?: string } | null;
				if (d?.encoding === "base64" && d.content) files[f] = Buffer.from(d.content, "base64").toString("utf8");
			}),
		);
		return Object.keys(files).length ? depsFingerprint(files) : undefined;
	}

	/** Bake a repo snapshot: stock VM → clone → best-effort dep install →
	 *  persistent filesystem snapshot → kill. Runs outside the job's lifecycle
	 *  (fire-and-forget) — no secrets are baked, the clone is unauthenticated. */
	private async bakeWarmSnapshot(key: string, session: SessionDoc, settings: UserSettings, creds: ProviderCreds, prevSnapshotId?: string, repoTemplate?: string): Promise<void> {
		const col = this.db.collection("repo_templates");
		const bake = new SandboxCore();
		// Bake from the repo's designated template (else user's cloud.template)
		// so the warm VM layers repo state onto the project's toolchain image.
		const base = repoTemplate || String(settings.data.e2bTemplate ?? "") || undefined;
		await bake.create({ creds, provider: "e2b", template: base, timeoutMs: 30 * 60_000 });
		// Register the bake VM so it's janitor-visible if the worker dies
		// mid-bake (otherwise it's an untracked orphan).
		const bakeId = bake.sandboxId;
		if (bakeId)
			await this.db
				.collection("sandboxes")
				.insertOne({ uid: this.sink.uid, sandboxId: bakeId, provider: "e2b", state: "running", reason: `warm-bake:${key}`, at: new Date() })
				.catch(swallow("executor", "op"));
		try {
			const token = await this.githubToken(session, settings).catch(swallow("executor", "op", ""));
			await bake.cloneRepo(`https://github.com/${session.repo}`, token, REPO_DIR);
			// Scrub the token-bearing remote URL before snapshotting — secrets
			// must never be baked into the image.
			await bake.runIn(REPO_DIR, `git remote set-url origin ${JSON.stringify(`https://github.com/${session.repo}`)}`, 15_000).catch(swallow("executor", "op"));
			// Fingerprint the manifests so the record shows which deps were baked.
			const manifests: Record<string, string> = {};
			for (const f of DEP_FILES) {
				const r = await bake.runIn(REPO_DIR, `cat ${f}`, 15_000).catch(() => null);
				if (r?.exitCode === 0) manifests[f] = r.stdout;
			}
			const depsHash = depsFingerprint(manifests);
			// Whatever installs within 10min is baked; the rest installs at runtime.
			// Exit codes are checked: a failed install must not be served as warm.
			const install = await bake
				.runIn(REPO_DIR, "if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; elif [ -f yarn.lock ]; then yarn install --frozen-lockfile; else exit 0; fi", 600_000)
				.catch(() => ({ exitCode: 1, stdout: "", stderr: "install did not run" }));
			const depsOk = install.exitCode === 0;
			if (!depsOk) console.log(`[executor] warm bake install failed for ${session.repo}: ${stderrTail(install.stderr || install.stdout)}`);
			// Named filesystem-only snapshot: same name → new build on the
			// existing snapshot template; fs mode since boots are cold anyway.
			const snapshotId = await bake.checkpoint({ mode: "filesystem", name: `kronyx-repo-${key}` });
			if (!snapshotId) throw new Error("checkpoint returned no snapshot id");
			await col.updateOne({ key }, { $set: { status: "ready", snapshotId, depsOk, depsHash, baseTemplate: base, updatedAt: new Date(), failedAt: null } }).catch(swallow("executor", "op"));
			console.log(`[executor] warm snapshot ready for ${session.repo}: ${snapshotId}`);
			// Delete the superseded snapshot so rebakes don't accumulate.
			if (prevSnapshotId && prevSnapshotId !== snapshotId) await bake.deleteSnapshot(prevSnapshotId).catch(swallow("executor", "op", false));
		} catch (e) {
			// Record the failure so the cooldown in decideWarm applies. Without this,
			// a failed bake stays `building` and is retried on every run.
			await col
				.updateOne({ key }, { $set: { status: "failed", failedAt: new Date(), updatedAt: new Date(), error: e instanceof Error ? e.message : String(e) } })
				.catch(swallow("executor", "op"));
			throw e;
		} finally {
			await bake.close().catch(swallow("executor", "op"));
			if (bakeId)
				await this.db.collection("sandboxes").updateOne({ uid: this.sink.uid, sandboxId: bakeId }, { $set: { state: "dead", deadAt: new Date() } }).catch(swallow("executor", "op"));
		}
	}

	/**
	 * kind:"bake" job — boot a stock VM, run an image recipe, snapshot it under
	 * a stable name so `Sandbox.create` can boot it directly (e.g. kronyx-browser
	 * for browser_use without the e2b CLI). Status lives in `image_bakes`.
	 */
	async bakeImage(job: CloudJob): Promise<void> {
		const recipe = job.customRecipe ?? IMAGE_RECIPES[job.recipe ?? "browser"];
		if (!recipe) throw new Error(`unknown image recipe: ${job.recipe}`);
		const repoKey = job.repo ? createHash("sha256").update(`${job.uid}:${job.repo}`).digest("hex").slice(0, 16) : null;
		const imageName = repoKey ? `kronyx-repo-${repoKey}` : recipe.imageName;
		const col = this.db.collection(repoKey ? "repo_templates" : "image_bakes");
		const key = repoKey ? { key: repoKey } : { uid: job.uid, name: imageName, kind: "bake" };
		const settings = await loadUserSettings(this.db, job.uid);
		const provider = getProvider("e2b");
		const creds: ProviderCreds = { secrets: settings.secrets, data: settings.data };
		const credErr = provider.validate(creds);
		if (credErr) throw new Error(credErr);

		// Repo-scoped bakes boot from the repo's designated template so the
		// warm snapshot layers repo state onto its toolchain image.
		const prevDoc = repoKey ? ((await col.findOne(key).catch(swallow("executor", "op", null))) as { template?: string; snapshotId?: string } | null) : null;
		const bake = new SandboxCore();
		await bake.create({ creds, provider: "e2b", template: prevDoc?.template || undefined, timeoutMs: 45 * 60_000 });
		const bakeId = bake.sandboxId;
		if (bakeId)
			await this.db
				.collection("sandboxes")
				.insertOne({ uid: job.uid, sandboxId: bakeId, provider: "e2b", state: "running", reason: `image-bake:${imageName}`, at: new Date() })
				.catch(swallow("executor", "op"));
		try {
			if (job.repo) {
				const token = typeof job.installationId === "number" ? await installationToken(job.installationId).catch(swallow("executor", "op", "")) : "";
				await bake.cloneRepo(`https://github.com/${job.repo}`, token, REPO_DIR);
				// Scrub the token-bearing remote URL before snapshotting.
				await bake.runIn(REPO_DIR, `git remote set-url origin ${JSON.stringify(`https://github.com/${job.repo}`)}`, 15_000).catch(swallow("executor", "op"));
			}
			const r = await bake.runIn(job.repo ? REPO_DIR : "/", recipe.commands, recipe.timeoutMs ?? 20 * 60_000);
			if (r.exitCode !== 0) throw new Error(`recipe failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).slice(-600)}`);
			if (recipe.verify) {
				const v = await bake.runIn(job.repo ? REPO_DIR : "/", recipe.verify, 60_000);
				if (v.exitCode !== 0) throw new Error(`verify failed: ${(v.stderr || v.stdout).slice(-400)}`);
			}
			let depsHash: string | undefined;
			if (job.repo) {
				const manifests: Record<string, string> = {};
				for (const f of DEP_FILES) {
					const m = await bake.runIn(REPO_DIR, `cat ${f}`, 15_000).catch(() => null);
					if (m?.exitCode === 0) manifests[f] = m.stdout;
				}
				depsHash = depsFingerprint(manifests);
			}
			// Named fs-only snapshot — re-bakes with the same name supersede the
			// old one, and the name resolves as a Sandbox.create template.
			const snapshotId = await bake.checkpoint({ mode: "filesystem", name: imageName });
			if (!snapshotId) throw new Error("checkpoint returned no snapshot id");
			const prev = prevDoc ?? (await col.findOne(key).catch(swallow("executor", "op", null)));
			await col.updateOne(
				key,
				repoKey
					? {
							$set: { status: "ready", snapshotId, depsOk: true, depsHash, uid: job.uid, repo: job.repo, baseTemplate: prevDoc?.template, updatedAt: new Date(), failedAt: null },
							$setOnInsert: { createdAt: new Date() },
						}
					: {
							$set: { snapshotId, recipe: job.recipe ?? "custom", status: "ready", bakedAt: new Date(), error: null, kind: "bake" },
							$setOnInsert: { createdAt: new Date() },
						},
				{ upsert: true },
			);
			console.log(`[executor] image bake ready: ${imageName} → ${snapshotId}`);
			if (prev?.snapshotId && prev.snapshotId !== snapshotId) await bake.deleteSnapshot(prev.snapshotId).catch(swallow("executor", "op", false));
		} catch (e) {
			await col
				.updateOne(
					key,
					repoKey
						? { $set: { status: "failed", error: e instanceof Error ? e.message : String(e), failedAt: new Date(), updatedAt: new Date() } }
						: { $set: { status: "error", error: e instanceof Error ? e.message : String(e), finishedAt: new Date() } },
				)
				.catch(swallow("executor", "op"));
			throw e;
		} finally {
			await bake.close().catch(swallow("executor", "op"));
			if (bakeId)
				await this.db
					.collection("sandboxes")
					.updateOne({ uid: job.uid, sandboxId: bakeId }, { $set: { state: "dead", deadAt: new Date() } })
					.catch(swallow("executor", "op"));
		}
	}

	/**
	 * kind:"template-build" job — real E2B template build via the REST API
	 * (flag templateBuildApi). Durable named template vs a snapshot: shows up
	 * in listTemplates and doesn't age out. Status lives in `image_bakes`.
	 */
	async buildTemplateApi(job: CloudJob): Promise<void> {
		const name = String(job.recipe ?? "kronyx-browser").slice(0, 60);
		const col = this.db.collection("image_bakes");
		// api-build docs key on name+kind so they never clobber a snapshot bake
		// of the same alias.
		const key = { uid: job.uid, name, kind: "api-build" };
		const settings = await loadUserSettings(this.db, job.uid);
		const apiKey = String(settings.secrets.e2bApiKey ?? process.env.E2B_API_KEY ?? "");
		if (!apiKey) throw new Error("E2B_API_KEY is not configured");
		// dist/index.js → backend/dist/../e2b-template — one level up from the bundle.
		// FROM e2bdev/base is correct for v3: fromDockerfile() serializes it as
		// fromImage "e2bdev/base", same as the SDK's own Template().base().
		const dockerfile = job.dockerfile ?? (await readFile(new URL("../e2b-template/Dockerfile", import.meta.url), "utf8"));
		await col.updateOne(key, { $set: { status: "building", kind: "api-build", startedAt: new Date() } }, { upsert: true });
		try {
			const { templateId } = await buildE2bTemplate(apiKey, { name, dockerfile });
			await col.updateOne(key, { $set: { status: "ready", templateId, recipe: name, bakedAt: new Date(), error: null } });
			console.log(`[executor] E2B template build ready: ${name} → ${templateId}`);
			// Named snapshots and API builds live on the SAME template entity in
			// E2B — deleting the bake's snapshotId would delete the template we
			// just built (verified live). So no delete: just mark the bake doc
			// superseded so pickTemplate/UI know the durable build is canonical.
			await col
				.updateOne({ uid: job.uid, name, kind: "bake" }, { $set: { status: "superseded", supersededBy: templateId } })
				.catch(swallow("executor", "op"));
		} catch (e) {
			await col
				.updateOne(key, { $set: { status: "error", error: e instanceof Error ? e.message : String(e), finishedAt: new Date() } })
				.catch(swallow("executor", "op"));
			throw e;
		}
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
		sbx.onLifecycle = (event, sandboxId, extra) => {
			const state =
				event === "pause"
					? "paused"
					: event === "start" || event === "resume" || event === "resume-disk" || event === "connect" || event === "fork"
						? "running"
						: undefined;
			void recordSandboxEvent(this.db, {
				uid: this.sink.uid,
				sandboxId,
				sessionId: session.sessionId,
				provider: providerName,
				event,
				state,
				...(extra?.snapshotId ? { snapshotId: String(extra.snapshotId) } : {}),
			});
			// Terminal states are sticky: a late event (e.g. the provider pause
			// that lands after we marked the VM replaced) must not resurrect it.
			void this.db
				.collection("sandboxes")
				.updateOne(
					{ uid: this.sink.uid, sandboxId },
					[
						{
							$set: {
								uid: this.sink.uid, sessionId: session.sessionId, sandboxId, provider: providerName, event, at: new Date(),
								...(state ? { state: { $cond: [{ $in: ["$state", ["dead", "replaced"]] }, "$state", state] } } : {}),
								createdAt: { $ifNull: ["$createdAt", "$$NOW"] },
							},
						},
					],
					{ upsert: true },
				)
				.catch(swallow("executor", "op"));
		};
		sbx.setIdlePause(Number(process.env.SANDBOX_IDLE_PAUSE_MINUTES) || 15);
		// Boot ladder — the first step that yields a live VM wins:
		//   1. reuse the session's sandbox (connect/probe, then the resume
		//      ladder: memory → disk-only → blind disk resume)
		//   2. restore the session WIP disk snapshot (full worktree)
		//   3. create from the ordered template chain (base = last resort)
		// Providers without reconnect (e.g. vercel — ephemeral) skip to 3.
		const oldId = session.sandboxId;
		if (oldId && provider.capabilities.reconnect && (await this.reuseSandbox(sbx, session, oldId, provider, providerName, creds))) {
			return sbx;
		}
		if (provider.capabilities.snapshot && session.lastSnapshotId && (await this.restoreSnapshot(sbx, session, providerName, creds, oldId))) {
			return sbx;
		}
		const { templates, warmId, strict } = await this.bootTemplates(session, settings, opts, provider, creds);
		await this.createSandbox(sbx, session, provider, providerName, creds, templates, warmId, strict, oldId);
		return sbx;
	}

	/** Record boot provenance — what the VM booted FROM — as a `boot` event in
	 *  sandbox_events and on the sandbox row, so the list/detail views can show
	 *  "warm snapshot" vs "durable template" vs "base" instead of inferring it
	 *  from opaque template names. */
	private async recordBoot(session: SessionDoc, sandboxId: string, source: string, template?: string, snapshotId?: string): Promise<void> {
		void recordSandboxEvent(this.db, {
			uid: this.sink.uid,
			sandboxId,
			sessionId: session.sessionId,
			event: "boot",
			source,
			...(template ? { template } : {}),
			...(snapshotId ? { snapshotId } : {}),
		});
		await this.db
			.collection("sandboxes")
			.updateOne(
				{ uid: this.sink.uid, sandboxId },
				{ $set: { uid: this.sink.uid, sandboxId, sessionId: session.sessionId, source, at: new Date() }, $setOnInsert: { createdAt: new Date() } },
				{ upsert: true },
			)
			.catch(swallow("executor", "op"));
	}

	/** Flag a dead VM for the janitor (the single owner of kills) and link it
	 *  to its successor. `detach` also clears sessionId — used when the old
	 *  VM was proven unreachable rather than cleanly replaced. */
	private async markReplaced(oldId: string, newId: string | undefined, reason: string, detach = false): Promise<void> {
		await this.db
			.collection("sandboxes")
			.updateOne(
				{ uid: this.sink.uid, sandboxId: oldId },
				{ $set: { state: "replaced", replacedBy: newId, killPending: true, reason, replacedAt: new Date(), ...(detach ? { sessionId: null } : {}) } },
			)
			.catch(swallow("executor", "op"));
	}

	/** Reuse the session's existing VM: connect + probe, then the resume
	 *  ladder before condemning it — a paused (or paused-with-dead-agent)
	 *  sandbox can still cold-boot from its disk snapshot, keeping the repo
	 *  AND worktree where a kill+reclone loses uncommitted work. */
	private async reuseSandbox(sbx: SandboxCore, session: SessionDoc, oldId: string, provider: SandboxProvider, providerName: string, creds: ProviderCreds): Promise<boolean> {
		// Retry connect before concluding it's dead — transient API/network
		// blips must not churn sandboxes.
		let connected = false;
		for (let attempt = 0; attempt < 4 && !connected; attempt++) {
			if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
			connected = !!(await sbx.connect(oldId, creds, providerName));
		}
		if (connected) {
			// connect() returning a handle proves nothing — a VM at
			// end-of-life can accept the handshake then die under load.
			// A VM chewing detached leftovers from a stopped run looks the
			// same, so the probe gets slack, one zombie sweep, and a retry
			// before we condemn it — a wrong verdict costs the worktree.
			const alive = async () =>
				sbx
					.runIn("/", "echo ok", 30_000)
					.then((r) => r.stdout.includes("ok"))
					.catch(() => false);
			if (!(await alive())) {
				await sbx
					.runIn("/", `for p in $(pgrep -f '/tmp/kronyx-cmd-' 2>/dev/null); do kill -KILL -"$p" 2>/dev/null; done; pkill -f 'kronyx_browser_use' 2>/dev/null; true`, 20_000)
					.catch(swallow("executor", "op"));
				await new Promise((r) => setTimeout(r, 5000));
			}
			if (await alive()) {
				await sbx.keepalive(60);
				dbg("sandbox", "reused", { sandboxId: oldId });
				await this.sink.emit({ type: "info", key: "sandbox", text: `Reused warm sandbox ${oldId}` });
				await this.recordBoot(session, oldId, "connect");
				return true;
			}
			dbg("sandbox", "connected but unresponsive", { sandboxId: oldId });
		}
		dbg("sandbox", "unreachable after retries", { sandboxId: oldId });
		if (!provider.capabilities.resume) return false;
		let info = await provider.getInfoById?.(oldId, creds).catch(() => null);
		// A VM mid-pause still reports "running" while connect already
		// fails — wait out the transition and re-probe once so a pausing
		// sandbox gets the resume ladder instead of a pointless recreate.
		if (info?.state === "running") {
			await new Promise((r) => setTimeout(r, 5000));
			info = (await provider.getInfoById?.(oldId, creds).catch(() => null)) ?? info;
		}
		if (info?.state === "paused") {
			// envdUnresponsiveAtPause → memory restore would 409; go
			// straight to the disk-only cold boot.
			const modes: { memory?: boolean }[] = info.envdUnresponsiveAtPause ? [{ memory: false }] : [{}, { memory: false }];
			for (const mode of modes) {
				const h = await sbx.resume(oldId, creds, mode).catch(() => null);
				if (!h) continue;
				const ok = await sbx.runIn("/", "echo ok", 30_000).then((r) => r.stdout.includes("ok")).catch(() => false);
				if (!ok) continue;
				await sbx.keepalive(60);
				dbg("sandbox", mode.memory === false ? "resumed disk-only" : "resumed", { sandboxId: oldId });
				await this.sink.emit({
					type: "info",
					key: "sandbox",
					text: mode.memory === false ? `Resumed sandbox ${oldId} from disk (cold boot — worktree preserved)` : `Resumed paused sandbox ${oldId}`,
				});
				await this.recordBoot(session, oldId, mode.memory === false ? "resume-disk" : "resume");
				return true;
			}
		} else if (info?.state === "running" && provider.pauseById) {
			// envd wedged but the VM is alive at the infra level: pausing
			// writes a disk snapshot, and a memory:false resume cold-boots
			// it — the worktree survives where a recreate would lose
			// uncommitted work.
			if (await provider.pauseById(oldId, creds).catch(() => false)) {
				const h = await sbx.resume(oldId, creds, { memory: false }).catch(() => null);
				if (h) {
					const ok = await sbx.runIn("/", "echo ok", 30_000).then((r) => r.stdout.includes("ok")).catch(() => false);
					if (ok) {
						await sbx.keepalive(60);
						dbg("sandbox", "wedged VM paused + disk-resumed", { sandboxId: oldId });
						await this.sink.emit({ type: "info", key: "sandbox", text: `Sandbox ${oldId} was unresponsive — cold-booted from its disk snapshot (worktree preserved)` });
						await this.recordBoot(session, oldId, "resume-disk");
						return true;
					}
				}
			}
		} else if (!info) {
			// Probe failed transiently — the sandbox may still be
			// paused and resumable. A blind disk-only resume is cheap
			// insurance: it cold-boots from disk if a snapshot exists
			// and fails fast otherwise.
			const h = await sbx.resume(oldId, creds, { memory: false }).catch(() => null);
			if (h) {
				const ok = await sbx.runIn("/", "echo ok", 30_000).then((r) => r.stdout.includes("ok")).catch(() => false);
				if (ok) {
					await sbx.keepalive(60);
					await this.sink.emit({ type: "info", key: "sandbox", text: `Resumed sandbox ${oldId} from disk (probe had failed)` });
					await this.recordBoot(session, oldId, "resume-blind");
					return true;
				}
			}
		}
		return false;
	}

	/** Best-effort preservation of a wedged-but-alive VM (envd dead, disk
	 *  intact): a filesystem checkpoint is an infra-level call that doesn't
	 *  need envd, and pausing makes the resume ladder's disk-only cold boot
	 *  available. Returns true when something was preserved — the caller
	 *  should then KEEP session.sandboxId so ensureSandbox's boot ladder
	 *  (resume → snapshot restore → create) can recover the worktree. */
	private async rescueWedgedSandbox(session: SessionDoc, settings: UserSettings, sandboxId: string): Promise<boolean> {
		const providerName = session.provider ?? String(settings.data.sandboxProvider ?? "e2b");
		const provider = getProvider(providerName);
		const creds: ProviderCreds = { secrets: settings.secrets, data: settings.data };
		let preserved = false;
		if (provider.checkpointById) {
			const snap = await provider.checkpointById(sandboxId, creds, { mode: "filesystem", name: `kronyx-wip-${session.sessionId}` }).catch(swallow("executor", "op", null));
			if (snap) {
				session.lastSnapshotId = snap;
				await this.sink.patchSession({ lastSnapshotId: snap });
				preserved = true;
			}
		}
		if (provider.pauseById && (await provider.pauseById(sandboxId, creds).catch(swallow("executor", "op", false)))) {
			// Paused → reuseSandbox's disk-only resume can cold-boot the worktree.
			preserved = true;
		}
		return preserved;
	}

	/** Boot a NEW sandbox from the session's WIP disk checkpoint — full
	 *  worktree (incl. node_modules/untracked) intact, no reclone. Clears
	 *  lastSnapshotId and returns false on a stale/deleted snapshot. */
	private async restoreSnapshot(sbx: SandboxCore, session: SessionDoc, providerName: string, creds: ProviderCreds, oldId?: string): Promise<boolean> {
		const snapId = session.lastSnapshotId!;
		try {
			await sbx.create({ creds, provider: providerName, template: snapId, timeoutMs: 60 * 60_000 });
			const ok = await sbx.runIn(REPO_DIR, "git status >/dev/null 2>&1 && echo ok", 20_000).then((r) => r.stdout.includes("ok")).catch(() => false);
			if (!ok) {
				await sbx.close().catch(swallow("executor", "op"));
			} else {
				await sbx.keepalive(60);
				if (oldId) await this.markReplaced(oldId, sbx.sandboxId, "snapshot-restore");
				session.cloned = true;
				await this.sink.patchSession({ sandboxId: sbx.sandboxId, cloned: true });
				await this.db
					.collection("sessions")
					.updateOne({ uid: this.sink.uid, sessionId: session.sessionId }, { $addToSet: { sandboxIds: sbx.sandboxId } })
					.catch(swallow("executor", "op"));
				await this.sink.emit({ type: "info", key: "sandbox", text: `Restored session from disk snapshot ${snapId.slice(0, 12)}…` });
				await this.recordBoot(session, sbx.sandboxId ?? "", "wip", undefined, snapId);
				return true;
			}
		} catch {
			// Stale/deleted snapshot — clear it and fall through to a fresh
			// create (the warm-template/reclone paths still apply).
		}
		session.lastSnapshotId = undefined;
		await this.sink.patchSession({ lastSnapshotId: null });
		return false;
	}

	/** Ordered, deduped template candidates for a cold create:
	 *  explicit override > repo warm snapshot > repo's designated template >
	 *  session template > LLM pick > settings default. Named templates are
	 *  resolved against the live catalog (empty catalog → trust the name —
	 *  the fetch may have failed transiently); a name that doesn't resolve
	 *  warns and drops out. The warm snapshot id skips validation — it's an
	 *  id, not an alias. */
	private async bootTemplates(
		session: SessionDoc,
		settings: UserSettings,
		opts: { template?: string; llm?: ProviderSettings; task?: string },
		provider: SandboxProvider,
		creds: ProviderCreds,
	): Promise<{ templates: string[]; warmId: string | null; strict: boolean }> {
		let warmId: string | null = null;
		let repoTemplate: string | undefined;
		const repoKey = session.repo ? createHash("sha256").update(`${this.sink.uid}:${session.repo}`).digest("hex").slice(0, 16) : undefined;
		if (!opts.template && provider.name === "e2b" && provider.capabilities.snapshot) {
			// Warm per-repo snapshot (default-on): a baked VM image with
			// the repo cloned + deps installed — skips clone/install entirely.
			warmId = await this.warmSnapshotFor(session, settings, creds).catch(swallow("executor", "op", null));
		}
		// Looked up even when a warm snapshot exists: a warm boot that fails
		// (snapshot vanished provider-side) must retry this durable repo
		// image — not skip to session/base.
		if (!opts.template && repoKey) {
			repoTemplate = ((await this.db.collection("repo_templates").findOne({ key: repoKey }).catch(swallow("executor", "op", null))) as { template?: string } | null)?.template;
		}
		let llmPick: string | null = null;
		if (!opts.template && !warmId && !repoTemplate && !session.template && this.templates.length && opts.llm && opts.task) {
			const picked = await pickTemplate(opts.llm, opts.task, this.templates);
			if (picked) {
				llmPick = picked;
				await this.sink.patchSession({ template: picked });
				await this.sink.emit({ type: "info", text: `Picked sandbox template "${picked}" for this task` });
			}
		}
		const settingsDefault = String(settings.data.e2bTemplate ?? "") || undefined;
		// An explicit per-run template is authoritative (switch_environment /
		// Composer field): it is the ONLY candidate — no silent downgrade to
		// session/base, the create error propagates to the caller.
		const strict = !!opts.template;
		const candidates = strict ? [opts.template] : [opts.template, warmId, repoTemplate, session.template, llmPick, settingsDefault];
		const templates: string[] = [];
		const seen = new Set<string>();
		for (const cand of candidates) {
			if (!cand || seen.has(cand)) continue;
			if (cand === warmId) {
				seen.add(cand);
				templates.push(cand);
				continue;
			}
			let name = cand;
			if (this.templates.length) {
				const resolved = resolveTemplateName(cand, this.templates);
				if (!resolved) {
					if (strict) {
						// Catalog caches up to 10min — a just-built template may
						// legitimately be missing. Refresh once; genuinely absent
						// → throw loudly. Creating a bad name would surface as a
						// quota-looking error and kill an innocent paused VM.
						const fresh = await this.liveTemplates(provider, creds, true);
						if (fresh.length) this.templates = fresh;
						const retry = resolveTemplateName(cand, this.templates);
						if (!retry) throw new Error(`Template "${cand}" not found in the provider catalog`);
						name = retry;
						if (seen.has(name)) continue;
						seen.add(name);
						templates.push(name);
					} else {
						await this.sink.emit({ type: "info", key: "sandbox", text: `Template "${cand}" is unavailable — falling back` }).catch(swallow("executor", "op"));
					}
					continue;
				}
				name = resolved;
				if (seen.has(name)) continue;
			}
			seen.add(name);
			templates.push(name);
		}
		return { templates, warmId, strict };
	}

	/** Walk the template candidates until one boots; stock base (undefined)
	 *  is appended as the last resort. Only reached after reuse + snapshot
	 *  restore both failed, so any oldId here is proven dead → replaced.
	 *  Unresolvable names were filtered in bootTemplates, so reaching the
	 *  quota path means a genuine create failure — safe to free a paused VM. */
	private async createSandbox(
		sbx: SandboxCore,
		session: SessionDoc,
		provider: SandboxProvider,
		providerName: string,
		creds: ProviderCreds,
		templates: string[],
		warmId: string | null,
		strict: boolean,
		oldId?: string,
	): Promise<void> {
		const warn = (text: string) => void this.sink.emit({ type: "info", key: "sandbox", text }).catch(swallow("executor", "op"));
		// Provider errors are undifferentiated blobs — classify the create
		// failure so a missing/invalid template NEVER reaches the quota path
		// (killing an innocent paused VM for a name problem). Loose match:
		// e2b phrases it "template not found"/404 on snapshot ids.
		const isTemplateMiss = (e: unknown) => {
			const m = String(e instanceof Error ? e.message : e).toLowerCase();
			return /not.?found|does not exist|unknown|invalid|404/.test(m) && /template|snapshot|image|sandbox/.test(m);
		};
		let template: string | undefined;
		// Provider-side auto-pause: on timeout the VM snapshots instead of
		// dying — durable across worker restarts (our in-process idle timer
		// isn't). autoResume wakes the paused VM on inbound traffic.
		let autoPause = false;
		let created = false;
		let createErr: unknown;
		const list: (string | undefined)[] = strict ? templates : [...templates, undefined];
		for (let i = 0; i < list.length; i++) {
			const cand = list[i];
			template = cand;
			// Reaching the appended base after candidate failures is worth a
			// session note — the user asked for a named image, not stock.
			if (cand === undefined && i > 0) warn("Named templates unavailable — booting stock base image");
			autoPause = provider.capabilities.autoPause === true
				? await flag(this.db, { uid: this.sink.uid, repo: session.repo, template: cand, sessionId: session.sessionId }, FLAGS.sandboxAutoPause)
				: false;
			try {
				await sbx.create({ creds, provider: providerName, template: cand, timeoutMs: 60 * 60_000, autoPause, autoResume: autoPause });
				created = true;
				break;
			} catch (e) {
				createErr = e;
				if (strict && isTemplateMiss(e)) {
					throw new Error(`Template "${cand}" not found provider-side — check the name in Settings / Templates`);
				}
				if (i < list.length - 1) warn(`Sandbox create failed on "${cand}" — trying next fallback`);
				// A warm snapshot that's gone provider-side must not be served
				// by decideWarm forever — mark the repo doc stale so the next
				// run rebakes instead of retrying a dead id each time.
				if (cand === warmId && session.repo) {
					const key = createHash("sha256").update(`${this.sink.uid}:${session.repo}`).digest("hex").slice(0, 16);
					await this.db
						.collection("repo_templates")
						.updateOne({ key }, { $set: { status: "stale", snapshotId: null, failedAt: new Date(), error: "snapshot vanished provider-side", updatedAt: new Date() } })
						.catch(swallow("executor", "op"));
				}
			}
		}
		if (!created) {
			// A name-resolution failure must never masquerade as quota — killing
			// a paused VM wouldn't help and the retry would fail identically.
			if (isTemplateMiss(createErr)) throw createErr;
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
			await sbx.create({ creds, provider: providerName, template, timeoutMs: 60 * 60_000, autoPause, autoResume: autoPause }).catch(() => {
				throw createErr instanceof Error ? createErr : new Error(String(createErr));
			});
		}
		// Don't persist a warm snapshot id as the session template — snapshots
		// expire; the session template must stay a named template.
		if (template && template !== warmId) session.template = template;
		await sbx.keepalive(60);
		const newId = sbx.sandboxId;
		// Persist the provider-verified template identity — the requested name
		// is what we asked for; getInfo reports what actually booted.
		const createdInfo = newId ? await provider.getInfoById?.(newId, creds).catch(() => null) : null;
		// Old sandbox proven unreachable after retries — disassociate it from
		// the session; it shows up as an orphan in the janitor.
		if (oldId) await this.markReplaced(oldId, newId, "unreachable", true);
		await this.db
			.collection("sandboxes")
			.updateOne(
				{ uid: this.sink.uid, sandboxId: newId },
				{ $set: { uid: this.sink.uid, sessionId: session.sessionId, sandboxId: newId, provider: providerName, template: createdInfo?.name ?? template ?? null, templateId: createdInfo?.templateId ?? null, repo: session.repo ?? null, state: "active", at: new Date() }, $setOnInsert: { createdAt: new Date() } },
				{ upsert: true },
			)
			.catch(swallow("executor", "op"));
		// A new sandbox is empty — clone state must reset with it. A warm
		// snapshot boot is the exception: the repo is baked onto the disk, so
		// `cloned` stays true (ensureRepoReady probes .git before trusting it).
		const preCloned = warmId != null && template === warmId;
		await this.sink.patchSession({ sandboxId: newId, cloned: preCloned });
		await this.db
			.collection("sessions")
			.updateOne({ uid: this.sink.uid, sessionId: session.sessionId }, { $addToSet: { sandboxIds: newId } })
			.catch(swallow("executor", "op"));
		session.cloned = preCloned;
		const bootDesc = preCloned ? "warm snapshot (repo pre-cloned)" : template ? `template: ${template}` : "base image";
		await this.sink.emit({ type: "info", key: "sandbox", text: `Created sandbox ${newId} — ${bootDesc}` });
		if (newId) {
			const source = warmId != null && template === warmId ? "warm" : template ? "template" : "base";
			await this.recordBoot(session, newId, source, source === "template" ? template : undefined, source === "warm" ? warmId! : undefined);
		}
	}

	/** Shared "repo exists, valid, and on the session branch" — used by
	 *  sandboxed runs, open-pr/push-plan jobs, and post-death resurrection.
	 *  The `cloned` flag can desync from reality (new/empty sandbox after an
	 *  expired one), so the repo dir is probed before it's trusted. */
	private async ensureRepoReady(session: SessionDoc, sbx: SandboxCore, token: string): Promise<void> {
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
			// Repo switch: the worktree holds a different repo than the session
			// now targets. Checkpoint dirty work to the outgoing branch (still
			// on the old repo), wipe, and fall through to a fresh clone.
			if (session.cloned && session.repo) {
				const remote = await sbx
					.runIn(REPO_DIR, "git remote get-url origin", 15_000)
					.catch(swallow("executor", "op", { stdout: "", exitCode: 1, stderr: "" }));
				const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/.exec(remote.stdout.trim());
				if (m?.[1] && m[1] !== session.repo) {
					await this.sink.emit({ type: "cloud-status", text: `Switching repo — sandbox has ${m[1]}, session is on ${session.repo}…` });
					await this.checkpointResetFrom(session, sbx);
					await sbx.runIn("/", `rm -rf ${REPO_DIR}`, 30_000).catch(swallow("executor", "op"));
					session.cloned = false;
					await this.sink.patchSession({ cloned: false });
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
			this.throwIfStopped();
		}
		// A (re)clone lands on the default/start ref — an existing session
		// branch must be checked out and reconciled first, or reconcile math
		// (`origin/<branch>..HEAD`) compares it against `main` by accident.
		if (session.branch) {
			this.throwIfStopped();
			const cur = await sbx.runIn(REPO_DIR, "git rev-parse --abbrev-ref HEAD", 15_000).catch(swallow("executor", "op"));
			if (cur?.stdout.trim() !== session.branch) {
				// A dirty worktree can block the switch — stash it first, then
				// restore (mirrors reconcileBranch's autosave approach).
				const dirty = (await sbx.runIn(REPO_DIR, "git status --porcelain", 15_000).catch(swallow("executor", "op")))?.stdout.trim() !== "";
				let stashed = false;
				if (dirty) {
					const st = await sbx.runIn(REPO_DIR, "git stash push -m kronyx-branch-switch", 30_000).catch(swallow("executor", "op"));
					stashed = st?.exitCode === 0 && !st.stdout.includes("No local changes");
				}
				const r = await sbx
					.runIn(
						REPO_DIR,
						`git fetch origin && (git checkout ${JSON.stringify(session.branch)} || git checkout -B ${JSON.stringify(session.branch)} origin/${session.branch})`,
						90_000,
					)
					.catch(swallow("executor", "op"));
				if (!r || r.exitCode !== 0)
					await this.sink.emit({ type: "info", text: `Could not check out ${session.branch} — staying on the local checkout.` });
				if (stashed) {
					const pop = await sbx.runIn(REPO_DIR, "git stash pop", 30_000).catch(swallow("executor", "op"));
					if (pop?.exitCode !== 0)
						await this.sink.emit({ type: "info", text: "Stashed changes couldn't be auto-restored after the branch switch — kept in `git stash`." });
				}
			}
			await this.reconcileBranch(undefined, session, sbx, false);
		}
		// Stamp the repo the VM actually cloned — like templateId, the remote
		// URL is the truth; session.repo is only what we asked for.
		const remote = await sbx
			.runIn(REPO_DIR, "git remote get-url origin", 15_000)
			.catch(swallow("executor", "op", { stdout: "", exitCode: 1, stderr: "" }));
		const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/.exec(remote.stdout.trim());
		if (m?.[1]) {
			const repo = m[1];
			const id = sbx.sandboxId;
			if (id)
				void this.db
					.collection("sandboxes")
					.updateOne({ uid: this.sink.uid, sandboxId: id }, { $set: { repo } })
					.catch(swallow("executor", "op"));
			if (session.repo && session.repo !== repo)
				await this.sink.emit({ type: "info", text: `Sandbox remote is ${repo}, but the session says ${session.repo} — repo mismatch.` });
		}
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
		await this.sink.emit({ type: "cloud-status", key: "sandbox", text: session.sandboxId ? `Connecting to your sandbox ${session.sandboxId}…` : "Creating a new sandbox…" });
		const prevSandboxId = session.sandboxId;
		let sbx = await this.raceStop(this.ensureSandbox(session, settings, { llm: provider, task: job.task }), SANDBOX_START_MS, "Sandbox start", session.sandboxId);
		// Warm = same VM reconnected with its clone intact — its worktree is
		// authoritative continuity state; remote-newer syncs must ask first.
		const warmSandbox = !!prevSandboxId && sbx.sandboxId === prevSandboxId && !!session.cloned;
		this.activeSession = session;
		this.startSandboxKeepalive(sbx);
		this.throwIfStopped();
		const token = await this.githubToken(session, settings);
		this.sink.mask(token);

		// Stale prUrl: the stored PR may be merged/closed since the last run —
		// clear it up front so the header doesn't point at a closed PR while
		// new work is in flight (openPr re-links on the next push).
		if (session.prUrl && session.repo && token) {
			const n = /\/pull\/(\d+)/.exec(session.prUrl)?.[1];
			if (n) {
				const st = await fetch(`https://api.github.com/repos/${session.repo}/pulls/${n}`, {
					headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
					signal: AbortSignal.timeout(15_000),
				})
					.then((r) => (r.ok ? r.json() : null))
					.then((d: any) => (d?.merged_at ? "merged" : d?.state === "closed" ? "closed" : "open"))
					.catch(() => "open");
				if (st !== "open") {
					session.prUrl = undefined;
					await this.sink.patchSession({ prUrl: null });
				}
			}
		}

		await this.ensureRepoReady(session, sbx, token);

		const atts = await this.attachments(job);
		if (job.planSlug) {
			const plan = await loadPlan(this.db, job.uid, job.sessionId, job.planSlug);
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
			await this.ensureBranch(job, session, sbx, token, provider, warmSandbox);
			await this.reconcileRestoredState(job, session, sbx);
			await this.kickstartDeps(session, sbx);
			await this.preflight(job, session, sbx, token, settings);
		} else if (!session.branch) {
			// Plan mode with no work branch: nothing checks the repo out to the
			// picked start point — sync the worktree so reads see the right code.
			await this.syncPlanWorktree(session, sbx, token);
		}
		// Plan mode with an existing session branch: ensureRepoReady already
		// checked it out and reconciled it — reads see that branch's code.

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
		const { runner, live } = await this.ensureRunner(job, session, "sandboxed", mode, async () => [
				...createRemoteFileTools(delegatingHandle(live), REPO_DIR, {
					planDir: PLAN_DIR,
					onCommandOutput: (chunk) => this.queueToolOutput(chunk),
					onFileChanged: (rel, kind, stats) => this.emitLiveFileChanged(rel, kind, stats),
					isAborted: () => this.stopRequested || !!live.dead,
					// Persist the plan server-side the moment it's saved — capturePlan's
					// run-end sweep can't help if the VM dies or the run is stopped.
					onPlanSaved: (slug, markdown) => void savePlanFile(job.uid, job.sessionId, slug, markdown, job.runId).catch(swallow("executor", "op")),
					// Plans persist server-side — sandbox files die with the VM, so
					// reads must come from the backend store, not the worktree.
					onListPlans: () => listPlans(this.db, job.uid, job.sessionId).catch(swallow("executor", "op", [])),
					onReadPlan: (slug) => loadPlan(this.db, job.uid, job.sessionId, slug).then((p) => p?.markdown ?? null).catch(swallow("executor", "op", null)),
				}),
				memoryWriteTool(this.db, job.uid, job.sessionId, job.runId, this.embedProvider, { repo: session.repo ?? undefined, branch: session.base }, this.memoryReport),
				// fetch_url runs worker-side — readable text for URLs the user links.
				...createFetchTools(),
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
				// MCP servers (user settings) — host stdio + remote URL; failures
				// contribute zero tools rather than killing the run.
				...(await this.mcpToolsFor(settings)),
			],
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
			// Mid-run VM death: delegatingHandle latches live.dead + calls onDead —
			// stopping the agent promptly instead of letting it flail against a
			// ghost VM. One recreate+resume retry, same contract as runTail.
			live.onDead = () => this.runner?.stop();
			this.assertCanViewImages(provider, atts);
			const tailAtts = this.runnerAttachments(atts);
			let resumed = false;
			let preservedWorktree = false;
			for (;;) {
				live.dead = undefined;
				await runner.run(
					resumed
						? preservedWorktree
							? "The sandbox VM running your tools stopped responding and was recovered — its disk was preserved, so the worktree (including uncommitted changes) should be intact. Check git status and the files you were editing, then continue the task."
							: "The sandbox VM running your tools died and was recreated — the repository was re-cloned to your session branch, but any uncommitted changes were lost. Check the current state (git status, the files you were editing) and continue the task."
						: this.taskWithInline(job.task, atts, `${ATTACH_DIR}/`),
					provider,
					tailAtts,
				);
				if (!live.dead || resumed || this.stopRequested) break;
				resumed = true;
				// Wedged (envd dead, VM maybe alive): snapshot/pause first — the
				// boot ladder can then resume the whole worktree instead of
				// recloning and losing uncommitted work.
				const wedged = !isSandboxDeath(live.dead) && isSandboxUnresponsive(live.dead);
				preservedWorktree = !!(wedged && session.sandboxId && (await this.rescueWedgedSandbox(session, settings, session.sandboxId)));
				await this.sink.emit({
					type: "info",
					text: preservedWorktree
						? "Sandbox stopped responding — preserved its disk; attempting resume with the worktree intact."
						: wedged
							? "Sandbox stopped responding — recreating the VM (uncommitted changes were lost)."
							: "Sandbox died mid-run — recreating the VM and resuming (uncommitted changes were lost).",
				});
				await this.sink.emit({ type: "sandbox-recreated", reason: "mid-run" } as Record<string, unknown>).catch(swallow("executor", "op"));
				if (!preservedWorktree) {
					// Drop the dead id so ensureSandbox creates instead of reconnecting.
					session.sandboxId = undefined;
					session.cloned = false;
					await this.sink.patchSession({ sandboxId: null, cloned: false });
				}
				const next = await this.raceStop(this.ensureSandbox(session, settings), SANDBOX_START_MS, "Sandbox start", session.sandboxId);
				sbx = next;
				this.activeSbx = next;
				this.startSandboxKeepalive(next);
				await this.ensureRepoReady(session, next, token);
				live.handle = next.inner!;
				live.stopped = false;
			}
		} finally {
			live.onDead = undefined;
			if (tokenRefresh) clearInterval(tokenRefresh);
		}
		this.throwIfStopped();
		// HEAD now = the point this run's work rests on; afterRun stamps it
		// onto the run's digests so a later restore can verify ancestry.
		const head = await sbx.runIn(REPO_DIR, "git rev-parse HEAD", 15_000).catch(swallow("executor", "op"));
		if (head?.stdout.trim()) this.lastHeadSha = head.stdout.trim();
		await this.afterRun(job);

		if (mode === "plan") {
			await this.capturePlan(job, sbx);
			return;
		}
		this.throwIfStopped();
		await this.runTail(job, session, settings, () => sbx, (next) => {
			sbx = next;
			this.activeSbx = next;
			live.handle = next.inner!;
		}, token);
	}

	/**
	 * Post-run tail: checkpoint commit+push → pushAndPr → verify. The PR opens
	 * BEFORE verify so a dying VM or a failing check can't block it (verify
	 * results still land in the run-completed card). The VM can die at any
	 * point — on sandbox death recreate + reclone the pushed branch and retry
	 * once; only uncommitted work is lost.
	 */
	private async runTail(
		job: CloudJob,
		session: SessionDoc,
		settings: UserSettings,
		getSbx: () => SandboxCore,
		setSbx: (next: SandboxCore) => void,
		token: string,
	): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			const sbx = getSbx();
			try {
				// Checkpoint: committed work goes remote FIRST — the pushed
				// branch is the only durable state in an ephemeral VM.
				if (session.branch) {
					await sbx
						.commitAndPush(REPO_DIR, session.branch, "kronyx: checkpoint before verify", COMMIT_EXCLUDES)
						.catch(async () => this.sink.emit({ type: "info", text: "Checkpoint push failed — continuing." }));
				}
				await this.sink.patchRun({ status: "pushing" }).catch(swallow("executor", "op"));
				await this.pushAndPr(job, session, settings, sbx, token);
				this.throwIfStopped();
				if (settings.data.postRunChecks !== false) {
					await this.sink.patchRun({ status: "verifying" }).catch(swallow("executor", "op"));
					await this.verify(sbx);
				}
				return;
			} catch (err) {
				const hardDead = isSandboxDeath(err);
				// A wedged VM (envd unresponsive) throws deadline_exceeded, which
				// isn't a death signature — probe before condemning it; one
				// transient gateway timeout isn't a dead VM.
				const wedged =
					!hardDead &&
					isSandboxUnresponsive(err) &&
					!(await sbx.runIn("/", "echo ok", 20_000).then((r) => r.stdout.includes("ok")).catch(() => false));
				if (attempt > 0 || !(hardDead || wedged) || this.stopRequested) throw err;
				const preserved = !!(wedged && session.sandboxId && (await this.rescueWedgedSandbox(session, settings, session.sandboxId)));
				await this.sink.emit({
					type: "info",
					text: preserved
						? "Sandbox stopped responding — preserved its disk; resuming with the worktree intact."
						: wedged
							? "Sandbox stopped responding during the run tail — recreating and resuming from the pushed branch (uncommitted changes were lost)."
							: "Sandbox died during the run tail — recreating and resuming from the pushed branch (uncommitted changes were lost).",
				});
				await this.sink.emit({ type: "sandbox-recreated", reason: "run-tail" } as Record<string, unknown>).catch(swallow("executor", "op"));
				if (!preserved) {
					// Drop the dead id so ensureSandbox creates instead of reconnecting.
					session.sandboxId = undefined;
					session.cloned = false;
					await this.sink.patchSession({ sandboxId: null, cloned: false });
				}
				const next = await this.raceStop(this.ensureSandbox(session, settings), SANDBOX_START_MS, "Sandbox start", session.sandboxId);
				setSbx(next);
				this.startSandboxKeepalive(next);
				await this.ensureRepoReady(session, next, token);
			}
		}
	}

	/** Fork-mode slices (flags.sliceFork): slice index → its own sandbox handle. */
	private sliceForks = new Map<number, SandboxHandle>();
	/** Creds + provider captured at fork time so stopCleanup can kill forks. */
	private sliceForkCtx: { provider: SandboxProvider; creds: ProviderCreds } | undefined;
	private async killSliceForks(): Promise<void> {
		const ctx = this.sliceForkCtx;
		for (const h of this.sliceForks.values()) {
			const dead = ctx ? await ctx.provider.killById(h.id, ctx.creds).catch(swallow("executor", "op", false)) : false;
			await this.db
				.collection("sandboxes")
				.updateOne({ sandboxId: h.id }, { $set: { state: dead ? "dead" : "unknown", deadAt: new Date() } })
				.catch(swallow("executor", "op"));
		}
		this.sliceForks.clear();
	}

	// ------------------------------------------------------------------
	// Multi-agent mode: planner → worktree slices → merge fan-in → agent tail.
	// ------------------------------------------------------------------

	private async multi(job: CloudJob, session: SessionDoc, settings: UserSettings): Promise<void> {
		const ctx = await this.prepareSandboxed(job, session, settings);
		const { provider, token, atts, mode } = ctx;
		let sbx = ctx.sbx;
		this.throwIfStopped();
		// Sweep stale state from a previously killed multi run: slice worktrees,
		// and any open merge/rebase or leftover edits in the main checkout —
		// a stale MERGE_HEAD would poison this run's merges and commits.
		await sbx
			.runIn(
				REPO_DIR,
				`rm -rf /home/user/repo-wt* 2>/dev/null; git worktree prune; git merge --abort 2>/dev/null; git rebase --abort 2>/dev/null; git cherry-pick --abort 2>/dev/null; if [ -n "$(git diff --name-only --diff-filter=U 2>/dev/null)" ]; then git reset --hard HEAD; fi; true`,
				30_000,
			)
			.catch(swallow("executor", "op"));

		const planned = await this.planSlices(job, provider, sbx, this.taskWithInline(job.task, atts, `${ATTACH_DIR}/`));
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

		// Visible plan card before fan-out — the planner call is silent
		// otherwise, so the first thing the user sees would be the slice list
		// with no "here's the plan" step in between.
		await this.sink.emit(
			{ type: "multi-plan", steps: slices.map((s) => ({ index: s.index, title: s.title, task: s.task.slice(0, 300) })) },
			{ agentIndex: 0 },
		);

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

		this.throwIfStopped();
		// Isolation decision (settings.data.sliceForkMode: always|never|auto,
		// default auto): fork per slice = real parallel VMs — worth it only for
		// genuinely heavy/parallel work (test/build/serve/browser jobs, or a
		// slice that wants a different template), or when the fan-out is wide
		// enough that one VM would thrash. Light disjoint edits stay on
		// shared-VM worktrees. The sliceFork flag stays the master kill switch.
		const sandboxProvider = getProvider(sbx.providerName);
		const creds: ProviderCreds = { secrets: settings.secrets, data: settings.data };
		const isoMode = String(settings.data.sliceForkMode ?? "auto").toLowerCase();
		const HEAVY = /test|build|serv|e2e|playwright|browser|migrat|docker|compil|install|bench/i;
		const wantFork =
			isoMode === "always"
				? true
				: isoMode === "never"
					? false
					: slices.length >= 3 || slices.some((s) => HEAVY.test(`${s.title} ${s.task}`) || (s.env?.template && s.env.template !== session.template));
		if (
			wantFork &&
			sandboxProvider.capabilities.fork &&
			sandboxProvider.forkById &&
			(await flag(
				this.db,
				{ uid: job.uid, repo: session.repo ?? undefined, template: session.template ?? undefined, sessionId: session.sessionId },
				FLAGS.sliceFork,
			))
		) {
			const forks = await sbx.fork(slices.length, 60 * 60_000).catch(() => [] as SandboxHandle[]);
			if (forks.length >= slices.length) {
				this.sliceForkCtx = { provider: sandboxProvider, creds };
				for (const [i, s] of slices.entries()) {
					this.sliceForks.set(s.index, forks[i]);
					await this.db
						.collection("sandboxes")
						.insertOne({ uid: job.uid, sandboxId: forks[i].id, provider: sbx.providerName, state: "running", sessionId: job.sessionId, reason: `slice-${s.index}-fork`, at: new Date() })
						.catch(swallow("executor", "op"));
				}
				await this.sink.emit({ type: "info", text: `Forked ${forks.length} sandboxes — each slice runs on its own VM.` });
			} else {
				for (const h of forks) await sandboxProvider.killById(h.id, creds).catch(swallow("executor", "op", false));
				if (forks.length)
					await this.sink.emit({ type: "info", text: `Fork gave ${forks.length}/${slices.length} VMs — falling back to shared-sandbox worktrees.` });
			}
		}
		if (!this.sliceForks.size)
			await this.sink.emit({ type: "info", text: `Slices share one sandbox as git worktrees — each commits to ${session.branch}-part-N, merged back at fan-in (isolation: ${isoMode}${wantFork ? " — fork flag off or fork unavailable" : ""}).` });
		// Forked VMs must die on ANY exit path — a non-stop error between fork
		// and fan-in otherwise leaks them to the janitor's idle timers.
		try {
		for (const s of slices) {
			const fh = this.sliceForks.get(s.index);
			// -B (not -b): a surviving part-N branch from a killed prior run
			// must not fail the retry — reset it onto HEAD.
			const r = fh
				? await fh
						.run(`git checkout -B ${JSON.stringify(`${session.branch}-part-${s.index}`)}`, { cwd: REPO_DIR, timeoutMs: 120_000 })
						.catch(swallow("executor", "op", { exitCode: 1, stdout: "", stderr: "fork checkout failed" }))
				: await sbx
						.runIn(REPO_DIR, `git worktree add ${SLICE_DIR(s.index)} -B ${JSON.stringify(`${session.branch}-part-${s.index}`)}`, 120_000)
						.catch(swallow("executor", "op", { exitCode: 1, stdout: "", stderr: "worktree add failed" }));
			if (r.exitCode !== 0) throw new Error(`Slice ${s.index} setup failed: ${r.stderr.slice(0, 300)}`);
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

		// Cold-start memory recall — same pipeline as ensureRunner. The parent
		// manifest gets the base recall; each slice re-searches on its own task
		// inside memoryContext and records its own manifest on its sub-run doc.
		const embed = this.embedProvider;
		const trivialJob = isTrivialTask(job.task);
		if (trivialJob) this.memoryReport({ op: "memory_recall", path: "trivial-skip", query: job.task.slice(0, 140) });
		const baseMemories = trivialJob
			? []
			: await searchMemories(this.db, job.uid, job.sessionId, job.task, embed, session.repo ?? undefined, this.memoryReport, job.runId, session.base ?? undefined).catch(
					swallow("executor", "op", [] as MemoryDoc[]),
				);
		const baseInjected = baseMemories.slice(-10);
		const planSlugs = (
			await listPlans(this.db, job.uid, job.sessionId).catch(swallow("executor", "op", [] as { slug: string }[]))
		).map((p) => p.slug);
		const sliceTranscripts = await loadTranscripts(this.db, job.uid, job.sessionId).catch(swallow("executor", "op", [] as PriorTranscript[]));
		const ctxManifest: ContextManifest = {
			contextId: randomUUID(),
			transcriptsIncluded: sliceTranscripts.map((t) => t.label),
			digestCount: (session as { digests?: unknown[] }).digests?.length ?? 0,
			memoryIdsUsed: baseInjected.map((m) => m.memoryId),
			memoryChars: baseInjected.reduce((s, m) => s + m.content.length, 0),
			planSlugs,
			builtAt: new Date(),
		};
		await this.sink.patchRun({ contextManifest: ctxManifest }).catch(swallow("executor", "op"));
		const sliceMem = { embed, baseMemories, planSlugs, transcripts: sliceTranscripts };

		const runSlice = async (s: SliceSpec): Promise<void> => {
			const sliceLive: LiveSlot = { handle: this.sliceForks.get(s.index) ?? sbx.inner! };
			const finishText: { value: string; failed?: string } = { value: "" };
			const runner = this.makeSliceRunner(job, session, s, sbx, sliceLive, mode, finishText, sliceMem);
			this.sliceAgents.push({ runner, live: sliceLive });
			await markSlice(s, "running");
			try {
				// AgentRunner.run() never throws — failures arrive as run-failed events.
				await runner.run(this.sliceTask(s), provider);
				if (finishText.failed && !this.stopRequested) await markSlice(s, "failed", finishText.failed.slice(0, 400));
				else await markSlice(s, this.stopRequested ? "stopped" : "done", finishText.value || "Done.");
				if (!this.stopRequested) await this.recordMemoryOutcome(job, finishText.failed ? "failed" : "completed", `${job.runId}-s${s.index}`);
			} catch (err) {
				await markSlice(s, this.stopRequested ? "stopped" : "failed", String(err).slice(0, 400));
				if (!this.stopRequested) await this.recordMemoryOutcome(job, "failed", `${job.runId}-s${s.index}`);
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
		/** Run a command in the slice's checkout — its own VM when forked,
		 *  the shared worktree otherwise. */
		const sliceRun = (i: number, cmd: string, timeoutMs: number) =>
			this.sliceForks.get(i)?.run(cmd, { cwd: REPO_DIR, timeoutMs }) ?? sbx.runIn(SLICE_DIR(i), cmd, timeoutMs);
		const results: { index: number; title: string; status: "merged" | "resolved" | "failed"; detail?: string }[] = [];
		const depLines: string[] = [];
		const seenDepLines = new Set<string>();
		// Final coordinator text — mined for the NEXT STEPS section that
		// lands on the changes card.
		let lastCoordText = "";

		/** One coordinator invocation — resolves conflicts or applies deferred
		 *  manifest changes. Returns false when the pass itself errored. */
		const runCoordinator = async (task: string): Promise<boolean> => {
			const coordLive: LiveSlot = { handle: sbx.inner! };
			const coordFinish: { value: string; failed?: string } = { value: "" };
			const coordinator = this.makeSliceRunner(
				job,
				session,
				{ index: 0, title: "Coordinator", task, owns: ["**"], env: null },
				sbx,
				coordLive,
				mode,
				coordFinish,
				sliceMem,
				true,
			);
			this.sliceAgents.push({ runner: coordinator, live: coordLive });
			const coordStarted = Date.now();
			await patchSliceRun(0, { task: "Merge coordinator", kind: "coordinator", status: "running", startedAt: new Date() });
			let coordErr: unknown;
			try {
				await coordinator.run(task, provider);
				if (coordFinish.failed) coordErr = coordFinish.failed;
			} catch (e) {
				coordErr = e;
			} finally {
				this.sliceAgents = this.sliceAgents.filter((a) => a.runner !== coordinator);
				this.finishedSliceRunners.push({ runner: coordinator, agentIndex: 0 });
				if (coordFinish.value) lastCoordText = coordFinish.value;
				await patchSliceRun(0, {
					status: this.stopRequested ? "stopped" : coordErr ? "failed" : "done",
					finishedAt: new Date(),
					durationMs: Date.now() - coordStarted,
					...(coordErr ? { summary: String(coordErr).slice(0, 400) } : {}),
				});
				if (!this.stopRequested) await this.recordMemoryOutcome(job, coordErr ? "failed" : "completed", `${job.runId}-s0`);
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
			const changed = await sliceRun(
				s.index,
				"{ git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u",
				30_000,
			).catch(swallow("executor", "op", { exitCode: 1, stdout: "", stderr: "" }));
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
			const dirty = await sliceRun(s.index, "git status --porcelain", 15_000).catch(
				swallow("executor", "op", { exitCode: 1, stdout: "", stderr: "" }),
			);
			if (dirty.stdout.trim()) {
				await sliceRun(
					s.index,
						`git add -A -- . ${COMMIT_EXCLUDES.map((d) => `':(exclude)${d}'`).join(" ")} && git commit -m ${JSON.stringify(`slice ${s.index}: ${s.title}`)}`,
						60_000,
					)
					.catch(swallow("executor", "op"));
			}
			const part = `${session.branch}-part-${s.index}`;
			// Forked slices commit on their own VM — the coordinator can only
			// merge the ref once it's pushed to origin and fetched back.
			const forkedSlice = this.sliceForks.get(s.index);
			if (forkedSlice) {
				await forkedSlice
					.run(`git push -f -u origin ${JSON.stringify(part)}`, { cwd: REPO_DIR, timeoutMs: 120_000 })
					.catch(swallow("executor", "op"));
				await sbx.runIn(REPO_DIR, `git fetch origin ${JSON.stringify(part)}`, 60_000).catch(swallow("executor", "op"));
			}
			const mergeRef = forkedSlice ? `origin/${part}` : part;
			const has = await sbx.runIn(REPO_DIR, `git rev-parse --verify ${JSON.stringify(mergeRef)}`, 15_000).catch(swallow("executor", "op"));
			if (!has || has.exitCode !== 0) {
				results.push({ index: s.index, title: s.title, status: "failed", detail: "part branch missing" });
				continue;
			}
			const m = await sbx
				.runIn(REPO_DIR, `git merge --no-ff ${JSON.stringify(mergeRef)} -m ${JSON.stringify(`merge slice ${s.index}: ${s.title}`)}`, 120_000)
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
		// real feature work, run on the selected model).
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
			parts.push(
				"End your final message with a `NEXT STEPS:` line followed by up to 5 `- ` bullet suggestions for follow-up work (tests, docs, refactors, verification). Write `NEXT STEPS: none` if nothing is worth suggesting.",
			);
			await runCoordinator(parts.join("\n"));
		}
		// Next steps: parsed from the coordinator's NEXT STEPS trailer. When no
		// coordinator pass ran, fall back to mining slice summaries — several
		// agents naturally end with suggested follow-ups.
		const nextSteps = (() => {
			const pool = [lastCoordText, ...[...sliceState.values()].map((s) => s.summary)];
			for (const text of pool) {
				const m = /NEXT STEPS:\s*([\s\S]*)$/im.exec(text ?? "");
				if (!m) continue;
				const steps = m[1]
					.split("\n")
					.map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
					.filter((l) => l && !/^none\.?$/i.test(l))
					.slice(0, 6);
				if (steps.length) return steps;
			}
			return [] as string[];
		})();
		await sealMerge();
		await this.sink.emit({ type: "fanin", results }, { agentIndex: 0 });
		// One-line outcome for the timeline — the fanin card shows detail, this
		// gives the partial-vs-total-failure signal at a glance.
		const cnt = (st: string) => results.filter((r) => r.status === st).length;
		await this.sink.emit({
			type: "info",
			text: `Fan-in complete: ${cnt("merged")} merged, ${cnt("resolved")} resolved, ${cnt("failed")} failed${droppedSlices.length ? `, ${droppedSlices.length} deferred to coordinator` : ""}.`,
		});

		// Combined diff of the merged session branch vs base — powers the
		// "changes applied" summary card + combined-diff viewer in the UI.
		try {
			const base = String(session.base || "main");
			const mb = await sbx
				// Fetch first — single-branch clones and PR startRefs may not have
				// origin/<base> locally, which would degrade to a bogus HEAD~1 diff.
				.runIn(REPO_DIR, `git fetch -q origin ${JSON.stringify(base)} 2>/dev/null; git merge-base HEAD ${JSON.stringify(`origin/${base}`)} 2>/dev/null || git rev-parse HEAD~1`, 45_000)
				.catch(swallow("executor", "op"));
			const mbSha = mb?.stdout.trim().split("\n")[0] ?? "";
			if (mb?.exitCode === 0 && mbSha) {
				// --no-renames: renamed files become D+A pairs, keeping the
				// name-status/numstat path keys aligned (rename brace syntax
				// otherwise mis-keys the numstat lookup and skews the counts).
				const [ns, stat, patch, num] = await Promise.all([
					sbx.runIn(REPO_DIR, `git diff --name-status --no-renames ${mbSha} HEAD`, 30_000).catch(swallow("executor", "op")),
					sbx.runIn(REPO_DIR, `git diff --stat --no-renames ${mbSha} HEAD | tail -1`, 30_000).catch(swallow("executor", "op")),
					sbx.runIn(REPO_DIR, `git diff --no-renames ${mbSha} HEAD`, 60_000).catch(swallow("executor", "op")),
					sbx.runIn(REPO_DIR, `git diff --numstat --no-renames ${mbSha} HEAD`, 30_000).catch(swallow("executor", "op")),
				]);
				const adds: Record<string, { added: number; removed: number }> = {};
				for (const l of (num?.stdout ?? "").split("\n")) {
					const parts = l.trim().split("\t");
					if (parts.length >= 3) adds[parts[parts.length - 1]] = { added: parts[0] === "-" ? 0 : +parts[0], removed: parts[1] === "-" ? 0 : +parts[1] };
				}
				const files: { path: string; status: string; added: number; removed: number }[] = [];
				for (const l of (ns?.stdout ?? "").split("\n")) {
					const parts = l.trim().split("\t");
					if (parts.length >= 2 && /^[AMDRT]/.test(parts[0])) {
						const path = parts[parts.length - 1];
						files.push({ path, status: parts[0][0], added: adds[path]?.added ?? 0, removed: adds[path]?.removed ?? 0 });
					}
				}
				const fullDiff = patch?.stdout ?? "";
				const diff = fullDiff.slice(0, 200_000);
				if (files.length || diff || nextSteps.length)
					await this.sink.emit(
						{ type: "combined-diff", base, stat: stat?.stdout.trim() ?? "", files, diff, truncated: fullDiff.length > diff.length, nextSteps },
						{ agentIndex: 0 },
					);
			}
		} catch {
			// Best-effort — the fan-in summary above still stands on its own.
		}

		// Delete merged part branches on the remote — their commits are
		// reachable through the merge commits on session.branch. Failed
		// slices keep theirs: it's the only copy of that unmerged work.
		let cleaned = 0;
		for (const r of results) {
			if (r.status !== "merged" && r.status !== "resolved") continue;
			const part = `${session.branch}-part-${r.index}`;
			const ok = await sbx
				.runIn(REPO_DIR, `git push origin --delete ${JSON.stringify(part)} && git branch -D ${JSON.stringify(part)} 2>/dev/null || true`, 60_000)
				.then((x) => x.exitCode === 0)
				.catch((err: unknown) => (isSandboxDeath(err) ? "dead" : false));
			if (ok === "dead") break; // VM gone — every remaining op would just log the same death
			if (ok) cleaned++;
		}
		if (cleaned)
			await this.sink.emit({ type: "info", text: `Cleaned up ${cleaned} merged part branch${cleaned === 1 ? "" : "es"}.` });

		// Worktree cleanup (branches stay — they're merged history). Forked
		// slices have no worktree on this VM — kill their sandbox instead.
		for (const s of slices) {
			if (this.sliceForks.has(s.index)) continue;
			const dead = await sbx
				.runIn(REPO_DIR, `git worktree remove --force ${SLICE_DIR(s.index)} 2>/dev/null || true`, 30_000)
				.catch((err: unknown) => isSandboxDeath(err));
			if (dead) break; // VM gone — remaining worktree removes would just re-log the same death
		}
		} finally {
			await this.killSliceForks();
		}

		this.throwIfStopped();
		await this.afterRun(job);
		this.throwIfStopped();
		await this.runTail(job, session, settings, () => sbx, (next) => {
			sbx = next;
			this.activeSbx = next;
		}, token);
	}

	/** Planner: one cheap chat call returns the slice list (or null → single agent). */
	private async planSlices(
		job: CloudJob,
		provider: ProviderSettings,
		sbx: SandboxCore,
		fullTask: string,
	): Promise<ParsedSlices | null> {
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

	/** Slice/coordinator runner: own worktree tools, boundary guard on
	 *  writes, memory context + recall scorer, events tagged with agentIndex.
	 *  No browser/env tools. */
	private makeSliceRunner(
		job: CloudJob,
		session: SessionDoc,
		slice: SliceSpec,
		sbx: SandboxCore,
		sliceLive: LiveSlot,
		mode: AgentMode,
		finishText: { value: string; failed?: string },
		mem: { embed: EmbedProvider | undefined; baseMemories: MemoryDoc[]; planSlugs: string[]; transcripts: PriorTranscript[] },
		coordinator = false,
	): AgentRunner {
		const dir = coordinator || this.sliceForks.has(slice.index) ? REPO_DIR : SLICE_DIR(slice.index);
		const handle = delegatingHandle(sliceLive);
		let permLayers: PermissionLayers | undefined;
		const agentIndex = slice.index;
		const sliceRunId = `${job.runId}-s${agentIndex}`;
		/** Memory report events for this slice — tagged with agentIndex so the
		 *  events page can attribute them to the right sub-agent. */
		const sliceReport = (d: Record<string, unknown>) => void this.sink.emit({ type: "memory", ...d }, { agentIndex });
		const runner = new AgentRunner({
			events: {
				record: (e) => void this.sink.emit(e as Record<string, unknown>, { agentIndex }),
			},
			workspaceRoot: dir,
			relativePath: (abs) => abs.replace(`${dir}/`, ""),
			isDirty: () => false,
			approvals: {
				confirm: async (toolName, input) => {
					if (session.securityProfile !== "controlled") return true;
					return this.awaitPermission(job, toolName, input);
				},
				check: async (toolName, input) => {
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
			},
			currentMode: () => mode,
			// Identical env string across slices → identical system-prompt
			// prefix → provider-side prompt caching can share it. Index-specific
			// context lives in the task text instead.
			environment: coordinator
				? "an E2B cloud sandbox — you are the merge coordinator finishing a parallel multi-agent run"
				: `an E2B cloud sandbox — one of several parallel agents working in a git worktree of the same repository`,
			// Slice tasks differ from job.task — re-search per slice and record
			// the actually-injected ids on the slice's own run doc so outcome
			// credit attributes to this slice, not the parent.
			memory: {
				context: async (task) => {
				const recalled =
					task === job.task
						? mem.baseMemories
						: isTrivialTask(task)
							? []
							: await searchMemories(this.db, job.uid, job.sessionId, task, mem.embed, session.repo ?? undefined, sliceReport, sliceRunId, session.base ?? undefined).catch(swallow("executor", "op", mem.baseMemories));
				const injected = recalled.slice(-10);
				if (injected.length)
					void this.db
						.collection("runs")
						.updateOne(
							{ uid: job.uid, runId: sliceRunId },
							{ $set: { "contextManifest.memoryIdsUsed": injected.map((m) => m.memoryId), "contextManifest.memoryChars": injected.reduce((s, m) => s + m.content.length, 0) } },
						)
						.catch(swallow("executor", "op"));
				return sessionMemoryContext(session as SessionDoc & { mode?: string }, mem.planSlugs, recalled);
				},
			},
			recall: {
				scorer: mem.embed ? createRecallScorer(mem.embed, sliceReport) : undefined,
				transcripts: () => mem.transcripts,
			},
			log: (tag, msg) => console.log(`[slice${agentIndex}:${tag}] ${msg}`),
			transcripts: {
				save: (messages) => {
					this.pendingSaves.push(saveTranscript(this.db, job.uid, job.sessionId, job.runId, messages, agentIndex).catch(swallow("executor", "op")));
				},
			},
			tools: () =>
				Promise.resolve([
					// save_plan is runner-gated to plan mode anyway — dropping it here
					// keeps a dead tool out of the slice schema.
					...createRemoteFileTools(handle, dir, {
						allowedPaths: coordinator ? undefined : slice.owns,
						onCommandOutput: (chunk) => this.queueToolOutput(chunk, agentIndex),
						onFileChanged: (rel, kind, stats) => this.emitLiveFileChanged(rel, kind, stats, agentIndex),
						isAborted: () => this.stopRequested,
						onListPlans: () => listPlans(this.db, job.uid, job.sessionId).catch(swallow("executor", "op", [])),
						onReadPlan: (slug) => loadPlan(this.db, job.uid, job.sessionId, slug).then((p) => p?.markdown ?? null).catch(swallow("executor", "op", null)),
					}).filter((t) => t.name !== "save_plan"),
					memoryWriteTool(this.db, job.uid, job.sessionId, sliceRunId, mem.embed, { repo: session.repo ?? undefined, branch: session.base }, sliceReport),
					...createFetchTools(),
				]) as Promise<never>,
			emit: (e) => {
				if (e.type === "run-finished") finishText.value = String(e.text ?? "");
				if (e.type === "run-failed") finishText.failed = String(e.error ?? "Run failed");
				if (e.type === "run-finished" || e.type === "run-failed") {
					runner.addRunDigest({
						task: coordinator ? job.task : this.sliceTask(slice),
						status: e.type === "run-finished" ? String(e.status ?? "completed") : "failed",
						summary: String(e.type === "run-finished" ? e.text : e.error ?? ""),
						filesChanged: [...this.liveChangedPaths]
							.filter((p) => p.startsWith(`${agentIndex}:`))
							.map((p) => p.slice(p.indexOf(":") + 1)),
						at: Date.now(),
					});
				}
				if (e.type !== "assistant-delta" && e.type !== "reasoning-delta") dbg("run", `s${agentIndex}:${e.type}`, e);
				this.trackUsage(e, job, agentIndex);
				void this.sink.emit(e, { agentIndex });
			},
		});
		return runner;
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
			.runIn(REPO_DIR, `git fetch origin ${JSON.stringify(startRef)} && git checkout FETCH_HEAD`, 120_000)
			.catch(swallow("executor", "op", { exitCode: 1, stdout: "", stderr: "" }));
		await this.sink.emit({
			type: "info",
			text:
				r?.exitCode === 0
					? `Starting from ${startRef}`
					: `Could not fetch ${startRef} — starting from ${defaultBranch || "the default branch"}`,
		});
	}

	/** Commit+push a dirty worktree to the outgoing branch (resetFrom), then
	 *  clear it — shared by ensureBranch's refork path and plan-mode sync. */
	private async checkpointResetFrom(session: SessionDoc, sbx: SandboxCore): Promise<void> {
		if (!session.resetFrom) return;
		const dirty = await sbx
			.runIn(REPO_DIR, "git status --porcelain", 30_000)
			.catch(swallow("executor", "op", { exitCode: 0, stdout: "", stderr: "" }));
		if (dirty.stdout.trim()) {
			await this.sink.emit({ type: "cloud-status", text: `Saving uncommitted work to ${session.resetFrom}…` });
			await sbx
				.commitAndPush(REPO_DIR, session.resetFrom, "kronyx: checkpoint before switching start point", COMMIT_EXCLUDES)
				.then(() => this.sink.emit({ type: "info", text: `Uncommitted work pushed to ${session.resetFrom}.` }))
				.catch(() => this.sink.emit({ type: "info", text: `Couldn't checkpoint to ${session.resetFrom} — uncommitted edits may be lost.` }));
		}
		await this.sink.patchSession({ resetFrom: null });
		session.resetFrom = null;
	}

	/** Plan-mode worktree sync: no kronyx branch exists yet (or was just
	 *  reset), so nothing checks the repo out to the session's start point —
	 *  a stale VM checkout would keep serving the old branch's code. Fetch +
	 *  check out startRef read-only; the work branch is created by the next
	 *  agent run. */
	private async syncPlanWorktree(session: SessionDoc, sbx: SandboxCore, token: string): Promise<void> {
		// The remote URL embeds a token that expires — refresh before any
		// fetch/push (checkpoint included), or warm sandboxes fail on a stale URL.
		if (session.repo && token) await this.syncGhAuth(sbx, session.repo, token).catch(swallow("executor", "op"));
		await this.checkpointResetFrom(session, sbx);
		const startRef = String(session.startRef ?? session.base ?? "").trim();
		if (!startRef) return;
		const r = await sbx
			.runIn(REPO_DIR, `git fetch origin ${JSON.stringify(startRef)} && git checkout FETCH_HEAD`, 120_000)
			.catch(swallow("executor", "op", { exitCode: 1, stdout: "", stderr: "" }));
		if (r?.exitCode === 0) {
			await this.sink.emit({ type: "info", text: `Reading ${session.repo} at ${startRef}` });
			return;
		}
		// Dirty leftovers can block the switch — stash (non-destructive) and retry.
		const st = await sbx.runIn(REPO_DIR, "git stash push -m kronyx-plan-switch", 30_000).catch(swallow("executor", "op"));
		const stashed = st?.exitCode === 0 && !st.stdout.includes("No local changes");
		const r2 = await sbx
			.runIn(REPO_DIR, `git checkout FETCH_HEAD`, 60_000)
			.catch(swallow("executor", "op", { exitCode: 1, stdout: "", stderr: "" }));
		if (r2?.exitCode === 0) {
			await this.sink.emit({
				type: "info",
				text: `Reading ${session.repo} at ${startRef}${stashed ? " (uncommitted changes kept in git stash)" : ""}`,
			});
		} else {
			await this.sink.emit({ type: "info", text: `Could not check out ${startRef} — reading the existing checkout instead.` });
		}
	}

	/**
	 * Branch slug: the model names it from the task (cheap call, matches how
	 * planSlices reuses provider creds); falls back to <repo> so a failed/absent
	 * LLM call still yields `kronyx/<repo>-<runid>` rather than dead code.
	 */
	private async branchSlug(job: CloudJob, session: SessionDoc, provider?: ProviderSettings): Promise<string> {
		const p = provider;
		if (p?.baseUrl && p.apiKey && p.modelId) {
			const res = await fetch(`${p.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
				body: JSON.stringify({
					model: p.modelId,
					messages: [
						{
							role: "user",
							content: `Suggest a git branch slug for this coding task: 2-4 lowercase hyphenated words, max 24 chars, no prefix. Reply with ONLY the slug.\n\nTask: ${job.task.slice(0, 600)}`,
						},
					],
					max_tokens: 20,
					temperature: 0,
				}),
				signal: AbortSignal.timeout(15_000),
			}).catch(swallow("executor", "op", null));
			const body = res?.ok ? ((await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null) : null;
			const slug = slugify(String(body?.choices?.[0]?.message?.content ?? ""));
			if (slug && slug !== "run") return slug;
		}
		return slugify(session.repo?.split("/")[1] ?? "run");
	}

	private async ensureBranch(job: CloudJob, session: SessionDoc, sbx: SandboxCore, token: string, provider?: ProviderSettings, warm = false): Promise<void> {
		const base = session.base ?? "main";
		// Refresh the remote credential up front — the clone URL embeds a token
		// that expires, and every fetch/push below (plus the agent's own git
		// commands) hits the stale URL.
		if (session.repo && token) {
			await this.sink.emit({ type: "cloud-status", key: "branch", text: `Syncing branch ${session.branch ?? base}…` });
			await this.syncGhAuth(sbx, session.repo, token);
		}
		this.throwIfStopped();
		if (!session.branch) {
			// Per-task start-point change: the env picker cleared the branch and
			// left the old one in resetFrom. Preserve uncommitted work on it
			// before the new branch forks off the picked ref.
			await this.checkpointResetFrom(session, sbx);
			const branch = `kronyx/${await this.branchSlug(job, session, provider)}-${job.runId.replace(/^web-/, "").slice(0, 6)}`;
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
			// startRef follows the work branch — "where this session starts from"
			// IS its branch once one exists, so the composer/submit path can tell
			// continue-in-place from an actual start-point change.
			await this.sink.patchSession({ branch, startRef: branch });
			session.branch = branch;
			session.startRef = branch;
			await this.sink.emit({ type: "info", key: "branch", text: `Created branch ${branch}` });
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
		await this.reconcileBranch(job, session, sbx, warm);
		this.throwIfStopped();
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
	private async reconcileBranch(job: CloudJob | undefined, session: SessionDoc, sbx: SandboxCore, warm: boolean): Promise<void> {
		const branch = session.branch;
		if (!branch) return;
		await sbx.runIn(REPO_DIR, "git fetch origin", 60_000).catch(swallow("executor", "op"));
		const remote = await sbx.runIn(REPO_DIR, `git rev-parse --verify origin/${branch} 2>/dev/null`).catch(swallow("executor", "op"));
		if (!remote || remote.exitCode !== 0) {
			await this.sink.emit({ type: "info", key: "branch", text: `Branch ${branch} ready` });
			return; // no remote branch yet
		}
		const [aheadR, behindR] = await Promise.all([
			sbx.runIn(REPO_DIR, `git rev-list --count origin/${branch}..HEAD`).catch(swallow("executor", "op")),
			sbx.runIn(REPO_DIR, `git rev-list --count HEAD..origin/${branch}`).catch(swallow("executor", "op")),
		]);
		const ahead = Number(aheadR?.stdout.trim()) || 0;
		const behind = Number(behindR?.stdout.trim()) || 0;
		if (behind === 0) {
			await this.sink.emit({ type: "info", key: "branch", text: `Branch ${branch} up to date` });
			if (ahead > 0) await this.sink.emit({ type: "info", text: `${ahead} unpushed commit(s) will be pushed at the end of this run.` });
			return; // clean or strictly ahead — nothing to pull
		}
		const dirty = (await sbx.runIn(REPO_DIR, "git status --porcelain").catch(swallow("executor", "op")))?.stdout.trim() !== "";
		// Warm sandbox + remote commits the sandbox lacks = someone pushed
		// outside this session (GitHub UI, another machine, a merged PR).
		// The live worktree is the continuity state — ask before overwriting
		// it instead of silently reset --hard / rebasing remote commits in.
		if (warm && job) {
			const ok = await this.awaitPermission(job, "branch_sync", {
				branch,
				ahead,
				behind,
				dirty,
				command: `origin/${branch} is ${behind} commit(s) ahead of this sandbox (local: ${ahead} unpushed${dirty ? ", uncommitted changes" : ""}) — sync remote changes in?`,
			});
			if (!ok) {
				await this.sink.emit({
					type: "info",
					key: "branch",
					text: `Continuing on the sandbox's local state — ${behind} remote commit(s) on origin/${branch} not synced.`,
				});
				return;
			}
		}
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
			if (r?.exitCode === 0) await this.sink.emit({ type: "cloud-status", key: "branch", text: `Synced to origin/${branch} (${behind} commit(s)).` });
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
		await this.sink.emit({ type: "cloud-status", key: "branch", text: `Rebased ${ahead} commit(s) onto origin/${branch}.` });
		await unstash();
	}

	/**
	 * Kick off dependency install in the background, matched to the repo's
	 * stack. node_modules & co. aren't in the checkout, so bare `npx tsc`
	 * downloads packages on every call — a detached install is usually done
	 * by the time the agent reaches for the toolchain. /tmp/kronyx-deps.done
	 * gates it to once per VM; warm sandboxes keep their installed tree.
	 */
	private async kickstartDeps(session: SessionDoc, sbx: SandboxCore): Promise<void> {
		if (!session.repo) return;
		const probe = await sbx
			.runIn(
				REPO_DIR,
				"test -f /tmp/kronyx-deps.done && echo DONE; test -d node_modules && echo HAS_NM; ls package.json package-lock.json pnpm-lock.yaml yarn.lock bun.lock bun.lockb requirements.txt go.mod Cargo.toml Gemfile 2>/dev/null",
				20_000,
			)
			.catch(swallow("executor", "op"));
		const out = probe?.stdout ?? "";
		if (out.includes("DONE")) return;
		const has = (f: string) => out.split("\n").includes(f);
		let cmd = "";
		let tool = "";
		if (has("package.json") && !out.includes("HAS_NM")) {
			if (has("pnpm-lock.yaml") || has("bun.lock") || has("bun.lockb") || has("yarn.lock")) {
				cmd = has("pnpm-lock.yaml") ? "pnpm install --frozen-lockfile" : has("yarn.lock") ? "yarn install --frozen-lockfile" : "bun install";
				tool = cmd.split(" ")[0];
			} else {
				cmd = has("package-lock.json") ? "npm ci" : "npm install";
				tool = "npm";
			}
		} else if (has("requirements.txt")) {
			cmd = "pip3 install -r requirements.txt";
			tool = "pip3";
		} else if (has("go.mod")) {
			cmd = "go mod download";
			tool = "go";
		} else if (has("Cargo.toml")) {
			cmd = "cargo fetch";
			tool = "cargo";
		} else if (has("Gemfile")) {
			cmd = "bundle install";
			tool = "bundle";
		}
		if (!cmd) return;
		const present = await sbx.runIn("/", `command -v ${tool} >/dev/null 2>&1 && echo yes`, 15_000).catch(swallow("executor", "op"));
		if (!present?.stdout.includes("yes")) return;
		// Swap first: small-VM OOM (tsc/esbuild/npm concurrent) wedges envd and
		// looks like a dead sandbox. Best-effort — root or passwordless sudo only.
		const swap =
			"(sudo -n sh -c 'fallocate -l 2G /swapfile 2>/dev/null && chmod 600 /swapfile && mkswap /swapfile >/dev/null 2>&1 && swapon /swapfile' || sh -c 'fallocate -l 2G /swapfile 2>/dev/null && chmod 600 /swapfile && mkswap /swapfile >/dev/null 2>&1 && swapon /swapfile' || true) 2>/dev/null";
		await sbx
			.runIn(REPO_DIR, `setsid bash -c ${JSON.stringify(`${swap}; ${cmd} > /tmp/kronyx-deps.log 2>&1; echo $? > /tmp/kronyx-deps.exit; touch /tmp/kronyx-deps.done`)} >/dev/null 2>&1 < /dev/null &`, 15_000)
			.catch(swallow("executor", "op"));
		await this.sink.emit({ type: "cloud-status", text: `Installing dependencies in the background: ${cmd}` });
	}

	/**
	 * Restore-point reconciliation: verify the worktree against digest history.
	 * Cold restores land wherever origin/<branch> points — commits made by
	 * earlier runs may be missing (revert/reset) or external commits may have
	 * landed. Missing asks stay relevant: report them, and when the new task
	 * doesn't already cover them, ask whether to re-apply.
	 */
	private async reconcileRestoredState(job: CloudJob, session: SessionDoc, sbx: SandboxCore): Promise<void> {
		const digests = ((session as { digests?: ProvenDigest[] }).digests ?? []).filter((d) => d.endSha);
		if (!digests.length) return;
		const headR = await sbx.runIn(REPO_DIR, "git rev-parse HEAD", 15_000).catch(swallow("executor", "op"));
		const head = headR?.stdout.trim();
		if (!head) return;
		const ancestor = async (sha: string) => {
			const r = await sbx.runIn(REPO_DIR, `git merge-base --is-ancestor ${JSON.stringify(sha)} HEAD`, 20_000).catch(swallow("executor", "op"));
			return r?.exitCode === 0;
		};
		// Commits that landed outside the session (GitHub UI, another machine)
		// show as the branch being ahead of the newest known endSha.
		const newest = digests.reduce((a, b) => (a.at > b.at ? a : b));
		if (await ancestor(newest.endSha!)) {
			const ahead = await sbx.runIn(REPO_DIR, `git rev-list --count ${JSON.stringify(newest.endSha!)}..HEAD`, 20_000).catch(swallow("executor", "op"));
			const n = Number(ahead?.stdout.trim()) || 0;
			if (n > 0)
				await this.sink.emit({ type: "info", text: `${n} commit(s) landed on ${session.branch} outside this session since the last run.` });
		}
		const missing = [] as ProvenDigest[];
		for (const d of digests) if (!(await ancestor(d.endSha!))) missing.push(d);
		if (!missing.length) return;
		const list = missing.map((d) => `'${d.task.slice(0, 80)}'${d.filesChanged.length ? ` (files: ${d.filesChanged.slice(0, 6).join(", ")})` : ""}`).join("; ");
		await this.sink.emit({
			type: "info",
			text: `Restored at ${head.slice(0, 7)} — work from earlier run(s) is not in this tree: ${list}. Those changes are missing unless re-applied.`,
		});
		// Skip the approval card when the new task already covers every missing
		// ask — overlap by shared file paths or significant task words.
		const words = new Set(
			job.task.toLowerCase().split(/[^a-z0-9_/.-]+/i).filter((w) => w.length >= 4),
		);
		const covered = (d: ProvenDigest) =>
			d.filesChanged.some((f) => job.task.includes(f)) ||
			d.task.toLowerCase().split(/[^a-z0-9_/.-]+/i).filter((w) => w.length >= 4 && words.has(w)).length >= 3;
		const uncovered = missing.filter((d) => !covered(d));
		let reapply = false;
		if (uncovered.length) {
			reapply = await this.awaitPermission(job, "restore_missing", {
				missing: missing.map((d) => ({ task: d.task.slice(0, 160), files: d.filesChanged })),
				command: `Work from earlier run(s) is missing from this restore (${uncovered.map((d) => `'${d.task.slice(0, 60)}'`).join(", ")}). Re-apply those changes?`,
			});
		}
		// Hand the next agent the verdict: uncovered+allowed asks are required
		// work; the rest are informational so it doesn't assume they exist.
		const note =
			`Restore check: this worktree was restored at commit ${head.slice(0, 7)}. ` +
			`The following earlier asks' changes are NOT in the current tree: ${list}. ` +
			(reapply
				? "The user asked to re-apply them — treat them as required outstanding work."
				: "Do not assume they are implemented; re-read files before relying on them and mention the gap to the user if relevant.");
		(session as { stateNote?: string }).stateNote = note;
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
		const next = await this.raceStop(this.ensureSandbox(session, settings, { template: req.template }), SANDBOX_START_MS, "Sandbox start", session.sandboxId);
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
		await this.sink.emit({ type: "cloud-status", key: "sandbox", text: `Switched to "${req.template}" — resuming on the new VM` });
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
		await savePlanFile(job.uid, job.sessionId, slug, markdown, job.runId).catch(swallow("executor", "op"));
	}

	private async verify(sbx: SandboxCore): Promise<string> {
		// A dead VM must not emit fake "check failed" rows — throw so runTail
		// recreates the sandbox, reclones the branch, and retries.
		const alive = await sbx.runIn("/", "echo ok", 15_000).catch(() => undefined);
		if (!alive?.stdout.includes("ok")) throw new Error("Sandbox died before post-run verification");
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
			this.runChecks.push({ command: cmd, ok: true });
			await this.sink.emit({ type: "check", command: cmd, ok: true, durationMs: 0, output: skipped });
			results.push(`${cmd} → ${skipped}`);
		} else if (cmd) {
			await this.sink.emit({ type: "cloud-status", text: `Verifying: ${cmd}` });
			const r = await sbx.runIn(REPO_DIR, cmd, 300_000).catch(swallow("executor", "op"));
			// stderr first — the failure reason lives there; stdout is the
			// npm/pytest banner that made every failed check look empty.
			const combined = `${r?.stderr ?? ""}\n${r?.stdout ?? ""}`.trim();
			let ok = !!r && r.exitCode === 0;
			let output = combined.slice(0, 1000);
			// A repo with a test script but no test files (vitest exits 1)
			// reports a red check on every run — that's a skip, not a failure.
			if (!ok && /no test files|no tests? found|0 tests? (found|ran)/i.test(combined)) {
				ok = true;
				output = "skipped — no test files";
			}
			this.runChecks.push({ command: cmd, ok });
			await this.sink.emit({ type: "check", command: cmd, ok, durationMs: 0, output });
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
			const lines = (pkg?.stdout ?? "").split("\n");
			const line = lines.find((l) => l.includes("\"dev\"")) ?? lines.find((l) => l.includes("\"start\""));
			// Scripts that boot a non-HTTP app (extension host, desktop) never
			// bind a port — the poll would report a false failure every run.
			if (line && !/extensionDevelopmentPath|electron|tauri|vscode-test|extensionTests/i.test(line)) {
				start = line.includes("\"dev\"") ? "npm run dev" : "npm start";
			}
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
			this.runChecks.push({ command: `boot: ${start}`, ok: false });
			await this.sink.emit({ type: "check", command: `boot: ${start}`, ok: false, durationMs: 20_000, output: log.slice(0, 800) });
			return "boot → failed (no port)";
		}
		const resp = await sbx.runIn("/", `curl -s -o /dev/null -w "%{http_code}" -m 5 http://localhost:${port}`).catch(swallow("executor", "op"));
		const code = resp?.stdout.trim() ?? "000";
		const ok = code.startsWith("2") || code.startsWith("3");
		this.runChecks.push({ command: `boot: ${start}`, ok });
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
			// origin/<base> may be missing locally (aged/single-branch clone) —
			// fetch first so the ahead count is meaningful.
			await sbx.runIn(REPO_DIR, `git fetch origin ${JSON.stringify(session.base)}`, 60_000).catch(swallow("executor", "op"));
			const ahead = await sbx
				.runIn(REPO_DIR, `git rev-list --count origin/${session.base}..HEAD 2>/dev/null || git rev-list --count ${session.base}..HEAD`, 30_000)
				.catch(swallow("executor", "op"));
			const commits = Number(ahead?.stdout.trim());
			if (!ahead || ahead.exitCode !== 0 || Number.isNaN(commits)) {
				// An uncomputable count used to collapse to 0 and report "no
				// changes" even on a branch with commits — push instead.
				await this.sink.emit({ type: "info", text: "Couldn't compute commits ahead of base — attempting push/PR anyway." });
			} else if (commits === 0) {
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
			// Already streamed a live diff for this path via the fs tools.
			if (this.liveChangedPaths.has(`0:${rel}`)) continue;
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
			this.lastPushed = true;
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
			this.lastPushed = true;
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
		// Net-diff guard: commits may exist yet change nothing vs base (a run
		// that reverted earlier work). An empty diff must not open/update a PR.
		await sbx.runIn(REPO_DIR, `git fetch origin ${JSON.stringify(session.base)}`, 60_000).catch(swallow("executor", "op"));
		const netDiff = await sbx
			.runIn(REPO_DIR, `git diff --quiet origin/${session.base}...HEAD`, 30_000)
			.catch(swallow("executor", "op"));
		if (netDiff?.exitCode === 0) {
			await this.sink.emit({ type: "info", text: `Branch has no net changes vs ${session.base} — skipping PR.` });
			return;
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
		this.lastPrUrl = pr.url;
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
		let sbx = await this.raceStop(this.ensureSandbox(session, settings), SANDBOX_START_MS, "Sandbox start", session.sandboxId);
		this.startSandboxKeepalive(sbx);
		const token = await this.githubToken(session, settings);
		this.sink.mask(token);
		// A fresh/recreated sandbox has no repo — clone and land on the session
		// branch first, or pushAndPr sees an empty tree and skips the PR.
		await this.ensureRepoReady(session, sbx, token);
		await this.runTail(job, session, settings, () => sbx, (next) => {
			sbx = next;
			this.activeSbx = next;
		}, token);
		dbg("run", "openPrJob done", { runId: job.runId });
	}

	/** Commit a saved plan markdown onto the session branch (creates the branch if needed). */
	private async pushPlan(job: CloudJob, session: SessionDoc, settings: UserSettings): Promise<void> {
		if (!job.planSlug) throw new Error("No plan on this job.");
		const plan = await loadPlan(this.db, job.uid, job.sessionId, job.planSlug);
		if (!plan) throw new Error("Plan not found.");
		let sbx = await this.raceStop(this.ensureSandbox(session, settings), SANDBOX_START_MS, "Sandbox start", session.sandboxId);
		this.startSandboxKeepalive(sbx);
		const token = await this.githubToken(session, settings);
		this.sink.mask(token);
		for (let attempt = 0; ; attempt++) {
			try {
				await this.ensureRepoReady(session, sbx, token);
				await this.ensureBranch(job, session, sbx, token, resolveProvider(settings, job).settings ?? undefined);
				await sbx.writeFile(`${REPO_DIR}/.kronyx/plans/${job.planSlug}.md`, String(plan.markdown));
				await sbx.runIn(REPO_DIR, "mkdir -p .kronyx/plans").catch(swallow("executor", "op"));
				await sbx.commitAndPush(REPO_DIR, session.branch!, `kronyx: plan ${job.planSlug}`, COMMIT_EXCLUDES);
				this.lastPushed = true;
				await this.sink.emit({ type: "info", text: `Pushed .kronyx/plans/${job.planSlug}.md to ${session.branch}` });
				return;
			} catch (err) {
				if (attempt > 0 || !isSandboxDeath(err) || this.stopRequested) throw err;
				await this.sink.emit({ type: "info", text: "Sandbox died — recreating and retrying the plan push." });
				session.sandboxId = undefined;
				session.cloned = false;
				await this.sink.patchSession({ sandboxId: null, cloned: false });
				sbx = await this.raceStop(this.ensureSandbox(session, settings), SANDBOX_START_MS, "Sandbox start", session.sandboxId);
				this.startSandboxKeepalive(sbx);
			}
		}
	}
}
