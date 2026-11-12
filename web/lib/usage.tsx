"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, useUser } from "@/lib/api";

export interface UsageCall {
	at: string;
	status: string;
	provider: string;
	baseUrl: string;
	model: string;
	keyLabel: string;
	device?: string;
	tokensIn: number;
	tokensOut: number;
	cacheRead: number;
	cacheWrite?: number;
	reasoningTokens?: number;
	billedCostUsd?: number | null;
	iteration?: number | null;
	contextMsgs?: number | null;
	kind?: string;
	op?: string;
	costUsd: number | null;
	durationMs: number;
	runId?: string;
	session?: string;
	uid?: string;
}

export const RANGES = [
	{ label: "1h", ms: 3_600_000 },
	{ label: "24h", ms: 86_400_000 },
	{ label: "7d", ms: 604_800_000 },
	{ label: "30d", ms: 2_592_000_000 },
	{ label: "All", ms: 0 },
];

export const fmtCost = (c: number | null) =>
	c === null ? "—" : c === 0 ? "$0" : `$${c < 0.01 ? c.toFixed(4) : c.toFixed(2)}`;
export const fmtDur = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`);
export function ago(iso?: string): string {
	if (!iso) return "";
	const s = (Date.now() - new Date(iso).getTime()) / 1000;
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}
export const host = (u: string) => {
	try {
		return new URL(u).hostname.replace(/^www\./, "");
	} catch {
		return u;
	}
};

export function useUsageCalls(sinceMs: number, allUsers = false) {
	const user = useUser();
	const [calls, setCalls] = useState<UsageCall[]>([]);
	const [loading, setLoading] = useState(true);
	const [forbidden, setForbidden] = useState(false);
	const [userNames, setUserNames] = useState<Record<string, { name: string | null; email: string | null }>>({});

	const load = useCallback(async () => {
		if (!user) return;
		setLoading(true);
		const params = new URLSearchParams({ limit: "2000" });
		if (sinceMs > 0) params.set("since", String(Date.now() - sinceMs));
		if (allUsers) params.set("all", "1");
		const res = await apiFetch(`/api/usage?${params}`, user);
		if (res.status === 403) {
			setForbidden(true);
			setCalls([]);
		} else {
			setForbidden(false);
			if (res.ok) {
				const b = (await res.json()) as { calls: UsageCall[]; users?: Record<string, { name: string | null; email: string | null }> };
				setCalls(b.calls);
				setUserNames(b.users ?? {});
			}
		}
		setLoading(false);
	}, [user, sinceMs, allUsers]);

	useEffect(() => {
		void load();
	}, [load]);

	return { calls, loading, user, forbidden, userNames, reload: load };
}

export function RangePicker({ value, onChange }: { value: number; onChange: (ms: number) => void }) {
	return (
		<div
			style={{
				display: "flex",
				gap: 2,
				background: "var(--panel)",
				border: "1px solid var(--border)",
				borderRadius: 6,
				padding: 2,
			}}
		>
			{RANGES.map((r) => (
				<button
					key={r.label}
					className="btn ghost sm"
					style={{ border: "none", ...(r.ms === value ? { background: "var(--panel-2)" } : {}) }}
					onClick={() => onChange(r.ms)}
				>
					{r.label}
				</button>
			))}
		</div>
	);
}
