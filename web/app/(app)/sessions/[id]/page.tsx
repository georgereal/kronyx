"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Composer, type Mode } from "@/components/Composer";
import { Timeline } from "@/components/Timeline";
import { ProviderGate } from "@/components/ProviderGate";
import { StatusPill } from "@/components/StatusPill";
import { apiFetch, useUser } from "@/lib/api";
import type { RunDoc, RunEvent, SessionDoc } from "@/lib/types";

const ACTIVE = new Set(["queued", "running", "claimed"]);

interface SessionResponse {
	session: SessionDoc;
	runs: RunDoc[];
	plans: { slug: string; runId?: string }[];
}

/** /sessions/[id] — live run timeline + follow-up composer. */
export default function SessionView() {
	const user = useUser();
	const params = useParams<{ id: string }>();
	const id = params.id;
	const [session, setSession] = useState<SessionDoc | null>(null);
	const [runs, setRuns] = useState<RunDoc[]>([]);
	const [events, setEvents] = useState<RunEvent[]>([]);
	const [mode, setMode] = useState<Mode>("agent");
	const [modelId, setModelId] = useState("");
	const [modelProfile, setModelProfile] = useState("");
	const [prMsg, setPrMsg] = useState("");
	const [notFound, setNotFound] = useState(false);
	const evRef = useRef<Map<string, RunEvent>>(new Map());
	const sseRef = useRef<EventSource | null>(null);
	// Bottom-pin: window scrollbar follows new events unless the user scrolls up.
	const pinnedRef = useRef(true);

	const latestRun = runs[runs.length - 1];
	const runOrder = new Map(runs.map((r, i) => [r.runId, i]));
	const ordered = [...events].sort((a, b) => (runOrder.get(a.runId ?? "") ?? 0) - (runOrder.get(b.runId ?? "") ?? 0) || a.seq - b.seq);
	const active = !!latestRun && ACTIVE.has(latestRun.status ?? "");
	// Latest run's setup/lifecycle events — surfaced as a top strip so clone,
	// credential refresh, branch sync, push, and PR steps are always visible.
	const lifecycle = events
		.filter((e) => ["info", "cloud-status", "setup", "check"].includes(e.event.type))
		.slice(-8);
	// Session preflight — sandbox / repo / auth / model readiness, fetched once
	// on load and after each refresh-triggering action.
	const [preflight, setPreflight] = useState<{ ready: boolean; checks: { name: string; ok: boolean; detail: string }[] } | null>(null);
	useEffect(() => {
		if (!user || !session) return;
		void apiFetch(`/api/sessions/${id}/preflight`, user, { method: "POST" })
			.then(async (r) => (r.ok ? r.json() : { ready: false, checks: [{ name: "preflight", ok: false, detail: `HTTP ${r.status}` }] }))
			.then((body) => setPreflight(body as typeof preflight))
			.catch((err) => setPreflight({ ready: false, checks: [{ name: "preflight", ok: false, detail: String(err).slice(0, 80) }] }));
	}, [user, id, session?.sessionId]);

	// Clear "PR queued" once the PR link actually lands.
	useEffect(() => {
		if (session?.prUrl) setPrMsg("");
	}, [session?.prUrl]);

	const pushEvents = useCallback((list: { seq: number; event: RunEvent["event"] }[], runId?: string) => {
		if (!list.length) return;
		const map = evRef.current;
		for (const e of list) map.set(`${runId ?? "x"}:${e.seq}`, { runId, seq: e.seq, event: e.event });
		setEvents([...map.values()]);
	}, []);

	// Session fetch: once on mount, then only while a run is active or we just
	// submitted (waiting for the run doc to appear). Idle → zero requests.
	const pendingRun = useRef(false);
	const refresh = useCallback(async () => {
		if (!user) return;
		const res = await apiFetch(`/api/sessions/${id}`, user);
		if (res.status === 404) return setNotFound(true);
		if (!res.ok) return;
		const body = (await res.json()) as SessionResponse;
		setSession(body.session);
		setRuns(body.runs);
	}, [user, id]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		if (!user) return;
		if (!active && !pendingRun.current) return;
		const t = setInterval(() => void refresh(), 4000);
		return () => clearInterval(t);
	}, [user, active, refresh]);

	useEffect(() => {
		if (latestRun) pendingRun.current = false;
	}, [latestRun]);

	// PlanCard implement/push queue runs without the Composer — listen and
	// pick them up so the stream opens live.
	useEffect(() => {
		const onQueue = () => {
			pendingRun.current = true;
			void refresh();
		};
		window.addEventListener("kronyx:refresh-session", onQueue);
		return () => window.removeEventListener("kronyx:refresh-session", onQueue);
	}, [refresh]);

	// Track the window scrollbar: unpinned while scrolling up, re-pins at bottom.
	const pageHeight = () => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
	const toBottom = () => window.scrollTo({ top: pageHeight(), behavior: "auto" });

	useEffect(() => {
		const onScroll = () => {
			pinnedRef.current = window.scrollY + window.innerHeight >= pageHeight() - 40;
		};
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Follow the tail on every event batch while pinned. Deferred + repeated
	// because content (markdown/code blocks) keeps growing after the first paint.
	useEffect(() => {
		if (!pinnedRef.current) return;
		requestAnimationFrame(toBottom);
		const timers = [150, 400, 900].map((ms) => setTimeout(toBottom, ms));
		return () => timers.forEach(clearTimeout);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [events]);

	// Finished runs: load each newest window (last 2000) — older pages fetch on scroll-up.
	const loadedRuns = useRef<Set<string>>(new Set());
	// runId → oldest loaded seq + whether earlier events exist.
	const historyRef = useRef<Map<string, { oldest: number; hasMore: boolean }>>(new Map());
	const fetchingMore = useRef(false);
	useEffect(() => {
		if (!user) return;
		for (const r of runs) {
			if (ACTIVE.has(r.status ?? "") || loadedRuns.current.has(r.runId)) continue;
			loadedRuns.current.add(r.runId);
			void (async () => {
				const res = await apiFetch(`/api/sessions/${id}/events?run=${r.runId}`, user);
				if (!res.ok) return;
				const body = (await res.json()) as { events: RunEvent[]; hasMore?: boolean };
				pushEvents(body.events, r.runId);
				if (body.events.length) {
					historyRef.current.set(r.runId, { oldest: body.events[0].seq, hasMore: !!body.hasMore });
				}
			})();
		}
	}, [user, id, runs, pushEvents]);

	// Reverse fetch: scrolling to the top pulls the older 2000-event window and
	// prepends it while preserving the visual position.
	useEffect(() => {
		if (!user) return;
		const onScroll = async () => {
			if (window.scrollY > 150 || fetchingMore.current) return;
			const target = [...historyRef.current.entries()].find(([, h]) => h.hasMore);
			if (!target) return;
			const [runId, h] = target;
			fetchingMore.current = true;
			const prevH = document.documentElement.scrollHeight;
			try {
				const res = await apiFetch(`/api/sessions/${id}/events?run=${runId}&before=${h.oldest}`, user);
				if (!res.ok) return;
				const body = (await res.json()) as { events: RunEvent[]; hasMore?: boolean };
				if (body.events.length) {
					pushEvents(body.events, runId);
					historyRef.current.set(runId, { oldest: body.events[0].seq, hasMore: !!body.hasMore });
					requestAnimationFrame(() => {
						window.scrollTo({ top: window.scrollY + (document.documentElement.scrollHeight - prevH) });
					});
				} else {
					historyRef.current.set(runId, { ...h, hasMore: false });
				}
			} finally {
				fetchingMore.current = false;
			}
		};
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, [user, id, pushEvents]);

	// Active run: SSE stream with token query (EventSource can't set headers); poll fallback on error.
	useEffect(() => {
		if (!user || !latestRun || !active) return;
		const runId = latestRun.runId;
		let closed = false;
		let pollTimer: ReturnType<typeof setInterval> | undefined;
		void (async () => {
			const token = await user.getIdToken();
			if (closed) return;
			const es = new EventSource(`/api/sessions/${id}/events?run=${runId}&stream=1&token=${encodeURIComponent(token)}`);
			sseRef.current = es;
			es.onmessage = (m) => {
				const data = JSON.parse(m.data) as { type: string; seq?: number; event?: RunEvent["event"]; run?: RunDoc };
				if (data.type === "event" && data.seq !== undefined && data.event) {
					pushEvents([{ seq: data.seq, event: data.event }], runId);
				}
			};
			es.onerror = () => {
				es.close();
				// Fallback to polling.
				let after = 0;
				pollTimer = setInterval(() => {
					void (async () => {
						const res = await apiFetch(`/api/sessions/${id}/events?run=${runId}&after=${after}`, user);
						if (!res.ok) return;
						const body = (await res.json()) as { events: RunEvent[] };
						pushEvents(body.events, runId);
						if (body.events.length) after = body.events[body.events.length - 1].seq;
					})();
				}, 3000);
			};
		})();
		return () => {
			closed = true;
			sseRef.current?.close();
			if (pollTimer) clearInterval(pollTimer);
		};
	}, [user, id, latestRun?.runId, active, pushEvents]);

	const submit = async (task: string, attachmentIds: string[]) => {
		if (!user) return;
		await apiFetch(`/api/sessions/${id}/messages`, user, {
			method: "POST",
			body: JSON.stringify({ task, mode, attachmentIds, modelId: modelId || undefined, profile: modelProfile || undefined }),
		});
		// Poll until the new run doc appears so the stream opens.
		pendingRun.current = true;
		setTimeout(() => void refresh(), 500);
	};

	const stop = async () => {
		if (!user || !latestRun) return;
		await apiFetch(`/api/runs/${latestRun.runId}/stop`, user, { method: "POST" });
	};

	if (!user) return null;
	if (notFound) return <div className="page">Session not found.</div>;

	const tokens = runs.reduce(
		(acc, r) => ({ in: acc.in + (r.tokensIn ?? 0), out: acc.out + (r.tokensOut ?? 0) }),
		{ in: 0, out: 0 },
	);

	return (
		<ProviderGate user={user}>
		<div className="page" style={{ maxWidth: 860 }}>
			<div style={{ position: "sticky", top: 0, zIndex: 10, background: "var(--bg)", paddingBottom: 8, borderBottom: "1px solid var(--border)", marginBottom: 8 }}>
			<div className="sess-header">
				<Link href="/sessions" className="muted" style={{ fontSize: 12 }}>← Sessions</Link>
				<h1 style={{ flex: 1, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
					{session?.title ?? "Session"}
				</h1>
				{latestRun && <StatusPill status={latestRun.status ?? "queued"} />}
				{latestRun?.status === "queued" && (
					<button className="btn sm" onClick={async () => {
						await apiFetch(`/api/runs/${latestRun.runId}/stop`, user, { method: "POST" });
						void refresh();
					}}>Cancel</button>
				)}
			</div>
			<div className="sess-header" style={{ marginTop: -8 }}>
				{session?.repo && <span className="sess-chip mono">{session.repo}</span>}
				{session?.branch && <span className="sess-chip mono">⎇ {session.branch}</span>}
				{session?.template && <span className="sess-chip">{session.template}</span>}
				{session?.prUrl ? (
					<a href={session.prUrl} target="_blank" rel="noreferrer" className="sess-chip" style={{ color: "var(--accent)" }}>
						PR ↗
					</a>
				) : session?.branch && !active ? (
					<button className="sess-chip" style={{ cursor: "pointer", color: "var(--accent)" }}
						onClick={async () => {
							const res = await apiFetch(`/api/sessions/${id}/pr`, user, { method: "POST" });
							if (res.ok) {
								setPrMsg("PR queued");
								pendingRun.current = true;
								setTimeout(() => void refresh(), 500);
							} else {
								const body = (await res.json().catch(() => ({}))) as { error?: string };
								setPrMsg(`PR failed: ${body.error ?? res.status}`);
							}
						}}>
						Raise PR
					</button>
				) : null}
				{prMsg && <span className="sess-chip muted">{prMsg}</span>}
				{(tokens.in || tokens.out) > 0 && (
					<span className="sess-chip muted">{tokens.in.toLocaleString()} in / {tokens.out.toLocaleString()} out</span>
				)}
			</div>
			{preflight && (
				<div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6, fontSize: 11 }}>
					{preflight.checks.map((c) => (
						<span key={c.name} className="sess-chip muted" style={{ color: c.ok ? "var(--ok, #4ade80)" : "var(--err)" }} title={c.detail}>
							{c.ok ? "✓" : "✗"} {c.name}: {c.detail}
						</span>
					))}
					{!preflight.ready && <span className="sess-chip" style={{ color: "var(--err)" }}>fix in Settings before running</span>}
				</div>
			)}
			{lifecycle.length > 0 && (
				<details style={{ marginTop: 6, fontSize: 11 }} open={active}>
					<summary className="muted" style={{ cursor: "pointer" }}>
						Status log ({lifecycle.length}) — {String(lifecycle[lifecycle.length - 1].event.text ?? "")}
					</summary>
					<div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}>
						{lifecycle.map((e, i) => (
							<div key={i} className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
								{e.event.type === "check" ? (
									<span style={{ color: e.event.ok === false ? "var(--err)" : "var(--ok, #4ade80)" }}>
										{e.event.ok === false ? "✗" : "✓"}
									</span>
								) : (
									<span style={{ color: "var(--accent)" }}>●</span>
								)}
								<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
									{String(e.event.text ?? e.event.command ?? "")}
									{e.event.type === "check" && e.event.output ? ` — ${String(e.event.output)}` : ""}
								</span>
							</div>
						))}
					</div>
				</details>
			)}
			</div>
			<Timeline user={user} sessionId={id} events={ordered} runs={runs} />
			<div className="composer-dock">
				<Composer
					user={user}
					mode={mode}
					onMode={setMode}
					onSubmit={(t, a) => void submit(t, a)}
					onStop={() => void stop()}
					running={active}
					slim
					onModel={(id, profile) => { setModelId(id); setModelProfile(profile); }}
				/>
			</div>
		</div>
		</ProviderGate>
	);
}
