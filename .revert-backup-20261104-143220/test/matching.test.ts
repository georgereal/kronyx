import { describe, expect, it } from "vitest";
import { adaptIndentation, findMatches, lineNumberAt, mostSimilarRegion } from "../src/tools/matching";

describe("findMatches", () => {
	const content = "function a() {\n    return 1;\n}\n\nfunction b() {\n    return 2;\n}\n";

	it("finds exact matches", () => {
		const m = findMatches(content, "return 2;");
		expect(m).toHaveLength(1);
		expect(m[0].strategy).toBe("exact");
		expect(content.slice(m[0].start, m[0].end)).toBe("return 2;");
	});

	it("ignores indentation differences", () => {
		const m = findMatches(content, "function b() {\nreturn 2;\n}");
		expect(m).toHaveLength(1);
		expect(m[0].strategy).toBe("trimmed-lines");
		expect(lineNumberAt(content, m[0].start)).toBe(5);
	});

	it("ignores inner whitespace differences", () => {
		const m = findMatches(content, "function  b()   {");
		expect(m).toHaveLength(1);
		expect(m[0].strategy).toBe("collapsed-whitespace");
	});

	it("reports every occurrence", () => {
		expect(findMatches(content, "}\n")).toHaveLength(2);
	});

	it("returns nothing when absent", () => {
		expect(findMatches(content, "return 3;")).toHaveLength(0);
	});
});

describe("adaptIndentation", () => {
	it("re-indents replacement to the matched indentation", () => {
		expect(adaptIndentation("    return 1;\n    x();", "return 1;\nx();", "return 42;\n  y();")).toBe(
			"    return 42;\n      y();",
		);
	});
});

describe("mostSimilarRegion", () => {
	it("points at the closest lines", () => {
		const region = mostSimilarRegion("const a = 1;\nconst bee = 2;\nconst c = 3;", "const be = 2;");
		expect(region?.startLine).toBe(2);
		expect(region?.score).toBeGreaterThan(0.7);
	});
});
