"use client";

import { CheckCircle2, MonitorSmartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { useUser, apiFetch } from "@/lib/api";

const VSCODE_URI = (key: string) => `vscode://kronyx.kronyx/auth?key=${encodeURIComponent(key)}`;

/** /connect — mints a Kronyx API key and hands it to the extension. */
export default function ConnectPage() {
	const router = useRouter();
	const user = useUser();
	const [key, setKey] = useState("");
	const [error, setError] = useState("");

	useEffect(() => {
		if (user === null) router.replace("/login?next=/connect");
	}, [user, router]);

	useEffect(() => {
		if (!user) return;
		void (async () => {
			const res = await apiFetch("/api/keys", user, {
				method: "POST",
				body: JSON.stringify({ label: "vscode-extension" }),
			});
			if (res.ok) setKey(((await res.json()) as { key: string }).key);
			else setError("Could not create an API key.");
		})();
	}, [user]);

	if (!user) return null;
	return (
		<main className="center-page">
			<div className="card auth-card">
				<div className="logo">
					{key ? <CheckCircle2 size={22} /> : <MonitorSmartphone size={22} />}
				</div>
				<h1>Connect your editor</h1>
				{error && <p style={{ color: "var(--err)" }}>{error}</p>}
				{key ? (
					<>
						<p className="tagline-sub" style={{ maxWidth: 300 }}>
							One click sends a connection key to Kronyx in your editor — you&apos;re done.
						</p>
						<a href={VSCODE_URI(key)}>
							<button className="btn w-full" style={{ justifyContent: "center" }}>
								Connect in VS Code
							</button>
						</a>
						<p className="auth-foot" style={{ marginTop: 20 }}>
							Nothing happened? Run <strong>Kronyx: Sign in</strong> in the editor and paste the key manually:
						</p>
						<div className="key-reveal" style={{ textAlign: "left", fontSize: 12 }}>
							{key.slice(0, 10)}…{key.slice(-6)}
						</div>
						<CopyButton text={key} label="Copy key" />
					</>
				) : (
					!error && <p className="tagline-sub">Preparing your key…</p>
				)}
			</div>
			<div className="card auth-card" style={{ marginTop: 16 }}>
				<h1 style={{ fontSize: 15 }}>Connect your Git provider</h1>
				<p className="tagline-sub" style={{ marginBottom: 14 }}>So cloud sessions can clone, push and open PRs.</p>
				<a href="/settings" style={{ display: "block" }}>
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
			</div>
		</main>
	);
}
