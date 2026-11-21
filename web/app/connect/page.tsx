"use client";

import { CheckCircle2, MonitorSmartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CopyButton } from "@/components/CopyButton";
import { useUser, apiFetch } from "@/lib/api";

const VSCODE_URI = (key: string, id: string) =>
	`vscode://kronyx.kronyx/auth?key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}`;

/** /connect — mints a Kronyx API key and hands it to the extension. */
export default function ConnectPage() {
	return (
		<Suspense>
			<Connect />
		</Suspense>
	);
}

function Connect() {
	const router = useRouter();
	const search = useSearchParams();
	const user = useUser();
	const [key, setKey] = useState("");
	const [keyId, setKeyId] = useState("");
	const [error, setError] = useState("");

	// The IDE passes its device id so the key is labeled per-editor and the
	// previous key for this device is replaced, not accumulated.
	const device = search.get("device")?.replace(/[^\w-]/g, "").slice(0, 40) ?? "";
	const deviceName = search.get("name")?.slice(0, 60) ?? "";
	const label = device ? `vscode-${device}` : "vscode-extension";

	useEffect(() => {
		if (user === null) router.replace(`/login?next=${encodeURIComponent(`/connect${device ? `?device=${device}&name=${encodeURIComponent(deviceName)}` : ""}`)}`);
	}, [user, router, device, deviceName]);

	useEffect(() => {
		if (!user) return;
		void (async () => {
			const res = await apiFetch("/api/keys", user, {
				method: "POST",
				body: JSON.stringify({ label, replace: true }),
			});
			if (!res.ok) return setError("Could not create an API key.");
			const body = (await res.json()) as { key: string; id: string };
			setKey(body.key);
			setKeyId(body.id);
			// Hand the key to the editor automatically — same account, no paste.
			window.location.href = VSCODE_URI(body.key, body.id);
		})();
		// eslint-disable-next-line react-hooks/exhaustive-deps
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
							You&apos;re signed in — Kronyx is connecting to your editor{deviceName ? ` (${deviceName})` : ""}. You can close this window.
						</p>
						<a href={VSCODE_URI(key, keyId)}>
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
		</main>
	);
}
