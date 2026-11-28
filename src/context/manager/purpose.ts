import type { CallPurpose } from "../contracts/context";
import type { ExecutionState } from "../contracts/execution";

export interface PurposeSignals {
	explicitPurpose?: CallPurpose;
	phase?: string;
	recentToolNames?: readonly string[];
	lastValidationFailed?: boolean;
	finalizing?: boolean;
	state?: ExecutionState;
}

export function inferCallPurpose(signals: PurposeSignals): CallPurpose {
	if (signals.explicitPurpose) return signals.explicitPurpose;
	if (signals.finalizing || signals.phase === "final") return "final-response";
	const tools = new Set(signals.recentToolNames ?? []);
	const has = (re: RegExp) => [...tools].some((t) => re.test(t));
	if (signals.lastValidationFailed || has(/test|spec/) || has(/run_command/)) return "debugging";
	if (has(/write_file|edit_file|append_file|insert_lines|file_editor|apply_patch/)) return "implementation";
	if (has(/search|list|read|grep|find|symbol|explore/)) return "exploration";
	if (signals.phase?.includes("verify") || signals.phase?.includes("review")) return "verification";
	if (signals.state?.plan.tasks.length && signals.state.plan.inProgress.length === 0 && signals.state.plan.pending.length > 0) return "planning";
	return signals.phase?.includes("plan") ? "planning" : "general";
}
