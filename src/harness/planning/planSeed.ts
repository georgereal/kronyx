/**
 * Plan-file → board seed (vscode-free). "Implement this plan" should not ask
 * the model to re-derive a task list: the plan document already declares the
 * steps, so the harness parses it and seeds the task board directly. The model
 * then works a bounded scope — the plan's steps — instead of an open-ended
 * continuation of prior context.
 *
 * Extraction is convention-based and deliberately conservative: numbered
 * items under a steps/actions-ish heading win; without one, every numbered
 * line outside code fences and meta sections (non-goals, blocked, evidence)
 * is a step. A verification command under a verify/check-ish heading (or the
 * first plausible test/check code span in the doc) becomes the task's
 * acceptance check — the harness runs it before the task can be marked done,
 * so a failed gate sends the model back with the failure, never a quiet pass.
 */

import type { SeedTask } from "../core/loop";

export interface PlanSeed {
	title: string;
	steps: string[];
	/** Command for the task's command acceptance, when the plan names one. */
	verify?: string;
}

const STEP_HEAD = /steps|actions|implementation|work items|tasks|sequenc|deliverable|approach/i;
const SKIP_HEAD = /non-goal|blocked|missing|evidence|summary|context|background|risk|note|reference/i;
const VERIFY_HEAD = /verif|check|test|gate|acceptance|done criteria|validation/i;
const NUMBERED = /^\s*\d+[.)]\s+(.+?)\s*$/;
const CHECKBOX = /^\s*[-*]\s+\[[ x]\]\s+(.+?)\s*$/i;
const COMMAND = /^(npm|pnpm|yarn|npx|bun|deno|pytest|python\s+-m|cargo|go test|go build|make|vitest|jest|tsc|dotnet|mvn|gradle|composer|bundle|rake)\b/;

const MAX_STEPS = 15;
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

const isCommand = (s: string): boolean => COMMAND.test(s.trim()) && s.trim().length <= MAX_COMMAND_CHARS && !/[|&;<>]/.test(s);

function findCommand(lines: string[]): string | undefined {
	for (const l of lines) {
		for (const span of l.matchAll(/`([^`\n]+)`/g)) {
			if (isCommand(span[1]!)) return span[1]!.trim();
		}
		const bare = l.replace(/^\s*[-*]\s+/, "").trim();
		if (isCommand(bare)) return bare;
	}
	return undefined;
}

export function parsePlanSeed(markdown: string, fallbackTitle = "Implement plan"): PlanSeed | undefined {
	const { preamble, sections } = splitSections(markdown);
	const h1 = /^#\s+(.+?)\s*$/m.exec(markdown)?.[1];
	const title = h1 ? clean(h1.replace(/^(plan|task)[:\s-]+/i, "")) : fallbackTitle;

	// Steps: prefer a steps/actions-ish section; else every numbered line that
	// isn't inside a meta section.
	let steps: string[] = [];
	for (const s of sections) {
		if (STEP_HEAD.test(s.heading) && !SKIP_HEAD.test(s.heading)) steps.push(...numberedIn(s.lines));
	}
	if (steps.length === 0) {
		steps = [
			...numberedIn(preamble),
			...sections.flatMap((s) => (SKIP_HEAD.test(s.heading) || VERIFY_HEAD.test(s.heading) ? [] : numberedIn(s.lines))),
		];
	}
	steps = [...new Set(steps.map(clean).filter((s) => s.length >= 8))].slice(0, MAX_STEPS).map((s) => s.slice(0, MAX_STEP_CHARS));
	if (steps.length === 0) return undefined;

	// Acceptance: a command under a verify-ish heading first, else the first
	// plausible check command anywhere in the document.
	let verify: string | undefined;
	for (const s of sections) {
		if (VERIFY_HEAD.test(s.heading)) {
			verify = findCommand(s.lines);
			if (verify) break;
		}
	}
	verify ??= findCommand([...preamble, ...sections.flatMap((s) => s.lines)]);

	return { title, steps, ...(verify ? { verify } : {}) };
}

/** The board for an implement run on a plan file: its steps and verify gate.
 *  A plan with no steps is an error to fix, never a planner fallback — the
 *  run's scope is the plan. */
export function planSeedTasks(rel: string, markdown: string): { seed: SeedTask[] } | { error: string } {
	const parsed = parsePlanSeed(markdown, `Implement ${rel.split(/[\\/]/).pop()}`);
	if (!parsed) return { error: `${rel} has no numbered steps to implement. Add them under a "Steps" heading and run again.` };
	return {
		seed: [
			{
				title: `Implement plan: ${parsed.title}`,
				steps: parsed.steps,
				acceptance: parsed.verify ? { kind: "command", command: parsed.verify } : { kind: "none" },
			},
		],
	};
}
