import { describe, expect, it } from "vitest";
import { applyHunk, computeHunks, revertHunk } from "../src/diff/hunks";

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
