"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Empty } from "@/components/Empty";
import { Skeleton } from "@/components/Skeleton";
import { StatusPill } from "@/components/StatusPill";
import { apiFetch, useUser } from "@/lib/api";
import { fmtDur } from "@/lib/usage";

const fmtTime = (at?: string | null) => (at ? new Date(at).toLocaleTimeString() : "—");
const ACTIVE = new Set(["queued", "claimed", "running", "stopping"]);

interface Job {
	jobId: string;
	runId: string;
	kind: string;
	mode: string | null;
	status: string;
	task: string | null;
	sessionId: string | null;
	session: { sessionId: string; title?: string; repo?: string } | null;
	claimedBy: string | null;
	claimedAt: string | null;
	heartbeatAt: string | null;
	leaseUntil: string | null;
	createdAt: string | null;
	finishedAt: string | null;
	error: string | null;
	stale: boolean;
}

function jobRow(
	j: Job,
	busy: string | null,
	stop: (j: Job) => void,
	requeue: (j: Job) => void,
) {
	const started = j.claimedAt ?? j.createdAt;
	const durMs = started ? (j.finishedAt ? new Date(j.finishedAt).getTime() : Date.now()) - new Date(started).getTime() : 0;
	return (
		<tr key={j.jobId}>
			<td>
				{j.sessionId ? (
					<Link href={`/sessions/${j.sessionId}`} className="rowlink">
						{j.task || j.session?.title || "(untitled)"}
					</Link>
				) : (
					j.task || "(untitled)"
				)}
				{j.error && <div className="muted small">{j.error}</div>}
			</td>
			<td className="muted">{j.kind !== "run" ? j.kind : (j.mode ?? "—")}</td>
			<td>
				<StatusPill status={j.status} />
				{j.stale && <span className="pill pill-stale">stale</span>}
			</td>
			<td className="muted">{j.claimedBy ?? "—"}</td>
			<td className="muted">{fmtTime(started)}</td>
			<td className="muted" title={j.leaseUntil ? `lease until ${new Date(j.leaseUntil).toLocaleTimeString()}` : undefined}>
				{fmtTime(j.heartbeatAt)}
			</td>
			<td className="num">{fmtDur(durMs)}</td>
			<td>
				{ACTIVE.has(j.status) && (
					<button className="btn sm danger" disabled={busy === j.jobId} onClick={() => stop(j)}>
						Stop
					</button>
				)}
				{j.stale && (
					<button className="btn sm ghost" disabled={busy === j.jobId} onClick={() => requeue(j)}>
						Requeue
					</button>
				)}
			</td>
		</tr>
	);
}

export default function JobsPage() {
	const user = useUser();
	const [jobs, setJobs] = useState<Job[]>([]);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<string | null>(null);

	const load = useCallback(async () => {
		if (!user) return;
		const res = await apiFetch("/api/jobs", user);
		if (res.ok) setJobs(((await res.json()) as { jobs: Job[] }).jobs);
		setLoading(false);
	}, [user]);

	useEffect(() => {
		void load();
		const t = setInterval(() => void load(), 4000);
		return () => clearInterval(t);
	}, [load]);

	const act = async (j: Job, url: string) => {
		if (!user) return;
		setBusy(j.jobId);
		await apiFetch(url, user, { method: "POST" }).catch(() => {});
		await load();
		setBusy(null);
	};
	const stop = (j: Job) => void act(j, `/api/runs/${j.runId}/stop`);
	const requeue = (j: Job) => void act(j, `/api/jobs/${j.jobId}/requeue`);

	if (!user) return null;
	const live = jobs.filter((j) => ACTIVE.has(j.status) || j.stale);
	const done = jobs.filter((j) => !ACTIVE.has(j.status) && !j.stale).slice(0, 40);
	return (
		<div className="page">
			<h1>Jobs</h1>
			{loading && <Skeleton height={220} />}
			{!loading && jobs.length === 0 && <Empty>No jobs yet — launch a cloud run from a session.</Empty>}
			{live.length > 0 && (
				<>
					<h2>Live queue</h2>
					<div className="card table-card">
						<table>
							<thead>
								<tr>
									<th>Task</th><th>Mode</th><th>Status</th><th>Worker</th><th>Started</th><th>Heartbeat</th><th className="num">Duration</th><th />
								</tr>
							</thead>
							<tbody>{live.map((j) => jobRow(j, busy, stop, requeue))}</tbody>
						</table>
					</div>
				</>
			)}
			{done.length > 0 && (
				<>
					<h2>Recent</h2>
					<div className="card table-card">
						<table>
							<thead>
								<tr>
									<th>Task</th><th>Mode</th><th>Status</th><th>Worker</th><th>Started</th><th>Finished</th><th className="num">Duration</th><th />
								</tr>
							</thead>
							<tbody>{done.map((j) => jobRow(j, busy, stop, requeue))}</tbody>
						</table>
					</div>
				</>
			)}
		</div>
	);
}
