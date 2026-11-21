import { describe, expect, it } from "vitest";
import { isConversationalTask, isRunSummaryFact, isTrivialTask } from "../src/agent/taskGuard";

describe("isConversationalTask", () => {
	it.each(["hi", "Hello!", "hey", "thanks", "thank you", "ok", "yes", "no", "sure", "lol", "gm", "good morning", "got it"])(
		"conversational: %j",
		(task) => {
			expect(isConversationalTask(task)).toBe(true);
		},
	);

	it.each(["fix the login bug", "hi, can you fix X", "add a health check endpoint", "what does store.ts do?"])(
		"not conversational: %j",
		(task) => {
			expect(isConversationalTask(task)).toBe(false);
		},
	);
});

describe("session-title openers", () => {
	// store.ts skips these when picking a session title: greetings via
	// isConversationalTask, plus the probes test/ping handled locally there.
	it.each(["hi", "hey", "hello", "yo", "sup", "ok"])("greeting skipped for titles: %j", (task) => {
		expect(isConversationalTask(task)).toBe(true);
	});

	it.each(["test", "ping"])("probe is not a conversational greeting: %j", (task) => {
		expect(isConversationalTask(task)).toBe(false);
	});
});

describe("isTrivialTask", () => {
	it.each(["hi", "Hello!", "thanks", "ok", "", "   ", "fix it", "ping"])("trivial: %j", (task) => {
		expect(isTrivialTask(task)).toBe(true);
	});

	it.each(["fix the login bug", "hi, can you fix X", "add a health check endpoint", "what does store.ts do?"])(
		"not trivial: %j",
		(task) => {
			expect(isTrivialTask(task)).toBe(false);
		},
	);
});

describe("isRunSummaryFact", () => {
	it.each([
		"Final summary for user:\n\n**Completed:**\n1. store.ts: listChunks default limit changed",
		"Summary of completed tasks:\n\n1. store.ts listChunks limit",
		"Plan items to address:\n1. ideTools.ts: Add code actions",
		"Starting implementation: ideTools.ts missing tools",
		"Implementation complete: all tests pass",
		"Completed implementation: fixed CustomFilter.apply_kernel()",
		"Task complete — pushed to branch",
		"All done with the refactor",
		"**Completed:** migration finished",
		"- Summary: wrapped up the work",
	])("summary-like: %j", (fact) => {
		expect(isRunSummaryFact(fact)).toBe(true);
	});

	it.each([
		"backend tests: node:test via `tsx --test test/*.test.ts` (npm test in backend/)",
		"Use `npx -y node@22 node_modules/vitest/vitest.mjs run` for vitest; revert package-lock.json after npm install",
		"PyQt5 UI cannot run in headless environment due to missing libGL.so.1 OpenGL library",
		"Tests run with npm test in backend/; routes test needs root node_modules installed",
		"AgentRunner.run() never throws: errors surface as run-failed events",
	])("durable fact: %j", (fact) => {
		expect(isRunSummaryFact(fact)).toBe(false);
	});
});
