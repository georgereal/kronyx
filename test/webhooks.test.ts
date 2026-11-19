import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubTask, matchFilter, renderTemplate, verifySignature } from "../backend/src/lib/webhookLib";

describe("verifySignature", () => {
	it("accepts a valid sha256= signature and rejects bad ones", () => {
		const sig = `sha256=${createHmac("sha256", "s3cret").update("body").digest("hex")}`;
		expect(verifySignature("s3cret", "body", sig)).toBe(true);
		expect(verifySignature("s3cret", "tampered", sig)).toBe(false);
		expect(verifySignature("s3cret", "body", null)).toBe(false);
		expect(verifySignature("s3cret", "body", "md5=abc")).toBe(false);
	});
});

describe("matchFilter", () => {
	const payload = { ref: "refs/heads/main", action: "labeled" };
	it("empty filter matches; globs match; mismatches reject", () => {
		expect(matchFilter(undefined, payload)).toBe(true);
		expect(matchFilter({}, payload)).toBe(true);
		expect(matchFilter({ ref: "refs/heads/*", action: "labeled" }, payload)).toBe(true);
		expect(matchFilter({ ref: "refs/heads/dev" }, payload)).toBe(false);
		expect(matchFilter({ "missing.path": "*" }, payload)).toBe(false);
	});
});

describe("renderTemplate", () => {
	it("interpolates {{dot.paths}} and empties missing ones", () => {
		const p = { repository: { full_name: "o/r" }, issue: { number: 7 } };
		expect(renderTemplate("repo={{repository.full_name}} issue={{issue.number}}", p)).toBe("repo=o/r issue=7");
		expect(renderTemplate("[{{missing.deep}}]", p)).toBe("[]");
	});
});

describe("githubTask", () => {
	const base = {
		repository: { full_name: "o/r" },
		installation: { id: 1 },
		issue: { number: 7, title: "Fix the bug", body: "It crashes." },
	};
	it("issues.labeled with the kronyx label produces an agent task", () => {
		const t = githubTask("issues", { ...base, action: "labeled", label: { name: "kronyx" } });
		expect(t).toContain("issue #7");
		expect(t).toContain("Fix the bug");
		expect(githubTask("issues", { ...base, action: "labeled", label: { name: "other" } })).toBeNull();
		expect(githubTask("issues", { ...base, action: "opened", label: { name: "kronyx" } })).toBeNull();
	});

	it("issue_comment @kronyx mention produces a task; bare mention and non-comments ignored", () => {
		const p = { ...base, action: "created", comment: { body: "@kronyx fix this please", user: { login: "j" } } };
		const t = githubTask("issue_comment", p);
		expect(t).toContain("fix this please");
		expect(t).toContain("@j");
		expect(githubTask("issue_comment", { ...base, action: "created", comment: { body: "@kronyx" } })).toBeNull();
		expect(githubTask("issue_comment", { ...base, action: "created", comment: { body: "no mention" } })).toBeNull();
	});
});
