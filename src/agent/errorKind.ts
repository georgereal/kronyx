/**
 * Coarse failure classification for run-failed events. Drives the UI's
 * friendly failure card and the Retry affordance — `retryable` means a
 * continue job on the same transcript has a reasonable shot (the resume
 * path sanitizes dangling tool calls before reseeding).
 */
export type RunErrorKind =
	| "missing_tool_results"
	| "sandbox_death"
	| "rate_limit"
	| "context_overflow"
	| "auth"
	| "no_such_tool"
	| "stopped"
	| "unknown";

export function classifyRunError(message: string): { errorKind: RunErrorKind; retryable: boolean } {
	const m = message.toLowerCase();
	if (/tool results? (are|is) missing for tool calls?/.test(m)) return { errorKind: "missing_tool_results", retryable: true };
	if (/tried to call unavailable tool|no such tool/.test(m)) return { errorKind: "no_such_tool", retryable: false };
	if (/sandbox|e2b|\bvm\b/.test(m) && /(died|dead|lost|stopped responding|unresponsive)/.test(m))
		return { errorKind: "sandbox_death", retryable: true };
	if (/rate.?limit|\b429\b|too many requests|quota|throttl/.test(m)) return { errorKind: "rate_limit", retryable: true };
	if (/context (length|window|overflow)|maximum context|too many tokens|prompt is too long|exceeds.*(token|context)/.test(m))
		return { errorKind: "context_overflow", retryable: true };
	if (/unauthorized|\b401\b|\b403\b|invalid api key|authentication|permission denied/.test(m))
		return { errorKind: "auth", retryable: false };
	if (/stopped by user|aborted/.test(m)) return { errorKind: "stopped", retryable: false };
	return { errorKind: "unknown", retryable: false };
}
