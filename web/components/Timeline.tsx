"use client";

import type { User } from "firebase/auth";
import { useEffect, useState } from "react";
import { marked } from "marked";
import { apiFetch } from "@/lib/api";
import type { RunDoc, RunEvent } from "@/lib/types";

const KIND: Record<string, string> = {
	"run-started": "Task",
	"assistant-text": "Kronyx",
	reasoning: "Thought process",
	"tool-started": "Tool",
	"tool-finished": "Result",
	"file-changed": "File",
	check: "Check",
	"cloud-status": "Cloud",
	info: "Info",
	setup: "Setup",
	"plan-ready": "Plan",
	"mode-blocked": "Mode",
	"loop-detected": "Stopped",
	"run-finished": "Done",
	"run-failed": "Failed",
};

type Item =
	| { kind: "stream"; streamKind: "reasoning" | "assistant"; text: string; done: boolean; key: string; runId?: string }
	| { kind: "terminal"; name: string; input: unknown; output?: string; ok?: boolean; durationMs?: number; toolId?: string; key: string; runId?: string }
	| { kind: "event"; e: RunEvent; key: string };

/**
 * Fold token-delta events into one stream item each. A delta stream stays
 * "open" until its final event (reasoning / assistant-text) replaces it —
 * so replays show one Thinking card and one reply card, not 200 tokens.
 */
function fold(events: RunEvent[]): Item[] {
	const items: Item[] = [];
	let openReasoning: Extract<Item, { kind: "stream" }> | null = null;
	let openAssistant: Extract<Item, { kind: "stream" }> | null = null;
	// assistant-text is the final copy of the last delta stream — merge it in,
	// never render it as a separate card (that's the visible duplicate).
	let lastAssistant: (Extract<Item, { kind: "stream" }> & { absorbed?: boolean }) | null = null;
	for (const e of events) {
		const t = e.event.type;
		if (t === "reasoning-delta" || t === "assistant-delta") {
			const isR = t === "reasoning-delta";
			let s: Extract<Item, { kind: "stream" }> | null = isR ? openReasoning : openAssistant;
			if (!s || s.done || (!isR && lastAssistant?.absorbed)) {
				s = { kind: "stream", streamKind: isR ? "reasoning" : "assistant", text: "", done: false, key: `s${e.runId}-${e.seq}`, runId: e.runId };
				items.push(s);
				if (isR) openReasoning = s;
				else {
					openAssistant = s;
					lastAssistant = s;
				}
			}
			s.text += String(e.event.text ?? "");
			continue;
		}
		if (t === "reasoning") {
			if (openReasoning && !openReasoning.done) {
				openReasoning.text = String(e.event.text ?? openReasoning.text);
				openReasoning.done = true;
				openReasoning = null;
				continue;
			}
		}
		if (t === "assistant-text") {
			// Merge into this iteration's stream regardless of intervening events
			// (usage/reasoning close the delta but shouldn't spawn a second card).
			if (lastAssistant && !lastAssistant.absorbed) {
				lastAssistant.text = String(e.event.text ?? lastAssistant.text);
				lastAssistant.done = true;
				lastAssistant.absorbed = true;
				continue;
			}
		}
		// Close any dangling streams on non-stream events (tools, finish, etc.).
		if (openReasoning && t !== "reasoning-delta") {
			openReasoning.done = true;
			openReasoning = null;
		}
		if (openAssistant && t !== "assistant-delta") {
			openAssistant.done = true;
			openAssistant = null;
		}
		items.push({ kind: "event", e, key: `e${e.runId}-${e.seq}` });
	}
	return items;
}

function Md({ text }: { text: string }) {
	return <div className="md" dangerouslySetInnerHTML={{ __html: marked.parse(text) as string }} />;
}

function toolInput(input: unknown): string {
	if (input == null) return "";
	const s = typeof input === "string" ? input : JSON.stringify(input);
	return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}

function PlanCard({ user, sessionId, slug }: { user: User; sessionId: string; slug: string }) {
	const [plan, setPlan] = useState<{ markdown: string; slug: string } | null>(null);
	const [msg, setMsg] = useState("");

	useEffect(() => {
		void (async () => {
			const res = await apiFetch(`/api/plans/_?session=${sessionId}&slug=${encodeURIComponent(slug)}`, user);
			if (res.ok) setPlan((await res.json()).plan);
		})();
	}, [user, sessionId, slug]);

	const implement = async () => {
		setMsg("Queued…");
		const res = await apiFetch(`/api/sessions/${sessionId}/messages`, user, {
			method: "POST",
			body: JSON.stringify({ task: `Implement the plan "${slug}"`, mode: "agent", planSlug: slug }),
		});
		setMsg(res.ok ? "Implementation queued" : "Failed to queue");
		if (res.ok) window.dispatchEvent(new CustomEvent("kronyx:refresh-session"));
	};
	const push = async () => {
		setMsg("Pushing…");
		const res = await apiFetch(`/api/sessions/${sessionId}/plans/${encodeURIComponent(slug)}/push`, user, { method: "POST" });
		setMsg(res.ok ? "Plan push queued" : "Push failed");
		if (res.ok) window.dispatchEvent(new CustomEvent("kronyx:refresh-session"));
	};

	return (
		<div className="plan-card">
			<div className="ev-kind">Plan · {slug}</div>
			{plan ? <Md text={plan.markdown} /> : <div className="muted">Loading plan…</div>}
			<div className="actions">
				<button className="btn sm" onClick={implement}>Implement</button>
				<button className="btn sm ghost" onClick={push}>Push plan to branch</button>
				{msg && <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>{msg}</span>}
			</div>
		</div>
	);
}

function Event({ user, sessionId, e }: { user: User; sessionId: string; e: RunEvent }) {
	const ev = e.event;
	const kind = KIND[ev.type] ?? ev.type;
	const cls =
		ev.type === "run-failed" ? "failed"
		: ev.type === "run-finished" ? "assistant"
		: ev.type === "cloud-status" || ev.type === "info" || ev.type === "setup" ? "status"
		: "";

	if (ev.type === "run-started") {
		// User message bubble: task text up front, inlined attachment context
		// summarized as a chip instead of dumped into the bubble.
		const raw = String(ev.task ?? "");
		const split = raw.split(/\n\nAttached context:\n/);
		const task = split[0];
		const attCount = split.length > 1 ? (split[1].match(/--- attached file:/g) ?? []).length : 0;
		return (
			<div className="ev user-msg">
				<div className="ev-kind">You</div>
				<span className="stream-text">{task}</span>
				{attCount > 0 && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>+{attCount} attached file{attCount > 1 ? "s" : ""}</div>}
			</div>
		);
	}
	if (ev.type === "run-failed") {
		const err = String(ev.error ?? ev.text ?? "");
		const iterLimit = /maxIterations|exceeded.*iterations/i.test(err);
		return (
			<div className="ev failed">
				<div className="ev-kind">Failed</div>
				<span>{err || "Run failed"}</span>
				{iterLimit && (
					<button
						className="btn sm"
						style={{ marginTop: 8 }}
						onClick={async () => {
							const res = await apiFetch(`/api/sessions/${sessionId}/messages`, user, {
								method: "POST",
								body: JSON.stringify({ task: "Continue where you left off and finish the task.", mode: "agent" }),
							});
							if (res.ok) window.dispatchEvent(new CustomEvent("kronyx:refresh-session"));
						}}
					>
						Continue run
					</button>
				)}
			</div>
		);
	}
	if (ev.type === "plan-ready") {
		const path = String(ev.path ?? "");
		const slug = path.split("/").pop()?.replace(/\.md$/, "") ?? "plan";
		return <PlanCard user={user} sessionId={sessionId} slug={slug} />;
	}
	if (ev.type === "tool-started") {
		return (
			<div className={`ev ${cls}`}>
				<details>
					<summary>
						<span className="mono" style={{ color: "var(--accent)" }}>{String(ev.name)}</span>{" "}
						<span className="muted">{toolInput(ev.input)}</span>
					</summary>
					<pre className="tool-out">{JSON.stringify(ev.input, null, 2)}</pre>
				</details>
			</div>
		);
	}
	if (ev.type === "tool-finished") {
		const out = String(ev.output ?? "");
		if (!out.trim()) return null;
		return (
			<div className={`ev ${cls}`}>
				<details>
					<summary>
						Result {ev.ok === false && <span style={{ color: "var(--err)" }}>(error)</span>}
					</summary>
					<pre className="tool-out">{out.slice(0, 4000)}</pre>
				</details>
			</div>
		);
	}
	if (ev.type === "file-changed") {
		return (
			<div className={`ev ${cls}`}>
				<div className="file-row">± {String(ev.path)} {ev.added != null && <span className="muted">+{String(ev.added)} −{String(ev.removed ?? 0)}</span>}</div>
				{ev.diff ? <pre className="diff">{String(ev.diff).slice(0, 8000)}</pre> : null}
			</div>
		);
	}
	const text =
		(ev.text as string) || (ev.error as string) || (ev.detail as string) || (ev.command as string) ||
		(ev.status as string) || "";
	// run-finished carries the same reply as assistant-text — render as a slim
	// status line so the message isn't duplicated.
	if (ev.type === "run-finished") {
		return <div className="ev status" style={{ borderStyle: "dashed" }}><div className="ev-kind">Done</div></div>;
	}
	if (!text && !ev.type.startsWith("run-")) return null;
	return (
		<div className={`ev ${cls}`}>
			<div className="ev-kind">{kind}{ev.type === "check" && <span style={{ color: ev.ok ? "var(--ok)" : "var(--err)" }}> · {String(ev.ok ? "passed" : "failed")}</span>}</div>
			<span>{text}</span>
			{ev.type === "check" && ev.output ? <pre className="tool-out">{String(ev.output)}</pre> : null}
		</div>
	);
}

type Worked = { kind: "worked"; items: Item[]; runId?: string; added: number; removed: number; done: boolean; key: string };
type Block = Item | Worked;

const TOP_LEVEL = new Set(["run-started", "assistant-text", "run-finished", "run-failed", "plan-ready", "cloud-status", "mode-blocked", "loop-detected"]);

/** Group folded items into blocks: activity runs → one collapsible worked card. */
function blocks(items: Item[]): Block[] {
	const out: Block[] = [];
	let cur: Worked | null = null;
	const flush = () => { if (cur) { out.push(cur); cur = null; } };
	for (const item of items) {
		const isUserMsg = item.kind === "event" && item.e.event.type === "run-started";
		const isTerminal = item.kind === "event" && (item.e.event.type === "run-finished" || item.e.event.type === "run-failed" || item.e.event.type === "plan-ready");
		// A completed assistant message ends the current worked segment and
		// renders top-level — each iteration is msg → worked → msg → worked.
		const isMsg =
			(item.kind === "stream" && item.streamKind === "assistant" && item.done) ||
			(item.kind === "event" && item.e.event.type === "assistant-text");

		if (isUserMsg || isTerminal || isMsg) {
			if (item.kind === "event" && item.e.event.type === "run-finished" && cur) cur.done = true;
			flush();
			out.push(item);
			continue;
		}
		// Activity → accumulate into worked card.
		if (!cur) {
			cur = { kind: "worked", items: [], runId: item.kind === "event" ? item.e.runId : item.runId, added: 0, removed: 0, done: false, key: `w-${item.key}` };
		}
		if (item.kind === "event" && item.e.event.type === "tool-started") {
			cur.items.push({ kind: "terminal", name: String(item.e.event.name), input: item.e.event.input, toolId: String(item.e.event.id ?? ""), key: item.key, runId: item.e.runId });
			continue;
		}
		if (item.kind === "event" && item.e.event.type === "tool-finished") {
			// Pair with its started terminal card.
			const t = [...cur.items].reverse().find((x) => x.kind === "terminal" && x.toolId === String(item.e.event.id ?? ""));
			if (t && t.kind === "terminal") {
				t.output = String(item.e.event.output ?? "");
				t.ok = item.e.event.ok !== false;
				t.durationMs = Number(item.e.event.durationMs ?? 0);
			}
			continue;
		}
		if (item.kind === "event" && item.e.event.type === "file-changed") {
			cur.added += Number(item.e.event.added ?? 0);
			cur.removed += Number(item.e.event.removed ?? 0);
		}
		cur.items.push(item);
	}
	flush();
	return out;
}

/** Terminal-style tool card: `$ command` header, output body, duration + status. */
function Terminal({ item }: { item: Extract<Item, { kind: "terminal" }> }) {
	const inp = item.input as Record<string, unknown> | undefined;
	const cmd = item.name === "run_command" ? String(inp?.command ?? "") : `${item.name} ${toolInput(item.input)}`;
	const [open, setOpen] = useState(item.output === undefined);
	return (
		<div className="term">
			<button className="term-head" onClick={() => setOpen((v) => !v)}>
				<span className="caret">{open ? "▾" : "▸"}</span>
				<span className="term-cmd mono">${cmd.length > 120 ? `${cmd.slice(0, 120)}…` : cmd}</span>
				<span className="term-meta">
					{item.output !== undefined && (item.ok === false ? <span className="term-err">err</span> : null)}
					{item.durationMs !== undefined && <span className="muted">{fmtDur(item.durationMs)}</span>}
				</span>
			</button>
			{open && <pre className="term-out">{(item.output ?? "").slice(0, 4000) || "…"}</pre>}
		</div>
	);
}

/** Editor-style diff card: filename header + colored added/removed lines. */
function FileDiff({ e }: { e: RunEvent }) {
	const ev = e.event;
	const diff = String(ev.diff ?? "");
	const lines = diff.split("\n").slice(0, 200);
	return (
		<div className="filediff">
			<div className="filediff-head mono">
				± {String(ev.path)}
				<span className="fd-stats">
					{ev.added != null && <span className="fd-add">+{String(ev.added)}</span>}
					{ev.removed != null && <span className="fd-del">−{String(ev.removed)}</span>}
				</span>
			</div>
			{diff && (
				<pre className="fd-body">
					{lines.map((l, i) => (
						<div key={i} className={l.startsWith("+") ? "fd-l-add" : l.startsWith("-") ? "fd-l-del" : "fd-l-ctx"}>{l}</div>
					))}
					{diff.split("\n").length > 200 && <div className="muted">…truncated…</div>}
				</pre>
			)}
		</div>
	);
}

function fmtDur(ms: number): string {
	const s = Math.max(1, Math.round(ms / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function WorkedCard({ block, run, children }: { block: Worked; run?: RunDoc; children: React.ReactNode }) {
	const live = !block.done && run && ["running", "queued"].includes(run.status ?? "");
	const dur =
		run?.durationMs ??
		(run?.createdAt && run?.finishedAt
			? new Date(run.finishedAt).getTime() - new Date(run.createdAt).getTime()
			: run?.createdAt
				? Date.now() - new Date(run.createdAt).getTime()
				: 0);
	const [open, setOpen] = useState(!!live);
	useEffect(() => setOpen(!!live), [live]);
	return (
		<div className="worked">
			<button className="worked-head" onClick={() => setOpen((v) => !v)}>
				<span className="caret">{open ? "▾" : "▸"}</span>
				Worked{block.done && dur > 0 ? ` for ${fmtDur(dur)}` : ""}
				{(block.added > 0 || block.removed > 0) && (
					<span className="worked-diff"> +{block.added} −{block.removed}</span>
				)}
			</button>
			{open && <div className="worked-body">{children}</div>}
		</div>
	);
}

export function Timeline({ user, sessionId, events, runs }: { user: User; sessionId: string; events: RunEvent[]; runs: RunDoc[] }) {
	const items = fold(events);
	const byRun = new Map(runs.map((r) => [r.runId, r]));
	const renderItem = (item: Item) => {
		if (item.kind === "stream") {
			if (item.streamKind === "reasoning") {
				// Thought stream: dim small text while live, collapses once done.
				return item.done ? (
					<details key={item.key} className="ev thinking">
						<summary>Thought process</summary>
						<Md text={item.text} />
					</details>
				) : (
					<div key={item.key} className="ev thinking streaming">
						<div className="ev-kind">Thinking…</div>
						<span className="stream-text">{item.text}</span>
						<span className="stream-cursor" />
					</div>
				);
			}
			return item.done ? (
				<div key={item.key} className="ev assistant">
					<div className="ev-kind">Kronyx</div>
					<Md text={item.text} />
				</div>
			) : (
				<div key={item.key} className="ev assistant streaming">
					<div className="ev-kind">Kronyx</div>
					<span className="stream-text">{item.text}</span>
					<span className="stream-cursor" />
				</div>
			);
		}
		if (item.kind === "terminal") return <Terminal key={item.key} item={item} />;
		if (item.kind === "event" && item.e.event.type === "file-changed" && item.e.event.diff)
			return <FileDiff key={item.key} e={item.e} />;
		return <Event key={item.key} user={user} sessionId={sessionId} e={item.e} />;
	};

	const grouped = blocks(items);
	// Dedupe display-level repeats: retry runs often replay identical replies /
	// empty worked cards — collapse consecutive identical blocks.
	const seen: Block[] = [];
	const seenSigs = new Set<string>();
	for (const b of grouped) {
		const sig =
			b.kind === "worked"
				? `w:${b.items.length}:${b.added}:${b.removed}:${b.items.map((i) => (i.kind === "event" ? i.e.seq : i.key)).join(",")}`
				: b.kind === "stream"
					? `s:${b.streamKind}:${b.text.slice(0, 120)}`
					: b.kind === "event"
						? `e:${b.e.runId}:${b.e.seq}`
						: `t:${b.key}`;
		// Dedupe identical content anywhere (retries replay same reply/work).
		if (b.kind !== "event" && seenSigs.has(sig)) continue;
		seenSigs.add(sig);
		seen.push(b);
	}
	return (
		<div className="timeline">
			{items.length === 0 && <div className="muted" style={{ padding: 20 }}>Waiting for events…</div>}
			{seen.map((b) =>
				b.kind === "worked" ? (
					<WorkedCard key={b.key} block={b} run={b.runId ? byRun.get(b.runId) : undefined}>
						{b.items.map(renderItem)}
					</WorkedCard>
				) : (
					renderItem(b)
				),
			)}
		</div>
	);
}
