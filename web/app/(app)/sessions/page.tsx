"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Composer, emptyEnv, type EnvState, type Mode } from "@/components/Composer";
import { ProviderGate } from "@/components/ProviderGate";
import { apiFetch, useUser } from "@/lib/api";

/** /sessions — Devin-style new-session landing. */
export default function SessionsLanding() {
	const user = useUser();
	const router = useRouter();
	const [mode, setMode] = useState<Mode>("agent");
	const [env, setEnv] = useState<EnvState>(emptyEnv);
	const [modelId, setModelId] = useState("");
	const [modelProfile, setModelProfile] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	if (!user) return null;

	const submit = async (task: string, attachmentIds: string[]) => {
		if (mode !== "ask" && !env.repo) {
			setError("Pick a repository (environment menu) — or switch to Ask mode.");
			return;
		}
		setBusy(true);
		setError("");
		const res = await apiFetch("/api/sessions", user, {
			method: "POST",
			body: JSON.stringify({
				repo: env.repo,
				base: env.base,
				mode,
				modelId: modelId || undefined,
				profile: modelProfile || undefined,
				title: task.slice(0, 80),
				template: env.template || undefined,
				extraRepos: env.extraRepos,
				securityProfile: env.securityProfile,
			}),
		});
		if (!res.ok) {
			setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not create session");
			setBusy(false);
			return;
		}
		const { session } = (await res.json()) as { session: { sessionId: string } };
		await apiFetch(`/api/sessions/${session.sessionId}/messages`, user, {
			method: "POST",
			body: JSON.stringify({ task, mode, attachmentIds, modelId: modelId || undefined, profile: modelProfile || undefined }),
		});
		router.push(`/sessions/${session.sessionId}`);
	};

	return (
		<ProviderGate user={user}>
		<div className="composer-wrap">
			<div style={{ textAlign: "center", marginBottom: 28 }}>
				<h1 style={{ fontSize: 22 }}>Kronyx</h1>
				<p className="muted" style={{ fontSize: 13 }}>
					{mode === "ask" ? "Ask questions — no sandbox needed" : "Describe a task — Kronyx works in a cloud sandbox and opens a PR"}
				</p>
			</div>
			<Composer
				user={user}
				mode={mode}
				onMode={setMode}
				env={env}
				onEnv={setEnv}
				onSubmit={(t, a) => void submit(t, a)}
				running={busy}
				autoFocus
				onModel={(id, profile) => { setModelId(id); setModelProfile(profile); }}
			/>
			{error && <p style={{ color: "var(--err)", marginTop: 10, fontSize: 12.5 }}>{error}</p>}
		</div>
		</ProviderGate>
	);
}
