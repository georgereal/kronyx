"use client";

import type { User } from "firebase/auth";
import { GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

const SKIP_KEY = "kronyx.gitProviderSkipped";

/**
 * First-run gate: if the user has no Git provider connected (no app
 * installation covering any repo), show the provider-connect screen before
 * the sessions UI. "Skip for now" persists in localStorage.
 */
export function ProviderGate({ user, children }: { user: User; children: React.ReactNode }) {
	const [state, setState] = useState<"loading" | "blocked" | "ok">("loading");
	const [appSlug, setAppSlug] = useState("kronyx");

	useEffect(() => {
		if (localStorage.getItem(SKIP_KEY)) return setState("ok");
		void (async () => {
			const res = await apiFetch("/api/github/repos", user).catch(() => null);
			if (!res?.ok) return setState("ok"); // don't block on API errors
			const body = (await res.json()) as { repos?: unknown[]; appSlug?: string };
			if (body.appSlug) setAppSlug(body.appSlug);
			setState((body.repos ?? []).length > 0 ? "ok" : "blocked");
		})();
	}, [user]);

	if (state === "loading") return <div className="skeleton" style={{ width: 360, height: 220, margin: "12vh auto" }} />;
	if (state === "blocked") {
		return (
			<main className="center-page">
				<div className="card auth-card">
					<div className="logo"><GitBranch size={22} /></div>
					<h1>Connect your Git provider</h1>
					<p className="tagline-sub" style={{ maxWidth: 320 }}>
						Connect your repositories so Kronyx can clone, branch, and open PRs for you.
					</p>
					<a href={`https://github.com/apps/${appSlug}/installations/new`} style={{ display: "block" }}>
						<button className="btn w-full" style={{ justifyContent: "center", marginBottom: 8 }}>
							Connect GitHub
						</button>
					</a>
					<button className="btn ghost w-full" style={{ justifyContent: "center", marginBottom: 8 }} disabled title="Coming soon">
						Connect GitLab
					</button>
					<button className="btn ghost w-full" style={{ justifyContent: "center" }} disabled title="Coming soon">
						Connect Bitbucket
					</button>
					<p className="auth-foot" style={{ marginTop: 16 }}>
						<button
							className="btn ghost sm"
							onClick={() => {
								localStorage.setItem(SKIP_KEY, "1");
								setState("ok");
							}}
						>
							Skip for now
						</button>
					</p>
				</div>
			</main>
		);
	}
	return <>{children}</>;
}
