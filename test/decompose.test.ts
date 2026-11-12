import { describe, expect, it } from "vitest";
import { isSharedManifest, ownsMatch, parseSlices } from "../src/agent/decompose";

describe("isSharedManifest", () => {
	it("reserves root manifests only", () => {
		expect(isSharedManifest("package.json")).toBe(true);
		expect(isSharedManifest("package-lock.json")).toBe(true);
		expect(isSharedManifest("tsconfig.json")).toBe(true);
		expect(isSharedManifest("./package.json")).toBe(true);
	});
	it("leaves nested manifests and regular files alone", () => {
		expect(isSharedManifest("packages/web/package.json")).toBe(false);
		expect(isSharedManifest("src/app.ts")).toBe(false);
	});
	it("rejects traversal-shaped paths from the manifest check", () => {
		expect(isSharedManifest("../package.json")).toBe(false);
	});
});

describe("ownsMatch", () => {
	it("matches glob and bare-directory prefixes", () => {
		expect(ownsMatch(["src/api/**"], "src/api/x.ts")).toBe(true);
		expect(ownsMatch(["src/api"], "src/api/x.ts")).toBe(true);
		expect(ownsMatch(["docs/*.md"], "docs/a.md")).toBe(true);
	});
	it("rejects paths outside the owns set", () => {
		expect(ownsMatch(["src/api/**"], "web/x.ts")).toBe(false);
		expect(ownsMatch(["src/api/**"], "src/api2/x.ts")).toBe(false);
	});
	it("never matches traversal paths, even under a broad glob", () => {
		expect(ownsMatch(["**"], "../repo/package.json")).toBe(false);
		expect(ownsMatch(["src/**"], "src/../secret.ts")).toBe(false);
		expect(ownsMatch(["src/**"], "src/../../x")).toBe(false);
	});
});

describe("parseSlices", () => {
	const doc = (slices: unknown[]) => JSON.stringify({ slices });

	it("returns validated, renumbered slices", () => {
		const p = parseSlices(doc([{ index: 9, title: "a", task: "do a", owns: ["src/**"] }]), 6)!;
		expect(p.slices).toHaveLength(1);
		expect(p.slices[0].index).toBe(1);
		expect(p.slices[0].owns).toEqual(["src/**"]);
		expect(p.dropped).toEqual([]);
	});

	it("extracts JSON wrapped in prose and fences", () => {
		const p = parseSlices(`Here you go:\n\`\`\`json\n${doc([{ title: "x", task: "t", owns: ["a/**"] }])}\n\`\`\`\nDone.`, 6)!;
		expect(p.slices).toHaveLength(1);
	});

	it("returns null for unusable output", () => {
		expect(parseSlices("no json here", 6)).toBeNull();
		expect(parseSlices(doc([]), 6)).toBeNull();
		expect(parseSlices(doc([{ task: "t", owns: ["**"] }]), 6)).toBeNull();
	});

	it("drops slices with empty or unbounded owns and records the reason", () => {
		const p = parseSlices(
			doc([
				{ title: "bounded", task: "t", owns: ["src/**"] },
				{ title: "no owns", task: "t2", owns: [] },
				{ title: "wild", task: "t3", owns: ["**"] },
				{ title: "manifest only", task: "t4", owns: ["package.json"] },
			]),
			6,
		)!;
		expect(p.slices.map((s) => s.title)).toEqual(["bounded"]);
		expect(p.dropped.map((d) => d.title)).toEqual(["no owns", "wild", "manifest only"]);
		expect(p.dropped.every((d) => d.reason === "no bounded owns")).toBe(true);
	});

	it("strips manifest entries but keeps the slice when other owns remain", () => {
		const p = parseSlices(doc([{ title: "x", task: "t", owns: ["docs/**", "package.json", "yarn.lock"] }]), 6)!;
		expect(p.slices[0].owns).toEqual(["docs/**"]);
		expect(p.dropped).toEqual([]);
	});

	it("defers overflow past the cap to the coordinator", () => {
		const p = parseSlices(
			doc([
				{ title: "a", task: "t", owns: ["a/**"] },
				{ title: "b", task: "t", owns: ["b/**"] },
				{ title: "c", task: "t", owns: ["c/**"] },
			]),
			2,
		)!;
		expect(p.slices.map((s) => s.title)).toEqual(["a", "b"]);
		expect(p.dropped).toEqual([{ title: "c", task: "t", reason: "over slice cap" }]);
	});
});
