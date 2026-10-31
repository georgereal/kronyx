export type MatchStrategy = "exact" | "trimmed-lines" | "collapsed-whitespace";

export interface TextMatch {
	start: number;
	end: number;
	strategy: MatchStrategy;
}

export interface SimilarRegion {
	startLine: number;
	text: string;
	score: number;
}

type LineNormalizer = (line: string) => string;

const LINE_STRATEGIES: [MatchStrategy, LineNormalizer][] = [
	["trimmed-lines", (l) => l.trim()],
	["collapsed-whitespace", (l) => l.replace(/\s+/g, " ").trim()],
];

/**
 * Finds `needle` in `content`, first exactly, then line by line while
 * ignoring indentation and whitespace differences.
 */
export function findMatches(content: string, needle: string): TextMatch[] {
	if (needle.length === 0) return [];
	const exact = findExact(content, needle);
	if (exact.length > 0) return exact;

	const needleLines = trimBlankEdges(needle.split("\n"));
	if (needleLines.length === 0) return [];
	const lineStarts = computeLineStarts(content);
	const lines = content.split("\n");

	for (const [strategy, normalize] of LINE_STRATEGIES) {
		const target = needleLines.map(normalize);
		const matches: TextMatch[] = [];
		for (let i = 0; i + target.length <= lines.length; i++) {
			let ok = true;
			for (let j = 0; j < target.length; j++) {
				if (normalize(lines[i + j]) !== target[j]) {
					ok = false;
					break;
				}
			}
			if (ok) {
				const last = i + target.length - 1;
				matches.push({ start: lineStarts[i], end: lineStarts[last] + lines[last].length, strategy });
				i = last;
			}
		}
		if (matches.length > 0) return matches;
	}
	return [];
}

/** Re-indents a replacement so it keeps the indentation of the text it replaces. */
export function adaptIndentation(matchedText: string, oldText: string, newText: string): string {
	const matchedIndent = firstIndent(matchedText);
	const oldIndent = firstIndent(trimBlankEdges(oldText.split("\n")).join("\n"));
	const lines = trimBlankEdges(newText.split("\n"));
	if (matchedIndent === oldIndent) return lines.join("\n");
	if (matchedIndent.startsWith(oldIndent)) {
		const extra = matchedIndent.slice(oldIndent.length);
		return lines.map((line) => (line.trim() === "" ? line : extra + line)).join("\n");
	}
	if (oldIndent.startsWith(matchedIndent)) {
		const surplus = oldIndent.length - matchedIndent.length;
		return lines
			.map((line) => {
				const leading = line.length - line.trimStart().length;
				return line.slice(Math.min(surplus, leading));
			})
			.join("\n");
	}
	return lines
		.map((line) => {
			if (line.trim() === "") return line;
			const rest = line.startsWith(oldIndent) ? line.slice(oldIndent.length) : line.trimStart();
			return matchedIndent + rest;
		})
		.join("\n");
}

export function lineNumberAt(content: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < content.length; i++) {
		if (content.charCodeAt(i) === 10) line++;
	}
	return line;
}

/** Returns the region of `content` most similar to `needle`, for error hints. */
export function mostSimilarRegion(content: string, needle: string): SimilarRegion | undefined {
	const needleLines = trimBlankEdges(needle.split("\n")).map((l) => l.trim());
	const lines = content.split("\n");
	if (needleLines.length === 0 || lines.length === 0) return undefined;
	if (lines.length > 20000 || needleLines.length > 200) return undefined;

	let best: SimilarRegion | undefined;
	const window = Math.min(needleLines.length, lines.length);
	for (let i = 0; i + window <= lines.length; i++) {
		let total = 0;
		for (let j = 0; j < window; j++) total += similarity(lines[i + j].trim(), needleLines[j]);
		const score = total / needleLines.length;
		if (!best || score > best.score) {
			best = { startLine: i + 1, text: lines.slice(i, i + window).join("\n"), score };
		}
	}
	return best;
}

function findExact(content: string, needle: string): TextMatch[] {
	const matches: TextMatch[] = [];
	let from = 0;
	while (true) {
		const index = content.indexOf(needle, from);
		if (index === -1) break;
		matches.push({ start: index, end: index + needle.length, strategy: "exact" });
		from = index + needle.length;
	}
	return matches;
}

function computeLineStarts(content: string): number[] {
	const starts = [0];
	for (let i = 0; i < content.length; i++) {
		if (content.charCodeAt(i) === 10) starts.push(i + 1);
	}
	return starts;
}

function trimBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim() === "") start++;
	while (end > start && lines[end - 1].trim() === "") end--;
	return lines.slice(start, end);
}

function firstIndent(text: string): string {
	const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
	return line.slice(0, line.length - line.trimStart().length);
}

function similarity(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return 0;
	const grams = new Map<string, number>();
	for (let i = 0; i < a.length - 1; i++) {
		const g = a.slice(i, i + 2);
		grams.set(g, (grams.get(g) ?? 0) + 1);
	}
	let overlap = 0;
	for (let i = 0; i < b.length - 1; i++) {
		const g = b.slice(i, i + 2);
		const count = grams.get(g) ?? 0;
		if (count > 0) {
			grams.set(g, count - 1);
			overlap++;
		}
	}
	return (2 * overlap) / (a.length + b.length - 2);
}
