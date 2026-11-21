/**
 * Task/fact guards — vscode-free, shared by the extension and the cloud worker.
 *
 * Trivial tasks ("hi", "thanks") carry no actionable request: they must not
 * trigger cross-session memory recall (noise scores pass the vector floor and
 * get injected as "Remembered" facts the agent then treats as a to-do list)
 * nor the zero-tool "proceed" nudge. Run-summary text must never enter durable
 * memory — on the next run it reads as pending work.
 */

// Greetings/acks only — no actionable content. Anchored: "hi, can you fix X"
// does not match.
const CONVERSATIONAL_RE =
	/^(hi+|hello+|hey+|yo+|sup|hiya|howdy|greetings|gm|gn|good\s+(morning|afternoon|evening|day)|morning|evening|thanks|thank\s+you|thx|ty|ok+|okay|k|yes+|yeah+|yep+|yup+|no+|nope|sure|lol|lmao|haha+|hehe|cool|nice|great|awesome|perfect|got\s+it|understood|sounds\s+good)[\s!.?,]*$/i;

/** True for greetings/acks — the agent's own reply should stand, no nudge. */
export function isConversationalTask(task: string): boolean {
	return CONVERSATIONAL_RE.test(task.trim());
}

const MAX_TRIVIAL_WORDS = 2;
const MAX_TRIVIAL_CHARS = 24;

/**
 * Substantively empty: a greeting/ack, or a fragment too short to recall
 * memories against. Used only to skip memory recall — short imperatives like
 * "fix it" still get the zero-tool nudge (they are not conversational).
 */
export function isTrivialTask(task: string): boolean {
	const t = task.trim();
	if (!t) return true;
	if (isConversationalTask(t)) return true;
	return t.split(/\s+/).length <= MAX_TRIVIAL_WORDS && t.length <= MAX_TRIVIAL_CHARS;
}

// Run-summary / task-status framings that must not become durable facts.
// Anchored and conservative — status notes that carry durable gotchas
// ("All 21 tests pass… PyQt5 UI cannot run headless due to libGL.so.1")
// intentionally do NOT match.
const SUMMARY_RES = [
	/^(?:final\s+)?summary\b/i,
	/^plan\s+items\s+to\s+address\b/i,
	/^starting\s+implementation\b/i,
	/^implementation\s+(?:is\s+)?complete\b/i,
	/^task\s+(?:is\s+)?complete\b/i,
	/^all\s+done\b/i,
	/^completed\b/i,
];

/** True when a memory_write fact is a run summary/status, not durable knowledge. */
export function isRunSummaryFact(fact: string): boolean {
	// Strip leading markdown bullets/headers so "**Completed:**" and "- Summary:" match.
	const t = fact.trim().replace(/^[\s>*#\-•]+/, "");
	return SUMMARY_RES.some((re) => re.test(t));
}
