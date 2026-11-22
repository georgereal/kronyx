import { describe, expect, it } from "vitest";
import { applyHunk, computeHunks, formatUnifiedWithContext, revertHunk } from "../src/diff/hunks";

describe("computeHunks", () => {
	it("returns no hunks for identical text", () => {
		expect(computeHunks("a\nb\nc\n", "a\nb\nc\n")).toEqual([]);
	});

	it("detects a modified line with coordinates in both docs", () => {
		const hunks = computeHunks("a\nb\nc\n", "a\nB\nc\n");
		expect(hunks).toHaveLength(1);
		expect(hunks[0].beforeStart).toBe(1);
		expect(hunks[0].afterStart).toBe(1);
		expect(hunks[0].oldLines).toEqual(["b"]);
		expect(hunks[0].newLines).toEqual(["B"]);
	});

	it("groups separate changes into separate hunks", () => {
		const before = "1\n2\n3\n4\n5\n6\n7\n8\n";
		const after = "ONE\n2\n3\n4\n5\n6\n7\nEIGHT\n";
		expect(computeHunks(before, after)).toHaveLength(2);
	});

	it("handles pure insertions and deletions", () => {
		const inserted = computeHunks("a\nc\n", "a\nb\nc\n");
		expect(inserted[0].oldLines).toEqual([]);
		expect(inserted[0].newLines).toEqual(["b"]);
		const deleted = computeHunks("a\nb\nc\n", "a\nc\n");
		expect(deleted[0].oldLines).toEqual(["b"]);
		expect(deleted[0].newLines).toEqual([]);
	});
});

describe("formatUnifiedWithContext", () => {
	it("is empty for identical text", () => {
		expect(formatUnifiedWithContext("a\nb\n", "a\nb\n")).toBe("");
	});

	it("shows three context lines around a change with correct header numbers", () => {
		const before = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
		const after = "1\n2\n3\n4\nFIVE\n6\n7\n8\n9\n";
		expect(formatUnifiedWithContext(before, after)).toBe(
			["@@ -2,7 +2,7 @@", " 2", " 3", " 4", "-5", "+FIVE", " 6", " 7", " 8"].join("\n"),
		);
	});

	it("clamps context at file boundaries", () => {
		const out = formatUnifiedWithContext("a\nb\n", "A\nb\n");
		expect(out.split("\n")).toEqual(["@@ -1,2 +1,2 @@", "-a", "+A", " b"]);
	});

	it("merges hunks whose context overlaps into one block", () => {
		const before = "1\n2\n3\n4\n5\n6\n";
		const after = "ONE\n2\n3\n4\n5\nSIX\n";
		const out = formatUnifiedWithContext(before, after).split("\n");
		expect(out.filter((l) => l.startsWith("@@"))).toHaveLength(1);
		expect(out).toContain("+SIX");
	});

	it("starts a new block for distant hunks", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `l${i}`);
		const after = [...lines];
		after[1] = "X";
		after[28] = "Y";
		const out = formatUnifiedWithContext(lines.join("\n"), after.join("\n")).split("\n");
		expect(out.filter((l) => l.startsWith("@@"))).toHaveLength(2);
	});

	it("caps output and notes the truncation", () => {
		const before = Array.from({ length: 50 }, (_, i) => `${i}`).join("\n");
		const after = Array.from({ length: 50 }, (_, i) => `x${i}`).join("\n");
		const out = formatUnifiedWithContext(before, after, { maxLines: 10 });
		expect(out.split("\n")).toHaveLength(11);
		expect(out).toMatch(/more lines\)$/);
	});
});

describe("applyHunk / revertHunk", () => {
	it("accept applies the new lines to the original", () => {
		const [hunk] = computeHunks("a\nb\nc\n", "a\nB\nc\n");
		expect(applyHunk("a\nb\nc\n", hunk)).toBe("a\nB\nc\n");
	});

	it("revert restores the original lines", () => {
		const [hunk] = computeHunks("a\nb\nc\n", "a\nB\nc\n");
		expect(revertHunk("a\nB\nc\n", hunk)).toBe("a\nb\nc\n");
	});

	it("revert tolerates the hunk shifting by a few lines", () => {
		const [hunk] = computeHunks("a\nb\nc\n", "a\nB\nc\n");
		expect(revertHunk("z\na\nB\nc\n", hunk)).toBe("z\na\nb\nc\n");
	});

	it("round-trips multiple hunks independently", () => {
		const before = "1\n2\n3\n4\n5\n6\n7\n8\n";
		const after = "ONE\n2\n3\n4\n5\n6\n7\nEIGHT\n";
		const [first, second] = computeHunks(before, after);
		// Accept the first hunk into the baseline, revert the second in the file.
		const merged = applyHunk(before, first);
		expect(computeHunks(merged, after)).toHaveLength(1);
		const reverted = revertHunk(after, second);
		expect(reverted).toBe("ONE\n2\n3\n4\n5\n6\n7\n8\n");
	});
});
