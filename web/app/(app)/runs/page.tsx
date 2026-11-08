"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Empty } from "@/components/Empty";
import { Skeleton } from "@/components/Skeleton";
import { StatusPill } from "@/components/StatusPill";
import { apiFetch, useUser } from "@/lib/api";
import { fmtDur } from "@/lib/usage";
import { fmtTok } from "@/components/AreaChart";

const fmtTime = (at?: number) => (at ? new Date(at).toLocaleString() : "—");

interface Run {
	runId: string;
	task?: string;
	session?: string;
	status?: string;
	durationMs?: number;
	at?: number;
	tokensIn?: number;
	tokensOut?: number;
	pr?: { url?: string; title?: string; status?: string } | null;
}

export default function RunsPage() {
	const user = useUser();
	const [runs, setRuns] = useState<Run[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		if (!user) return;
		void (async () => {
			const res = await apiFetch("/api/runs", user);
			if (res.ok) setRuns(((await res.json()) as { runs: Run[] }).runs);
			setLoading(false);
		})();
	}, [user]);

	if (!user) return null;
	return (
		<div className="page">
			<h1>Cloud runs</h1>
			{loading && <Skeleton height={220} />}
			{!loading && runs.length === 0 && <Empty>No cloud runs yet — launch one from the Kronyx sidebar.</Empty>}
			{runs.length > 0 && (
				<div className="card table-card">
					<table>
						<thead>
							<tr>
								<th>Task</th>
								<th>Status</th>
								<th>Started</th>
								<th className="num">Duration</th>
								<th className="num">Tokens</th>
								<th>PR</th>
							</tr>
						</thead>
						<tbody>
							{runs.map((r) => (
								<tr key={r.runId}>
									<td>
										<Link href={`/runs/${r.runId}`} className="rowlink">
											{r.task || "(untitled run)"}
										</Link>
									</td>
									<td><StatusPill status={r.status === "completed" ? "200" : "failed"} /></td>
									<td className="muted">{fmtTime(r.at)}</td>
									<td className="num">{fmtDur(r.durationMs ?? 0)}</td>
									<td className="num">{fmtTok((r.tokensIn ?? 0) + (r.tokensOut ?? 0))}</td>
									<td>
										{r.pr?.url ? (
											<a className="rowlink" href={r.pr.url} target="_blank" rel="noreferrer">
												{r.pr.status ?? "open"} ↗
											</a>
										) : (
											<span className="muted">—</span>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
