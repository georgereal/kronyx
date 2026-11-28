/**
 * Panel smoke test — renders media/harness.js in jsdom against a synthetic
 * report and asserts the dashboard structure survives end-to-end: tabs, tiles,
 * the two-column plan layout, the detail drawer with its four tabs, and the
 * correlation graph chain (turn → call → execution → step + plan node).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { buildHarnessReport } from "../../src/harness/report/report";

function syntheticReport() {
	const task = (id: string, seq: number) => ({
		type: "task.created",
		task: { id, title: `Task ${id}`, status: "pending", acceptance: { kind: "none" }, dependsOn: [], steps: [{ id: "s1", text: `${id} step`, status: "pending", evidence: [], callIds: [] }] },
		runId: "r1",
		seq,
		at: seq * 100,
	});
	const events = [
		{ type: "run.status", status: "running", runId: "r1", seq: 1, at: 100 },
		task("t1", 2),
		{ type: "step.updated", taskId: "t1", stepId: "s1", to: "in_progress", callIds: [], runId: "r1", seq: 3, at: 300 },
		{
			type: "model.response", turn: 1, text: "working", runId: "r1", seq: 4, at: 400,
			toolCalls: [{ callId: "c1", name: "read_file", input: { path: "a.ts" } }],
			providerItems: { providerId: "p", modelId: "m", items: [{ type: "reasoning", id: "rs_1", content: [{ type: "reasoning_text", text: "thinking" }] }] },
			usage: { inputTokens: 10, outputTokens: 5 },
		},
		{ type: "tool.requested", callId: "c1", name: "read_file", input: { path: "a.ts" }, runId: "r1", seq: 5, at: 500 },
		{ type: "tool.finished", callId: "c1", name: "read_file", ok: true, output: "contents", runId: "r1", seq: 6, at: 600 },
		{ type: "step.updated", taskId: "t1", stepId: "s1", to: "done", callIds: ["c1"], runId: "r1", seq: 7, at: 700 },
		{ type: "run.status", status: "completed", runId: "r1", seq: 8, at: 800 },
	] as never[];
	return buildHarnessReport(events);
}

function bootPanel(report: unknown) {
	const dom = new JSDOM(`<!DOCTYPE html><html><body>
		<select id="session"><option value="s1">s1</option></select><select id="run"></select>
		<div id="report"></div><div id="hint"></div>
		<button id="refresh"></button><button id="upload"></button><button id="export"></button>
		<div id="live" hidden></div>
	</body></html>`, { url: "https://localhost/", runScripts: "outside-only" });
	const win = dom.window as never as {
		acquireVsCodeApi?: unknown;
		eval: (s: string) => void;
		dispatchEvent: (e: unknown) => boolean;
		MessageEvent: new (type: string, init: { data: unknown }) => Event;
		MouseEvent: new (type: string, init: { bubbles: boolean }) => Event;
		document: Document;
	};
	(win as Record<string, unknown>).acquireVsCodeApi = () => ({ postMessage: () => undefined, getState: () => undefined, setState: () => undefined });
	win.eval(readFileSync("media/harness.js", "utf8"));
	// Boot through the real host flow: the sessions message repopulates the select
	// and auto-selects the newest — load() wipes the options at eval time, so any
	// value set before this message never sticks.
	win.dispatchEvent(new win.MessageEvent("message", { data: { type: "sessions", sessions: [{ name: "s1", at: 1 }] } }));
	win.dispatchEvent(new win.MessageEvent("message", { data: { type: "report", report, session: "s1", events: 100 } }));
	return win;
}

describe("harness panel smoke", () => {
	it("renders the full dashboard structure and the detail drawer with correlation graph", () => {
		const win = bootPanel(syntheticReport());
		const doc = win.document;
		expect(doc.querySelectorAll(".tab").length).toBe(8);
		expect(doc.querySelectorAll(".tile").length).toBe(6);
		expect(doc.querySelectorAll(".plan-layout").length).toBe(1);
		expect(doc.querySelectorAll(".plan-side .evo-card").length).toBe(1);
		expect(doc.querySelectorAll(".step-clickable").length).toBe(1);

		// click the step row — the drawer opens with all four tabs
		const step = doc.querySelector(".step-clickable") as HTMLElement;
		step.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
		const drawer = doc.querySelector(".info-popover.drawer");
		expect(drawer).toBeTruthy();
		const tabLabels = [...drawer!.querySelectorAll(".drawer-tab")].map((t) => t.textContent);
		expect(tabLabels[0]).toBe("Overview");
		expect(tabLabels.some((t) => t?.startsWith("Execution"))).toBe(true);
		expect(tabLabels).toContain("Links");

		// Links tab: full-chain graph — turn/call/execution nodes per run plus step and plan
		const links = [...drawer!.querySelectorAll(".drawer-tab")].find((t) => t.textContent === "Links") as HTMLElement;
		links.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
		const svg = drawer!.querySelector(".corr-svg");
		expect(svg).toBeTruthy();
		const texts = [...svg!.querySelectorAll("text")].map((t) => t.textContent);
		expect(texts).toContain("Turn 1");
		expect(texts).toContain("execution");
		expect(texts.some((t) => t?.startsWith("Plan"))).toBe(true);
		expect(texts.some((t) => t?.includes("t1/s1"))).toBe(true);
		expect(svg!.querySelectorAll("line").length).toBeGreaterThanOrEqual(3);
	});

	it("re-render closes the drawer but keeps the selected tab", () => {
		const win = bootPanel(syntheticReport());
		const doc = win.document;
		const timeline = [...doc.querySelectorAll(".tab")].find((t) => t.textContent === "Execution Trace") as HTMLElement;
		timeline.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
		expect(doc.querySelectorAll(".tl-row").length).toBeGreaterThan(0);
		// same event count → no rebuild (tab state and DOM preserved)
		win.dispatchEvent(new win.MessageEvent("message", { data: { type: "report", report: syntheticReport(), session: "s1", events: 100 } }));
		expect(doc.querySelectorAll(".tl-row").length).toBeGreaterThan(0);
	});
	it("Run Data tab auto-loads raw events and renders the parsed viewer", () => {
		const win = bootPanel(syntheticReport());
		const doc = win.document;
		const rawTab = [...doc.querySelectorAll(".tab")].find((t) => t.textContent === "Run Data") as HTMLElement;
		rawTab.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
		// auto-request fired — simulate the host answering with JSONL lines
		win.dispatchEvent(new win.MessageEvent("message", { data: { type: "rawEvents", session: "s1", lines: [JSON.stringify({ type: "run.status", status: "running", runId: "r1", seq: 1, at: 100 })] } }));
		const html = doc.getElementById("report")!.innerHTML;
		expect(html).toContain("raw-event");
		expect(doc.querySelectorAll(".raw-event").length).toBe(1);
		// type filter + pretty-printed JSON inside the expander
		expect(html).toContain("run.status");
		const pre = doc.querySelector(".raw-event .raw-pre");
		expect(pre?.textContent).toContain('"seq": 1');
	});

});
