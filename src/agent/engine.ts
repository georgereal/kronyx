/**
 * Execution-engine seam: the session controller drives any engine through this
 * surface. `AgentRunner` (Cline SDK) and `OpenAIEngine` (OpenAI-compatible
 * endpoints) both implement it and emit the same RunViewEvent stream.
 * vscode-free.
 */

import type { AgentMode, ProviderSettings, RunDigest, RunnerAttachment } from "./runner";

export type EngineKind = "cline" | "openai" | "harness";

export interface AgentEngine {
	readonly isRunning: boolean;
	readonly isPaused: boolean;
	readonly runDigests: readonly RunDigest[];
	run(task: string, settings: ProviderSettings, attachments?: RunnerAttachment[], displayTask?: string): Promise<void>;
	resume(settings?: ProviderSettings): Promise<void>;
	stop(): void;
	reset(): void;
	requestCompact(): boolean;
	clearContext(): boolean;
	addRunDigest(digest: RunDigest): void;
	setRunDigests(digests: RunDigest[]): void;
	setStateNote(note: string | undefined): void;
}

export type { AgentMode };
