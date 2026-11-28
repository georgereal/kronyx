/**
 * Shared agent-facing types (vscode-free). These types describe the run-view
 * stream and host composition seams used by the harness production path. The
 * legacy AgentRunner remains test-only and re-exports this module.
 */

import type { FileChangeKind } from "../tools/fileTools";
import type { RunErrorKind } from "./errorKind";
import type { ApprovalsProvider, EventsProvider, FilesProvider, MemoryProvider, RecallProvider, ResumeProvider, ToolsProvider, TranscriptsProvider } from "./seams";

export interface ProviderSettings {
	providerId: string;
	baseUrl: string;
	modelId: string;
	apiKey: string;
	maxIterations: number;
	profile?: string;
	/** Provider-profile wire-shape override; absent/auto resolves through the API-shape matrix. */
	apiShape?: "cline" | "responses" | "conversations" | "chat" | "auto";
	contextWindow?: number;
	maxTokens?: number;
	/** In-flight tool ceiling for parallel batches (default 6). */
	maxParallelTools?: number;
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
	| { type: "tool-started"; id: string; name: string; input: unknown; iteration?: number }
	| { type: "tool-finished"; id: string; name?: string; ok: boolean; output: string; durationMs: number; iteration?: number }
	| { type: "file-changed"; path: string; kind: FileChangeKind; added?: number; removed?: number; diff?: string }
	| { type: "assistant-delta"; text: string }
	| { type: "reasoning-delta"; text: string }
	| { type: "tool-output-delta"; text: string }
	| { type: "info"; text: string; key?: string; meta?: Record<string, unknown> }
	| { type: "check"; command: string; ok: boolean; durationMs: number; output: string }
	| { type: "plan-ready"; path: string }
	| { type: "task-board"; tasks: Array<{ id: string; title: string; status: string; steps: Array<{ id: string; text: string; status: string }> }> }
	// Lightweight ledger names (always emitted, debug-independent) so the view can
	// resolve t1/s3 refs in narration to task titles without the full board.
	| { type: "task-named"; id: string; title?: string; steps?: { id: string; text: string }[] }
	| { type: "task-progress"; objective: string; completed: string[]; inProgress: string[]; next: string[]; blockers: string[] }
	| { type: "permission-request"; id: string; tool: string; path: string; command?: string; input?: unknown; diff?: string; callId?: string }
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
	| { type: "run-failed"; error: string; errorKind?: RunErrorKind; retryable?: boolean }
	/** The step cap was reached; the agent is kept so the user can continue or stop. */
	| { type: "run-paused"; iterations: number; limit: number; text: string }
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
	/** Local IDE host: enables the IDE tool policy (parallel reads in ask/plan, concurrency gate, update_progress). Off for the cloud worker. */
	ideTools?: boolean;
	/** Diagnostic sink; optional outside the extension. */
	log?: (tag: string, message: string) => void;
	/** Tool provider seam: the agent's full tool set. Default: local file + fetch tools. */
	tools?: ToolsProvider;
	/** web_search provider config for the default fetch tools (host supplies
	 *  userConfig locally, user settings on the worker). */
	webSearch?: import("../tools/fetchTools").WebSearchConfig;
	/** Known secret values, scrubbed from every tool result before the model sees it. */
	secretValues?: () => Iterable<string>;
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

/** Modes where a run that ends with zero tool calls gets one "proceed" nudge. */
export const WRITE_MODES: ReadonlySet<AgentMode> = new Set(["code", "smart", "bypass"]);
