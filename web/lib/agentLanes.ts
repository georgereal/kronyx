import type { RunDoc, RunEvent } from "@/lib/types";

/** Per-agent drill-down target: runId + agentIndex (0 = coordinator/main lane). */
export interface AgentFocus {
	runId: string;
	ai: number;
}

/** The fanout event for a run (latest fanout in the window when runId omitted). */
export function fanoutEventFor(events: RunEvent[], runId?: string): RunEvent | undefined {
	for (let k = events.length - 1; k >= 0; k--) {
		const e = events[k];
		if (e.event.type === "fanout" && (!runId || e.runId === runId)) return e;
	}
	return undefined;
}

export function sliceTitle(events: RunEvent[], i: number, runId?: string): string {
	const s = (fanoutEventFor(events, runId)?.event.slices as { index: number; title: string }[] | undefined)?.find(
		(x) => x.index === i,
	);
	return s?.title ?? `Slice ${i}`;
}

export function sliceStatus(events: RunEvent[], runs: RunDoc[] | undefined, i: number, runId?: string): string {
	const fromRun = runs?.find((r) => r.runId === runId)?.slices?.find((s) => s.index === i)?.status;
	if (fromRun) return fromRun;
	for (let k = events.length - 1; k >= 0; k--) {
		const e = events[k];
		if (e.event.type === "slice-status" && e.event.index === i && (!runId || e.runId === runId)) return String(e.event.status);
	}
	return "queued";
}

export function sliceSummary(events: RunEvent[], runs: RunDoc[] | undefined, i: number, runId?: string): string {
	const fromRun = runs?.find((r) => r.runId === runId)?.slices?.find((s) => s.index === i)?.summary;
	if (fromRun) return fromRun;
	for (let k = events.length - 1; k >= 0; k--) {
		const e = events[k];
		if (e.event.type === "slice-status" && e.event.index === i && (!runId || e.runId === runId) && e.event.summary)
			return String(e.event.summary);
	}
	return "";
}

export interface AgentVitals {
	lastAct: string;
	tin: number;
	tout: number;
	ctxPct: number;
	files: number;
	dur: string;
	secs: number;
}

/** Live vitals for one agent lane — all derived from the event stream. */
export function agentVitals(events: RunEvent[], ai: number, runId?: string): AgentVitals {
	let lastAct = "";
	type UsageEv = { inputTokens?: number; outputTokens?: number; contextPct?: number; contextWindow?: number };
	let usage: UsageEv | null = null;
	let files = 0;
	let startedAt = 0;
	let endedAt = 0;
	for (const e of events) {
		if ((e.event.agentIndex ?? 0) !== ai || (runId && e.runId !== runId)) continue;
		const ev = e.event as Record<string, unknown> & { type: string };
		if (ev.type === "run-started") startedAt = Date.parse(e.at ?? "") || startedAt;
		if (ev.type === "run-finished" || ev.type === "run-failed") endedAt = Date.parse(e.at ?? "") || endedAt;
		if (ev.type === "usage") usage = ev as unknown as UsageEv;
		if (ev.type === "file-changed") {
			files++;
			lastAct = `edited ${String(ev.path ?? "")}`;
		}
		if (ev.type === "tool-started") {
			const inp = (ev.input ?? {}) as Record<string, unknown>;
			lastAct = `${String(ev.name)} ${String(inp.path ?? inp.file ?? inp.command ?? inp.url ?? inp.query ?? inp.slug ?? "")}`.trim();
		}
		if (ev.type === "assistant-text") lastAct = String(ev.text ?? "").split("\n")[0].slice(0, 100);
		if (ev.type === "run-finished") lastAct = "finished";
		if (ev.type === "run-failed") lastAct = `failed: ${String(ev.error ?? "").slice(0, 80)}`;
	}
	// Live activity prefers the in-flight tool over the last text.
	const secs = startedAt ? Math.round(((endedAt || Date.now()) - startedAt) / 1000) : 0;
	const dur = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
	return { lastAct, tin: usage?.inputTokens ?? 0, tout: usage?.outputTokens ?? 0, ctxPct: usage?.contextPct ?? 0, files, dur: startedAt ? dur : "", secs };
}

/** Deterministic glyph per slice kind, picked by title keywords. */
export function sliceIcon(title: string): string {
	if (/test|spec|qa\b|coverage/i.test(title)) return "🧪";
	if (/doc|readme|guide/i.test(title)) return "📄";
	if (/secur|auth|audit|vuln/i.test(title)) return "🛡";
	if (/analy|review|scan|explor|investigat/i.test(title)) return "🔍";
	if (/ui|css|style|front|design/i.test(title)) return "🎨";
	return "</>";
}
