export interface LifecycleEvent {
	event?: string;
	state?: string;
	reason?: string;
	/** Boot provenance set on `boot` events. */
	source?: string;
	template?: string;
	snapshotId?: string;
	at?: string;
}

export type LifeState = "running" | "paused" | "dead";

export interface LifeSegment {
	state: LifeState;
	from: number;
	to: number;
}

export interface LifeStats {
	totalMs: number;
	runningMs: number;
	pausedMs: number;
	pausePeriods: number;
	terminatedAt?: number;
}

export function stateOf(e: LifecycleEvent): LifeState {
	if (e.state === "paused" || e.event === "pause") return "paused";
	if (e.state === "dead" || e.event === "kill" || e.event === "stop") return "dead";
	return "running"; // start / connect / resume / resume-disk / fork / checkpoint …
}

/** Contiguous state intervals across the sandbox's lifetime. */
export function segments(events: LifecycleEvent[], createdAt?: string, now = Date.now()): LifeSegment[] {
	const evs = events
		.filter((e) => e.at && !Number.isNaN(Date.parse(e.at)))
		.slice()
		.sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!));
	if (!evs.length) return [];
	const t0 = Date.parse(createdAt ?? "") || Date.parse(evs[0].at!);
	const last = Date.parse(evs[evs.length - 1].at!);
	const live = stateOf(evs[evs.length - 1]) !== "dead";
	const end = live ? Math.max(now, last) : last;
	// Interval before the first event is "running" (created → first transition).
	const segs: LifeSegment[] = [];
	let prevState: LifeState = "running";
	let prevT = t0;
	for (const e of evs) {
		const t = Math.max(prevT, Date.parse(e.at!));
		if (t > prevT) segs.push({ state: prevState, from: prevT, to: t });
		prevState = stateOf(e);
		prevT = t;
	}
	if (end > prevT) segs.push({ state: prevState, from: prevT, to: end });
	// Merge zero-length and consecutive same-state segments.
	const out: LifeSegment[] = [];
	for (const s of segs) {
		if (s.to <= s.from) continue;
		const last = out[out.length - 1];
		if (last && last.state === s.state && last.to === s.from) last.to = s.to;
		else out.push({ ...s });
	}
	return out;
}

export function stats(segs: LifeSegment[]): LifeStats {
	const s: LifeStats = { totalMs: 0, runningMs: 0, pausedMs: 0, pausePeriods: 0 };
	for (const seg of segs) {
		const d = seg.to - seg.from;
		s.totalMs += d;
		if (seg.state === "running") s.runningMs += d;
		if (seg.state === "paused") {
			s.pausedMs += d;
			s.pausePeriods++;
		}
		if (seg.state === "dead" && s.terminatedAt === undefined) s.terminatedAt = seg.from;
	}
	return s;
}

export function fmtDur(ms: number): string {
	if (ms < 0) ms = 0;
	const m = Math.floor(ms / 60_000);
	if (m < 1) return `${Math.floor(ms / 1000)}s`;
	const h = Math.floor(m / 60);
	if (h < 1) return `${m}m`;
	const d = Math.floor(h / 24);
	if (d < 1) return `${h}h ${m % 60}m`;
	return `${d}d ${h % 24}h ${m % 60}m`;
}

export const fmtTick = (ts: number) => {
	const d = new Date(ts);
	const today = new Date();
	const sameDay = d.toDateString() === today.toDateString();
	return d.toLocaleString([], sameDay ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

export const eventColor = (e?: string) =>
	e === "kill" || e === "stop" || e === "provider-gone" ? "var(--err)" : e === "pause" || e === "inaccessible" ? "var(--amber, #facc15)" : e === "checkpoint" ? "#60a5fa" : "var(--ok, #4ade80)";

export const BOOT_SOURCE: Record<string, string> = {
	connect: "Reused live VM",
	resume: "Resumed (memory + disk)",
	"resume-disk": "Resumed from disk",
	"resume-blind": "Resumed from disk",
	wip: "Booted from session checkpoint",
	warm: "Booted from warm snapshot",
	template: "Booted from durable template",
	base: "Booted from base image",
};

const EVENT_LABEL: Record<string, string> = {
	connect: "Reconnected — live VM",
	inaccessible: "Marked inaccessible — retained, not reused",
	"provider-gone": "Provider no longer has this sandbox",
	resume: "Resumed — memory + disk",
	"resume-disk": "Resumed — disk only (cold boot)",
};

export const eventLabel = (e: LifecycleEvent) => {
	if (e.event === "boot") return `${BOOT_SOURCE[e.source ?? ""] ?? "Booted"}${e.template ? ` · ${e.template}` : ""}`;
	const name = e.event ?? e.state ?? "event";
	return EVENT_LABEL[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
};
