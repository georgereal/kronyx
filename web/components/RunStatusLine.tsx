"use client";

import { useEffect, useMemo, useState } from "react";
import type { RunEvent } from "@/lib/types";

const VERBS = ["Exploring", "Investigating", "Pondering", "Analyzing", "Navigating", "Thinking", "Tinkering"];

/** Map the last tool call to a fitting verb — feels tied to real work. */
function verbForTool(name: string): string | null {
	if (/read|search|grep|find|list|symbol|definition|reference|declaration|hover|hierarchy|open|glob/i.test(name)) return "Exploring";
	if (/investigate|inspect|diagnos/i.test(name)) return "Investigating";
	if (/write|edit|patch|rename|apply|create|delete|move/i.test(name)) return "Tinkering";
	if (/command|bash|shell|terminal|run/i.test(name)) return "Navigating";
	if (/browser|screenshot|navigate|click/i.test(name)) return "Navigating";
	if (/plan|decompose/i.test(name)) return "Pondering";
	if (/memory|recall|remember/i.test(name)) return "Pondering";
	return null;
}

/**
 * Live activity line shown while a run is in progress — a slow-spinning spark
 * plus a verb picked from the agent's latest activity (or cycling through the
 * list when nothing specific is happening). Pending approvals override it.
 */
export function RunStatusLine({ events, runId, stopping }: { events: RunEvent[]; runId?: string; stopping?: boolean }) {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const t = setInterval(() => setTick((n) => n + 1), 1400);
		return () => clearInterval(t);
	}, []);

	const status = useMemo(() => {
		const evts = runId ? events.filter((e) => e.runId === runId) : events;
		// Unanswered permission-request → approval pending.
		const answered = new Set<string>();
		for (const e of evts) if (e.event.type === "permission-response") answered.add(String(e.event.id ?? ""));
		for (let i = evts.length - 1; i >= 0; i--) {
			const ev = evts[i].event;
			if (ev.type === "permission-request" && !answered.has(String(ev.id ?? "")))
				return { word: "Approval needed", attention: true };
		}
		// Last activity decides the verb.
		for (let i = evts.length - 1; i >= 0; i--) {
			const ev = evts[i].event;
			if (ev.type === "tool-started") {
				const v = verbForTool(String(ev.name ?? ""));
				if (v) return { word: v, attention: false };
				continue;
			}
			if (ev.type === "reasoning" || ev.type === "reasoning-delta") return { word: "Thinking", attention: false };
			if (ev.type === "mode-blocked") return { word: "Action required", attention: true };
			if (ev.type === "cloud-status" || ev.type === "setup" || ev.type === "check") return { word: "", attention: false };
		}
		return { word: "", attention: false };
	}, [events, runId]);

	if (stopping) {
		return (
			<div className="run-status attention">
				<span className="spark">✻</span>
				<span>Stopping{".".repeat(1 + (tick % 3))}</span>
			</div>
		);
	}
	const word = status.word || VERBS[tick % VERBS.length];
	return (
		<div className={`run-status${status.attention ? " attention" : ""}`}>
			<span className="spark">✻</span>
			<span>
				{word}
				{".".repeat(1 + (tick % 3))}
			</span>
		</div>
	);
}
