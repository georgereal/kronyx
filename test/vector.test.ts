import { describe, expect, it } from "vitest";
import { chunkTextInfo, contentHash, cosine, MAX_CHUNKS_PER_FILE, topK } from "../src/agent/vector";

describe("cosine", () => {
	it("is 1 for identical vectors and 0 for orthogonal or empty ones", () => {
		expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
		expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
		expect(cosine([0, 0], [1, 1])).toBe(0);
	});
});

describe("topK", () => {
	it("keeps the k best items, best first", () => {
		const out = topK([3, 9, 1, 7, 5], 3, (n) => n);
		expect(out.map((r) => r.item)).toEqual([9, 7, 5]);
	});

	it("returns everything when k exceeds the input and nothing when k is 0", () => {
		expect(topK([1, 2], 5, (n) => n)).toHaveLength(2);
		expect(topK([1, 2], 0, (n) => n)).toEqual([]);
	});
});

describe("chunkTextInfo", () => {
	it("reports how many chunks the per-file cap dropped", () => {
		const lines = Array.from({ length: 150 * 80 }, (_, i) => `line ${i} of the file with enough text`);
		const { chunks, dropped } = chunkTextInfo(lines.join("\n"));
		expect(chunks.length).toBe(MAX_CHUNKS_PER_FILE);
		expect(dropped).toBeGreaterThan(0);
	});

	it("drops nothing for a small file", () => {
		const { chunks, dropped } = chunkTextInfo("a small file with a few lines of ordinary content\nand another line here");
		expect(chunks.length).toBe(1);
		expect(dropped).toBe(0);
	});
});

describe("contentHash", () => {
	it("is stable for equal text and differs for changed text", () => {
		expect(contentHash("abc")).toBe(contentHash("abc"));
		expect(contentHash("abc")).not.toBe(contentHash("abd"));
	});
});
