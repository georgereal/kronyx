import type { CapabilityManifest, ExecutionState } from "../contracts/execution";
import { zeroComponentVersions } from "../contracts/execution";

export function initialExecutionState(sessionId: string, runId?: string): ExecutionState {
	return {
		schemaVersion: 1,
		sessionId,
		...(runId ? { runId } : {}),
		eventCursor: 0,
		stateVersion: 0,
		objective: "",
		constraints: [],
		status: "running",
		plan: { version: 0, tasks: [], completed: [], inProgress: [], pending: [], blocked: [] },
		decisions: [],
		changes: { filesModified: [], version: 0 },
		validation: { version: 0, checks: [] },
		openIssues: [],
		activeToolCalls: [],
		capabilities: { workspaceType: "unknown", buildCommands: [], testCommands: [], languageServers: [], tools: [] },
		compaction: { compactionVersion: 0, activeSummaries: [] },
		componentVersions: zeroComponentVersions(),
		updatedAt: new Date(0).toISOString(),
	};
}

export function emptyCapabilities(overrides: Partial<CapabilityManifest> = {}): CapabilityManifest {
	return { workspaceType: "unknown", buildCommands: [], testCommands: [], languageServers: [], tools: [], ...overrides };
}

/** Validate the fields callers rely on. This is intentionally structural, not a full JSON-schema runtime. */
export function assertExecutionState(value: ExecutionState): ExecutionState {
	if (value.schemaVersion !== 1) throw new Error(`unsupported execution state schema ${value.schemaVersion}`);
	if (!value.sessionId) throw new Error("execution state missing sessionId");
	if (value.eventCursor < 0) throw new Error("execution state cursor must be non-negative");
	if (!value.plan || !Array.isArray(value.plan.tasks)) throw new Error("execution state missing plan");
	if (!value.componentVersions) throw new Error("execution state missing component versions");
	return value;
}

export function snapshotCursorValid(state: ExecutionState, cursor: number): boolean {
	return state.eventCursor === cursor;
}
