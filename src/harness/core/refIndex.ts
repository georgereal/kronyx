/**
 * The canonical id→entity map. Every reference resolution in the harness —
 * UI chips, kernel validation, steering — goes through this index instead of
 * shape-guessing regexes. The index owns whatever ids exist (hierarchical,
 * lettered, anything), so id-shape changes are a non-event.
 *
 * Derived purely from the ledger projection — replay-safe, no new events.
 */
import type { Ledger } from "./taskLedger";

export interface RefEntry {
	kind: "task" | "step";
	taskId: string;
	/** Steps only — the step's own id within its task. */
	stepId?: string;
	/** Task title or step text. */
	title: string;
	status: string;
	/** Owning run — ids repeat across sessions (every board restarts at t1). */
	runId?: string;
	/** Owning plan version when the task was seeded from one. */
	planId?: string;
}

export interface RefIndex {
	/** Exact id → entry. Steps index under their own id; collisions across
	 * tasks keep the first-seen entry (text resolution is inherently ambiguous
	 * there — same as it always was). */
	entries: Map<string, RefEntry>;
	/** Ids owned by the current run — resolution prefers these. */
	currentRunIds: Set<string>;
	/** Lowercase id → exact key, so case-variant prose references resolve. */
	lower: Map<string, string>;
}

export function buildRefIndex(ledger: Ledger, currentRunId?: string): RefIndex {
	const entries = new Map<string, RefEntry>();
	const currentRunIds = new Set<string>();
	const lower = new Map<string, string>();
	for (const id of ledger.order) {
		const task = ledger.tasks[id];
		if (!task) continue;
		if (!entries.has(task.id)) {
			lower.set(task.id.toLowerCase(), task.id);
			entries.set(task.id, {
				kind: "task",
				taskId: task.id,
				title: task.title,
				status: task.status,
				...(task.runId === undefined ? {} : { runId: task.runId }),
				...(task.planId === undefined ? {} : { planId: task.planId }),
			});
		}
		if (currentRunId !== undefined && task.runId === currentRunId) currentRunIds.add(task.id);
		for (const step of task.steps) {
			if (!entries.has(step.id)) {
				lower.set(step.id.toLowerCase(), step.id);
				entries.set(step.id, {
					kind: "step",
					taskId: task.id,
					stepId: step.id,
					title: step.text,
					status: step.status,
					...(task.runId === undefined ? {} : { runId: task.runId }),
					...(task.planId === undefined ? {} : { planId: task.planId }),
				});
			}
			if (currentRunId !== undefined && task.runId === currentRunId) currentRunIds.add(step.id);
		}
	}
	return { entries, currentRunIds, lower };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Builds one regex from the index's own keys — sorted longest-first so
 * hierarchical ids (t6-s2) match whole before their prefixes (t6), with
 * guards so a key never matches inside a longer id-ish token (t1 ⊄ t11,
 * and t6 doesn't pre-empt t6-s2). Because the keys themselves form the
 * alternation, no id shape is known anywhere — any shape the ledger carries
 * resolves exactly.
 *
 * Returns null for an empty board.
 */
export function buildRefMatcher(index: RefIndex): RegExp | null {
	if (index.entries.size === 0) return null;
	const keys = [...index.entries.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
	const alt = keys.map(escapeRe).join("|");
	return new RegExp(`(?<![A-Za-z0-9-])(${alt})(?![A-Za-z0-9-])`, "g");
}

/**
 * Id-shaped tokens in text that are NOT in the index — the hallucination
 * surface. Shape-regex is used only here, to detect violations, never to
 * resolve. Braced refs ({t9}) count too — the braces mean the model meant a
 * board reference. Fenced code blocks are stripped first: shapes in code are
 * noise, not references.
 */
export function scanUnknownRefTokens(text: string, index: RefIndex): string[] {
	if (index.entries.size === 0) return [];
	const stripped = text.replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
	const unknown = new Set<string>();
	const re = /(?:\{([^{}\s]{1,40})\}|\b([ts]\d[\da-z-]*)\b)/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(stripped)) !== null) {
		const token = (m[1] ?? m[2]).toLowerCase();
		// Braced tokens only count when id-shaped — {author}, {timeout} are prose.
		if (m[1] !== undefined && !/^[ts]\d/i.test(token)) continue;
		if (!index.lower.has(token)) unknown.add(token);
	}
	return [...unknown].sort();
}
