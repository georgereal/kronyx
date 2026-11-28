/**
 * Plan-file → board seed (vscode-free). "Implement this plan" should not ask
 * the model to re-derive a task list: the plan document already declares the
 * work, so the harness parses it and seeds the task board directly — the board
 * IS the document. The model then works a bounded scope instead of inventing
 * one. Deterministic planning, not deterministic coding: the seed fixes the
 * scope; the model still decides implementation within it.
 *
 * Extraction is convention-based and deliberately conservative:
 * - Phased plans (`## Phase N — Title` headings) become one task per phase.
 * - Steps come from numbered lists, checkboxes, or markdown table rows whose
 *   first cell is a step number (`| 0.1 | what | files |`).
 * - Meta sections (backlog, out-of-scope, non-goals, future, risks, notes)
 *   never contribute steps — the plan's own exclusions are the scope boundary.
 * - A verification command in a phase becomes that task's acceptance gate; a
 *   doc-level verification section gates the final task. A failed gate sends
 *   the model back with the failure, never a quiet pass.
 */

import type { SeedTask } from "../core/loop";

export interface PlanSeedTask {
	title: string;
	steps: string[];
	/** Command for the task's command acceptance, when the plan names one. */
	verify?: string;
}

export interface PlanSeed {
	title: string;
	tasks: PlanSeedTask[];
}

const STEP_HEAD = /steps|actions|implementation|work items|tasks|sequenc|deliverable|approach/i;
const SKIP_HEAD = /non-goal|out of scope|out-of-scope|backlog|future|blocked|missing|evidence|summary|context|background|risk|note|reference|enhancement/i;
const VERIFY_HEAD = /verif|check|test|gate|acceptance|done criteria|validation/i;
const PHASE_HEAD = /^phase\b|^stage\b|^part\b|^milestone\b/i;
const NUMBERED = /^\s*\d+[.)]\s+(.+?)\s*$/;
const CHECKBOX = /^\s*[-*]\s+\[[ x]\]\s+(.+?)\s*$/i;
const COMMAND = /^(npm|pnpm|yarn|npx|bun|deno|pytest|python\s+-m|cargo|go test|go build|make|vitest|jest|tsc|dotnet|mvn|gradle|composer|bundle|rake)\b/;

const MAX_STEPS_PER_TASK = 15;
const MAX_STEP_CHARS = 240;
const MAX_COMMAND_CHARS = 200;

const clean = (s: string): string =>
	s
		.replace(/\*\*(.+?)\*\*/g, "$1")
		.replace(/__(.+?)__/g, "$1")
		.replace(/~~(.+?)~~/g, "$1")
		.trim();

interface Section {
	heading: string;
	lines: string[];
}

function splitSections(markdown: string): { preamble: string[]; sections: Section[] } {
	const preamble: string[] = [];
	const out: Section[] = [];
	let cur: Section | undefined;
	let inFence = false;
	for (const line of markdown.split("\n")) {
		if (/^\s*```/.test(line)) inFence = !inFence;
		const h = !inFence ? /^#{1,4}\s+(.+?)\s*$/.exec(line) : null;
		if (h) {
			cur = { heading: h[1]!, lines: [] };
			out.push(cur);
		} else {
			(cur?.lines ?? preamble).push(inFence ? "" : line);
		}
	}
	return { preamble, sections: out };
}

const numberedIn = (lines: string[]): string[] =>
	lines.flatMap((l) => {
		const m = NUMBERED.exec(l) ?? CHECKBOX.exec(l);
		return m ? [m[1]!] : [];
	});

/**
 * Table-row steps: `| 0.1 | what to do | files |` — the first cell is a step
 * number (dotted or plain), the widest remaining text cell is the step.
 * Header and separator rows never match (their first cell isn't numeric).
 */
const tableStepsIn = (lines: string[]): string[] =>
	lines.flatMap((l) => {
		if (!/^\s*\|/.test(l)) return [];
		const cells = l.split("|").slice(1, -1).map((c) => c.trim());
		if (cells.length < 2) return [];
		if (!/^\d+(\.\d+)*\.?$/.test(cells[0]!)) return [];
		// The step text is the longest remaining cell — the "what" column in
		// step|what|files layouts, robust to missing trailing columns.
		const rest = cells.slice(1).filter((c) => c && !/^-+$/.test(c));
		const text = rest.sort((a, b) => b.length - a.length)[0];
		return text ? [text] : [];
	});

const stepsIn = (lines: string[]): string[] => {
	const numbered = numberedIn(lines);
	if (numbered.length) return numbered;
	return tableStepsIn(lines);
};

const isCommand = (s: string): boolean => COMMAND.test(s.trim()) && s.trim().length <= MAX_COMMAND_CHARS && !/[|&;<>]/.test(s);

function findCommand(lines: string[]): string | undefined {
	for (const l of lines) {
		for (const span of l.matchAll(/`([^`\n]+)`/g)) {
			if (isCommand(span[1]!)) return span[1]!.trim();
		}
		// Table rows and list items both carry bare commands in verify steps.
		for (const cell of l.split("|").map((c) => c.trim())) {
			const bare = cell.replace(/^[-*]\s+/, "").replace(/^`|\s*—.*$|`$/g, "").trim();
			if (isCommand(bare)) return bare;
		}
	}
	return undefined;
}

const normalizeSteps = (steps: string[]): string[] =>
	[...new Set(steps.map(clean).filter((s) => s.length >= 8))].slice(0, MAX_STEPS_PER_TASK).map((s) => s.slice(0, MAX_STEP_CHARS));

/** Drop the leading "Phase N —" / numeric prefix so task titles read as the work, not the numbering. */
const phaseTitle = (heading: string): string =>
	clean(heading.replace(/^phase\s+[\d.]+\s*[-–—:]\s*/i, "").replace(/^phase\s+[\d.]+\s+/i, "").replace(/\(.*?\)\s*$/, "").trim() || heading);

export function parsePlanSeed(markdown: string, fallbackTitle = "Implement plan"): PlanSeed | undefined {
	const { preamble, sections } = splitSections(markdown);
	const h1 = /^#\s+(.+?)\s*$/m.exec(markdown)?.[1];
	const title = h1 ? clean(h1.replace(/^(plan|task)[:\s-]+/i, "")) : fallbackTitle;
	const docVerify = (() => {
		for (const s of sections) {
			if (VERIFY_HEAD.test(s.heading)) {
				const cmd = findCommand(s.lines);
				if (cmd) return cmd;
			}
		}
		return undefined;
	})();

	// Phased plans: headings like "Phase 0 — Project Hygiene" each become a task.
	// A phase section contributes even when its heading also matches STEP_HEAD —
	// the phase boundary is what structures the board.
	// No VERIFY_HEAD exclusion here: a phase legitimately named "Input Validation"
	// or "Unit Tests" is work, not a verification section — doc-level verify
	// sections never start with "Phase", so PHASE_HEAD alone discriminates.
	const phaseSections = sections.filter((s) => PHASE_HEAD.test(s.heading) && !SKIP_HEAD.test(s.heading));
	if (phaseSections.length) {
		const tasks: PlanSeedTask[] = [];
		for (const s of phaseSections) {
			const steps = normalizeSteps(stepsIn(s.lines));
			if (!steps.length) continue;
			tasks.push({
				title: phaseTitle(s.heading),
				steps,
				...(findCommand(s.lines) ? { verify: findCommand(s.lines) } : {}),
			});
		}
		if (tasks.length) {
			// The doc-level verification gates the final phase — it is the
			// cross-phase checklist ("all phases pass mvn clean compile").
			if (docVerify && !tasks.at(-1)!.verify) tasks.at(-1)!.verify = docVerify;
			return { title, tasks };
		}
	}

	// Flat plans: steps/actions-ish sections win; otherwise every numbered or
	// table step outside meta sections, one task for the whole document.
	let steps: string[] = [];
	for (const s of sections) {
		if (STEP_HEAD.test(s.heading) && !SKIP_HEAD.test(s.heading) && !VERIFY_HEAD.test(s.heading)) steps.push(...stepsIn(s.lines));
	}
	if (steps.length === 0) {
		steps = [
			...numberedIn(preamble),
			...sections.flatMap((s) => (SKIP_HEAD.test(s.heading) || VERIFY_HEAD.test(s.heading) ? [] : stepsIn(s.lines))),
		];
	}
	const flat = normalizeSteps(steps);
	if (!flat.length) return undefined;
	const verify = docVerify ?? findCommand([...preamble, ...sections.flatMap((s) => s.lines)]);
	return { title, tasks: [{ title, steps: flat, ...(verify ? { verify } : {}) }] };
}

/** The board for an implement run on a plan file: one task per phase (or one
 *  task for flat plans), steps exactly as written, verify commands as gates.
 *  A plan with no steps is an error to fix, never a planner fallback — the
 *  run's scope is the plan. */
export function planSeedTasks(rel: string, markdown: string): { seed: SeedTask[] } | { error: string } {
	const parsed = parsePlanSeed(markdown, `Implement ${rel.split(/[\\/]/).pop()}`);
	if (!parsed) {
		return {
			error:
				`${rel} has no implementable steps. The plan parser reads numbered steps (1. …), checkboxes (- [ ] …), ` +
				`or markdown table rows (| 0.1 | step | files |), optionally grouped under "## Phase N — …" headings. ` +
				`Add steps in one of those forms and run again.`,
		};
	}
	const multi = parsed.tasks.length > 1;
	return {
		seed: parsed.tasks.map((t) => ({
			title: multi ? t.title : `Implement plan: ${t.title}`,
			steps: t.steps,
			acceptance: t.verify ? { kind: "command" as const, command: t.verify } : { kind: "none" as const },
		})),
	};
}

/**
 * Implementation intent toward a plan document (vscode-free, unit-tested).
 * The gate for deterministic seeding: the task must direct work AT the document
 * — implementation verbs (implement/build/follow/execute) or constructions
 * (as per / according to). Reference use ("check compliance with x.md",
 * "summarize x.md") never qualifies, even when x.md would parse — a false
 * negative only costs the planner path with the doc still in context; a false
 * positive would hijack scope. Returns the referenced .md path when intent holds.
 */
export function implementationIntent(task: string): string | undefined {
	if (!/\bimplement\b|\bbuild\b|\bfollow\b|\bexecute\b|as per|according to/i.test(task)) return undefined;
	// @-prefixed or bare workspace-relative/absolute .md paths.
	const m = /@?([\w./\-[\]{}()]+\.md)\b/i.exec(task);
	return m?.[1];
}

/**
 * Infer a harness step signal from seed step text (vscode-free). Verify-style
 * steps in plan documents almost always name the exact command — "Run \`mvn clean
 * compile\` end-to-end" — so the step auto-closes when that command runs ok. The
 * signal flows model→harness: work the model does advances the board without a
 * manual task_step_update. Steps with no command stay manual (the model closes
 * them, or the acceptance gate covers them).
 */
/** Extensions whose files are edit targets (not data/resource literals). */
const SOURCE_EXT = /\.(java|ts|tsx|js|jsx|py|go|rs|c|cc|cpp|h|hpp|cs|rb|php|kt|swift|xml|json|ya?ml|toml|md)$/i;

/**
 * Infer a harness step signal from seed step text (vscode-free). Verify-style
 * steps in plan documents almost always name the exact command — "Run \`mvn clean
 * compile\` end-to-end" — so the step auto-closes when that command runs ok.
 * Implementation steps almost always name their file — "Create \`Config.java\`",
 * "Replace the literal in \`ExcelReader.java\`" — so a write/edit to that file
 * is the evidence. The signal flows model→harness: work the model does advances
 * the board without a manual task_step_update. Steps naming neither stay manual.
 */
export function inferStepSignal(text: string): { tool: string; path?: string } | undefined {
	for (const span of text.matchAll(/`([^`\n]+)`/g)) {
		const cmd = span[1]!.trim();
		if (COMMAND.test(cmd) && cmd.length <= MAX_COMMAND_CHARS && !/[|&;<>]/.test(cmd)) {
			return { tool: "run_command", path: cmd };
		}
	}
	// File inference: collect file-looking mentions (backticked or bare), prefer
	// source files over data/resource literals — in "replace the literal X in
	// Foo.java" the xlsx is data but the .java is the edit target.
	const mentions: string[] = [];
	for (const span of text.matchAll(/`([^`\n]+)`/g)) {
		const tok = span[1]!.trim();
		if (/^[\w./-]+\.[A-Za-z0-9]+$/.test(tok) && !/\s/.test(tok)) mentions.push(tok);
	}
	if (!mentions.length) {
		for (const span of text.matchAll(/(?<![\w/.-])([\w-]+\.(?:java|ts|tsx|js|jsx|py|go|rs|xml|json|ya?ml|toml))(?![\w-])/g)) {
			mentions.push(span[1]!);
		}
	}
	if (!mentions.length) return undefined;
	const pick = mentions.find((m) => SOURCE_EXT.test(m) && !/\.(xlsx?|csv|pdf|png|jpe?g|gif|zip|jar)$/i.test(m)) ?? undefined;
	if (!pick) return undefined;
	// The path as written (basename is fine — ownsMatch handles loose matching).
	const path = pick.replace(/^\.`?/, "").replace(/[.,;:)`'"]+$/, "");
	// Create-ish verbs mean the file doesn't exist yet (write_file); everything
	// else is a modification. Matching is lenient across write-ish tools, so the
	// distinction barely matters — both are the same evidence.
	const createish = /\b(create|add|write|generate|scaffold|introduce)\b/i.test(text);
	return { tool: createish ? "write_file" : "edit_file", path };
}
