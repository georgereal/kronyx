/**
 * Execution-engine seam: hosts drive an engine through this surface and consume
 * the shared RunViewEvent stream. Production implementations are harness-backed;
 * the legacy runners remaining in the tree are test-only. vscode-free.
 */

import type { AgentMode, ProviderSettings, RunDigest, RunnerAttachment } from "./types";

export type EngineKind = "cline" | "openai" | "conversations" | "responses" | "chat" | "auto" | "harness";

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
