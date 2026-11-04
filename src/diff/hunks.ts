import { diffLines } from "diff";

export interface Hunk {
	/** 0-based start line in the "before" document. */
	beforeStart: number;
	/** 0-based start line in the "after" document. */
	afterStart: number;
	/** Lines removed from "before" (empty for pure additions). */
	oldLines: string[];
	/** Lines added in "after" (empty for pure deletions). */
	newLines: string[];
}

/**
 * Line-level diff hunks between two texts, with coordinates in both.
 * Hunks describe contiguous changed regions (unchanged gaps are skipped).
 */
export function computeHunks(before: string, after: string): Hunk[] {
	const parts = diffLines(before, after);
	const hunks: Hunk[] = [];
	let beforeLine = 0;
	let afterLine = 0;

	const count = (s: string) => (s === "" ? 0 : s.replace(/\n$/, "").split("\n").length);

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (!part.added && !part.removed) {
			beforeLine += count(part.value);
			afterLine += count(part.value);
			continue;
		}
		const oldLines: string[] = [];
		const newLines: string[] = [];
		const bStart = beforeLine;
		const aStart = afterLine;
		// Consume consecutive changed parts as one hunk
		while (i < parts.length && (parts[i].added || parts[i].removed)) {
			const p = parts[i];
			const lines = p.value.replace(/\n$/, "").split("\n");
			if (p.removed) oldLines.push(...lines);
			else newLines.push(...lines);
			i++;
		}
		i--;
		beforeLine += oldLines.length;
		afterLine += newLines.length;
		hunks.push({ beforeStart: bStart, afterStart: aStart, oldLines, newLines });
	}
	return hunks;
}

/** Compact unified-diff text for a hunk list, capped at `maxLines` lines. */
export function formatHunks(hunks: Hunk[], maxLines = 60): string {
	const lines: string[] = [];
	hunks.forEach((h, i) => {
		lines.push(`@@ -${h.beforeStart + 1},${h.oldLines.length} +${h.afterStart + 1},${h.newLines.length} @@`);
		for (const l of h.oldLines) lines.push(`-${l}`);
		for (const l of h.newLines) lines.push(`+${l}`);
		if (i < hunks.length - 1) lines.push("…");
	});
	if (lines.length > maxLines) {
		return `${lines.slice(0, maxLines).join("\n")}\n… (${lines.length - maxLines} more lines)`;
	}
	return lines.join("\n");
}

/** Apply hunk edits: replace `oldLines` at `beforeStart` in `before` with `newLines`. */
export function applyHunk(before: string, hunk: Hunk): string {
	const lines = before.split("\n");
	lines.splice(hunk.beforeStart, hunk.oldLines.length, ...hunk.newLines);
	return lines.join("\n");
}

/** Revert hunk edits: replace `newLines` at `afterStart` in `after` with `oldLines`. */
export function revertHunk(after: string, hunk: Hunk): string {
	const lines = after.split("\n");
	// Verify the hunk still applies; tolerate drift by searching nearby.
	const match = (offset: number) =>
		hunk.newLines.every((l, i) => lines[offset + i] === l);
	let start = -1;
	for (const offset of [0, -1, 1, -2, 2, -3, 3]) {
		if (match(hunk.afterStart + offset)) {
			start = hunk.afterStart + offset;
			break;
		}
	}
	if (start === -1) {
		const idx = lines.findIndex((l) => l === hunk.newLines[0]);
		if (idx === -1 || !match(idx)) return after; // hunk no longer identifiable
		start = idx;
	}
	lines.splice(start, hunk.newLines.length, ...hunk.oldLines);
	return lines.join("\n");
}
