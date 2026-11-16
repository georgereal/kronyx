"use client";

import { eventColor, eventLabel, fmtDur, fmtTick, segments, stats, type LifecycleEvent } from "@/lib/sandboxLifecycle";

const fmtDate = (ts: number) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * Lifecycle overview matching the sandbox UX mockup: stat cards, a single
 * segmented duration-timeline bar (running / paused / terminated) on a real
 * time axis, and an Event activity list. Used on the sandbox detail page and
 * inside expanded rows on the list page.
 */
export function SandboxLifecycle({ events, createdAt, compact }: { events: LifecycleEvent[]; createdAt?: string; compact?: boolean }) {
	const evs = events
		.filter((e) => e.at && !Number.isNaN(Date.parse(e.at)))
		.slice()
		.sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!));
	if (!evs.length) return <div className="muted" style={{ fontSize: 11, padding: "8px 0" }}>No lifecycle events recorded.</div>;

	const segs = segments(evs, createdAt);
	const st = stats(segs);
	const t0 = segs[0]?.from ?? Date.parse(evs[0].at!);
	const t1 = segs[segs.length - 1]?.to ?? t0 + 1;
	const span = Math.max(t1 - t0, 1);
	const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => t0 + f * span);

	const cards: { icon: string; label: string; value: string }[] = [
		{ icon: "◷", label: "Total lifetime", value: fmtDur(st.totalMs) },
		{ icon: "▶", label: "Running", value: fmtDur(st.runningMs) },
		{ icon: "❚❚", label: "Paused", value: fmtDur(st.pausedMs) },
		{ icon: "⇄", label: "Pause periods", value: String(st.pausePeriods) },
		{ icon: "⛔", label: "Terminated", value: st.terminatedAt ? fmtDate(st.terminatedAt) : "—" },
	];

	return (
		<div className="sbx-life">
			<div className="sbx-life-main">
				<div className="sbx-stats">
					{cards.map((c) => (
						<div key={c.label} className="sbx-stat">
							<span className="sbx-stat-icon">{c.icon}</span>
							<span className="sbx-stat-body">
								<span className="sbx-stat-label">{c.label}</span>
								<span className="sbx-stat-value">{c.value}</span>
							</span>
						</div>
					))}
				</div>

				<div className="sbx-bar-head">
					<span className="chart-title" style={{ margin: 0 }}>Lifecycle timeline</span>
					<span className="sbx-legend">
						<span><i className="dot run" /> Running</span>
						<span><i className="dot pause" /> Paused</span>
						<span><i className="dot dead" /> Terminated</span>
					</span>
				</div>
				<div className="sbx-bar">
					{segs.map((s, i) => {
						const pct = ((s.to - s.from) / span) * 100;
						const show = pct >= 7 && !compact;
						return (
							<div
								key={i}
								className={`seg ${s.state}`}
								style={{ width: `${Math.max(pct, 0.8)}%` }}
								title={`${s.state} · ${fmtDate(s.from)} → ${fmtDate(s.to)} · ${fmtDur(s.to - s.from)}`}
							>
								{show && fmtDur(s.to - s.from)}
							</div>
						);
					})}
				</div>
				<div className="sbx-axis">
					{ticks.map((t, i) => (
						<span key={i} style={{ left: `${((t - t0) / span) * 100}%` }}>{fmtTick(t)}</span>
					))}
				</div>
			</div>

			<div className="sbx-activity">
				<div className="chart-title" style={{ marginBottom: 8 }}>Event activity ({evs.length})</div>
				<div className="sbx-activity-list">
					{evs.map((e, i) => (
						<div key={i} className="sbx-activity-row">
							<span className="dot" style={{ background: eventColor(e.event) }} />
							<span className="name">
								{eventLabel(e)}
								{e.reason ? <span className="muted"> ({e.reason})</span> : null}
							</span>
							<span className="t">{fmtTick(Date.parse(e.at!))}</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
