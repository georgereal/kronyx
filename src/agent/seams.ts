/**
 * Typed seam keys — the named slots providers register into.
 * vscode-free — shared by the extension and the cloud worker.
 *
 * Each key maps RunnerHost's former callback-bag field onto a capability seam:
 * the extension supplies local providers (vscode confirm UI, workspace fs),
 * the worker supplies cloud providers (E2B remote tools, auto-allow, mongo
 * transcripts). Same runner, different composition.
 */

import type { AgentMessage, AgentTool } from "@cline/shared";
import type { PermissionDecision } from "./permissions";
import type { PriorTranscript, RecallScorer } from "./recall";
import type { ProviderSettings } from "./runner";

export const SEAM_TOOLS = "tools";
export const SEAM_APPROVALS = "approvals";
export const SEAM_MEMORY = "memory";
export const SEAM_RECALL = "recall";
export const SEAM_TRANSCRIPTS = "transcripts";
export const SEAM_FILES = "files";
export const SEAM_SUBAGENTS = "subagents";

export interface ToolsProvider {
	(): Promise<AgentTool<any, string>[]>;
}

export interface ApprovalsProvider {
	/** Prompt-free policy check (rule-file evaluation). Runs before mode defaults. */
	check?(toolName: string, input: unknown): Promise<PermissionDecision>;
	/** Interactive confirmation for writes that reached the ask stage. */
	confirm(toolName: string, input: unknown): Promise<boolean>;
}

export interface MemoryProvider {
	/** Extra system-prompt context (memory recall) for the run's first turn. */
	context?(task: string, settings: ProviderSettings): Promise<string>;
	/** Persist a durable fact for memory_write. */
	onFact?(fact: string): Promise<void>;
}

export interface RecallProvider {
	/** Persisted transcripts of earlier runs for recall_context. */
	transcripts?(): readonly PriorTranscript[];
	/** Semantic ranker; keyword search is the fallback. */
	scorer?: RecallScorer;
	/** Set false to omit the recall_context tool entirely. */
	enabled?: boolean;
}

export interface TranscriptsProvider {
	/** Called after each run with the canonical transcript. */
	save(messages: readonly AgentMessage[]): void;
}

export interface EventsProvider {
	/** Durable record sink — receives KronyxEvent records (see agent/events.ts). */
	record(event: import("./events").KronyxEvent): void;
}

export interface ResumeProvider {
	/** Seed messages recovered from a prior run's durable log (worker restart,
	 *  re-claimed job). Empty/undefined = fresh start. */
	resumeLog?(): Promise<AgentMessage[] | undefined>;
}

export interface FilesProvider {
	/** Snapshot file contents before the agent writes (diff/undo support). */
	onBeforeWrite?(absPath: string, before: string | null): void;
	/** Host-side command execution (e.g. git ops for file tools). */
	execCommand?(command: string): Promise<string | null>;
	/** Repo skills: `.kronyx/skills/<name>/SKILL.md` files (see agent/skills.ts). */
	listSkillFiles?(): Promise<{ path: string; content: string }[]>;
}
