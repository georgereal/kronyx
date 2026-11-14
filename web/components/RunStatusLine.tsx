"use client";

import { useEffect, useMemo, useState } from "react";
import type { RunEvent } from "@/lib/types";

const VERBS = ["Exploring", "Investigating", "Pondering", "Analyzing", "Navigating", "Thinking", "Tinkering"];

/** Map a tool call to a fitting verb — feels tied to real work. */
function verbForTool(name: string): string {
	if (/read|search|grep|find|list|symbol|definition|reference|declaration|hover|hierarchy|open|glob/i.test(name)) return "Exploring";
	if (/investigate|inspect|diagnos/i.test(name)) return "Investigating";
	if (/write|edit|patch|rename|apply|create|delete|move/i.test(name)) return "Tinkering";
	if (/command|bash|shell|terminal|run/i.test(name)) return "Navigating";
	if (/browser|screenshot|navigate|click/i.test(name)) return "Navigating";
	if (/plan|decompose|memory|recall|remember/i.test(name)) return "Pondering";
	if (/fetch/i.test(name)) return "Exploring";
	return "Working";
}

/** Human description of what a tool is doing right now. */
function describe(name: string, input: Record<string, unknown>): string {
	const path = String(input.path ?? input.file ?? "");
	const cmd = String(input.command ?? input.cmd ?? "");
	const url = String(input.url ?? "");
	if (/run_command|bash|shell|terminal/i.test(name)) return `Running ${cmd || "command"}`;
	if (/read/i.test(name)) return `Reading ${path || "file"}`;
	if (/write|append|insert/i.test(name)) return `Writing ${path || "file"}`;
	if (/edit|replace|patch/i.test(name)) return `Editing ${path || "file"}`;
	if (/list|glob/i.test(name)) return `Listing ${path || "files"}`;
	if (/search|grep|find|symbol|reference|definition/i.test(name)) return `Searching ${String(input.query ?? input.symbol ?? path ?? "")}`.trim();
	if (/fetch_url/i.test(name)) return `Fetching ${url}`;
	if (/browser/i.test(name)) return `Browsing ${url || "the app"}`;
	if (/save_plan/i.test(name)) return "Saving plan";
	if (/memory/i.test(name)) return "Updating memory";
	if (/recall/i.test(name)) return "Recalling context";
	if (/switch_environment/i.test(name)) return "Switching environment";
	return `Running ${name}`;
}

const trunc = (s: string, n = 72) => (s.length > n ? `${s.slice(0, n)}…` : s);
const fmtElapsed = (ms: number) => {
	const s = Math.max(0, Math.floor(ms / 1000));
	return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

interface InFlight {
	key: string;
	name: string;
	desc: string;
	at: number;
}

/**
 * Devin-style live "working" panel while a run is in progress: a status line
 * (verb + total elapsed) plus the tools in flight right now with their own
 * durations. Pending approvals take over the line.
 */
export function RunStatusLine({ events, runId, stopping }: { events: RunEvent[]; runId?: string; stopping?: boolean }) {
	const [tick, setTick] = useState(0);
	const [open, setOpen] = useState(true);
	const now = Date.now();
	useEffect(() => {
		const t = setInterval(() => setTick((n) => n + 1), 1000);
		return () => clearInterval(t);
	}, []);

	const { status, inflight, startedAt } = useMemo(() => {
		const evts = runId ? events.filter((e) => e.runId === runId) : events;
		// In-flight = tool-started with no tool-finished (keyed per agent lane).
		const done = new Set<string>();
		const answered = new Set<string>();
		for (const e of evts) {
			if (e.event.type === "tool-finished") done.add(`${e.event.agentIndex ?? 0}:${String(e.event.id ?? "")}`);
			if (e.event.type === "permission-response") answered.add(String(e.event.id ?? ""));
		}
		const inflight: InFlight[] = [];
		for (const e of evts) {
			if (e.event.type !== "tool-started") continue;
			const key = `${e.event.agentIndex ?? 0}:${String(e.event.id ?? "")}`;
			if (done.has(key)) continue;
			const name = String(e.event.name ?? "tool");
			inflight.push({
				key,
				name,
				desc: trunc(describe(name, (e.event.input ?? {}) as Record<string, unknown>)),
				at: Date.parse(String(e.at ?? "")) || now,
			});
		}
		// Approval pending?
		let attention = false;
		for (let i = evts.length - 1; i >= 0; i--) {
			const ev = evts[i].event;
			if (ev.type === "permission-request" && !answered.has(String(ev.id ?? ""))) {
				attention = true;
				break;
			}
			if (ev.type === "tool-finished" || ev.type === "assistant-text") break;
		}
		// Verb from the newest in-flight tool (falls back to last activity).
		let word = "";
		for (let i = evts.length - 1; i >= 0; i--) {
			const ev = evts[i].event;
			if (ev.type === "tool-started") {
				word = verbForTool(String(ev.name ?? ""));
				break;
			}
			if (ev.type === "reasoning" || ev.type === "reasoning-delta") {
				word = "Thinking";
				break;
			}
			if (ev.type === "mode-blocked") {
				attention = true;
				break;
			}
		}
		const startedAt = evts.length ? Date.parse(String(evts[0].at ?? "")) || now : now;
		return { status: { word: attention ? "Approval needed" : word, attention }, inflight, startedAt };
	}, [events, runId, now]);

	const dots = ".".repeat(1 + (tick % 3));
	if (stopping) {
		return (
			<div className="run-status attention">
				<span className="spark">✻</span>
				<span>Stopping{dots}</span>
			</div>
		);
	}
	const word = status.word || VERBS[tick % VERBS.length];
	return (
		<div className="run-panel">
			<button className={`run-status${status.attention ? " attention" : ""}`} onClick={() => setOpen((v) => !v)}>
				<span className="spark">✻</span>
				<span>
					{word}
					{dots}
				</span>
				<span className="run-elapsed">Working for {fmtElapsed(now - startedAt)}</span>
				{inflight.length > 0 && <span className="run-caret">{open ? "▾" : "▸"}</span>}
			</button>
			{open && inflight.length > 0 && (
				<div className="run-inflight">
					{inflight.map((t) => (
						<div key={t.key} className="run-inflight-row">
							<span className="muted">{t.desc}</span>
							<span className="run-inflight-dur">{fmtElapsed(now - t.at)}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
