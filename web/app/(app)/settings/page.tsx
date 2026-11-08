"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { apiFetch, useUser } from "@/lib/api";

const SECRET_FIELDS = [
	{ key: "e2bApiKey", label: "E2B API key", hint: "Runs the cloud sandboxes" },
	{ key: "githubToken", label: "GitHub token", hint: "Fallback when no app installation" },
];

interface Profile {
	name: string;
	providerId: string;
	baseUrl: string;
	modelId: string;
	key: string; // blank = keep synced value
	keySynced: boolean;
}

interface SettingsDoc {
	data?: {
		providerId?: string;
		baseUrl?: string;
		modelId?: string;
		activeProfile?: string;
		profiles?: { name?: string; providerId?: string; baseUrl?: string; modelId?: string }[];
	};
	secrets?: Record<string, string>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
	return (
		<div className="settings-field">
			<div className="settings-label">
				<span>{label}</span>
				{hint && <span className="muted">{hint}</span>}
			</div>
			{children}
		</div>
	);
}

const emptyProfile = (): Profile => ({ name: "", providerId: "", baseUrl: "", modelId: "", key: "", keySynced: false });

/** /settings — BYOK profiles + shared secrets; synced to editors at point-of-need. */
export default function SettingsPage() {
	const user = useUser();
	const [profiles, setProfiles] = useState<Profile[]>([]);
	const [activeProfile, setActiveProfile] = useState("");
	const [secrets, setSecrets] = useState<Record<string, string>>({});
	const [msg, setMsg] = useState("");

	useEffect(() => {
		if (!user) return;
		void (async () => {
			const res = await apiFetch("/api/settings", user);
			if (!res.ok) return;
			const { settings } = (await res.json()) as { settings?: SettingsDoc };
			const synced = settings?.secrets ?? {};
			setProfiles(
				(settings?.data?.profiles ?? []).map((p) => ({
					name: p.name ?? "",
					providerId: p.providerId ?? "",
					baseUrl: p.baseUrl ?? "",
					modelId: p.modelId ?? "",
					key: "",
					keySynced: `profile.apiKey.${p.name}` in synced,
				})),
			);
			setActiveProfile(settings?.data?.activeProfile ?? "");
			setSecrets(
				Object.fromEntries(
					SECRET_FIELDS.map((f) => [f.key, ""]).concat(
						Object.keys(synced).filter((k) => !k.startsWith("profile.apiKey.") && !SECRET_FIELDS.some((f) => f.key === k)).map((k) => [k, ""]),
					),
				),
			);
		})();
		// Bind a GitHub App installation after the install redirect (?installation=<id>).
		const installId = new URLSearchParams(window.location.search).get("installation");
		if (installId) {
			void (async () => {
				await apiFetch("/api/github/link", user, { method: "POST", body: JSON.stringify({ installationId: Number(installId) }) });
				window.history.replaceState({}, "", "/settings");
				setGithubLinked(true);
			})();
		}
		void apiFetch("/api/github/repos", user).then(async (r) => {
			if (r.ok) setGithubLinked((((await r.json()) as { repos?: unknown[] }).repos ?? []).length > 0);
		});
	}, [user]);

	const [githubLinked, setGithubLinked] = useState(false);
	const appSlug = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG || "kronyx";

	const setProfile = (i: number, patch: Partial<Profile>) =>
		setProfiles((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

	const save = async () => {
		if (!user) return;
		setMsg("Saving…");
		const res = await apiFetch("/api/settings", user, {
			method: "PUT",
			body: JSON.stringify({
				version: 1,
				data: {
					activeProfile,
					profiles: profiles.map(({ name, providerId, baseUrl, modelId }) => ({ name, providerId, baseUrl, modelId })),
				},
				secrets: {
					...Object.fromEntries(profiles.filter((p) => p.name && p.key).map((p) => [`profile.apiKey.${p.name}`, p.key])),
					...Object.fromEntries(Object.entries(secrets).filter(([, v]) => v)),
				},
			}),
		});
		setMsg(res.ok ? "Saved — synced at next point-of-need." : "Save failed.");
	};

	if (!user) return null;
	return (
		<div className="page" style={{ maxWidth: 680 }}>
			<h1>Settings</h1>
			<p className="muted" style={{ fontSize: 13, marginBottom: 20 }}>
				BYOK provider profiles + shared secrets — synced to your editors at point-of-need.
			</p>

			<div className="card" style={{ padding: 20, marginBottom: 16 }}>
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
					<div className="chart-title">Provider profiles</div>
					<button className="btn ghost sm" onClick={() => setProfiles([...profiles, emptyProfile()])}>
						<Plus size={13} /> Add profile
					</button>
				</div>
				{profiles.length === 0 && <p className="muted" style={{ fontSize: 12 }}>No profiles — add one to define a BYOK provider + model + key.</p>}
				{profiles.map((p, i) => (
					<div key={i} className="profile-card">
						<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
							<input className="input" style={{ width: 180, fontWeight: 600 }} placeholder="profile name" value={p.name} onChange={(e) => setProfile(i, { name: e.target.value })} />
							<button className="btn ghost sm" onClick={() => setProfiles(profiles.filter((_, j) => j !== i))}>
								<Trash2 size={13} />
							</button>
						</div>
						<div className="profile-grid">
							<Field label="Provider ID"><input className="input" value={p.providerId} onChange={(e) => setProfile(i, { providerId: e.target.value })} placeholder="vercel" /></Field>
							<Field label="Model"><input className="input mono" value={p.modelId} onChange={(e) => setProfile(i, { modelId: e.target.value })} placeholder="anthropic/claude-sonnet-4.6" /></Field>
						</div>
						<Field label="Base URL"><input className="input mono" value={p.baseUrl} onChange={(e) => setProfile(i, { baseUrl: e.target.value })} placeholder="https://ai-gateway.vercel.sh/v1" /></Field>
						<Field label="API key" hint={p.keySynced ? "synced — blank to keep" : "per-profile key"}>
							<input className="input mono" type="password" value={p.key} onChange={(e) => setProfile(i, { key: e.target.value })} placeholder={p.keySynced ? "(synced — blank to keep)" : "set to sync"} />
						</Field>
					</div>
				))}
				<Field label="Active profile" hint="which profile runs by default">
					<select className="input" value={activeProfile} onChange={(e) => setActiveProfile(e.target.value)}>
						<option value="">(default)</option>
						{profiles.filter((p) => p.name).map((p) => (
							<option key={p.name} value={p.name}>{p.name}</option>
						))}
					</select>
				</Field>
			</div>

			<div className="card" style={{ padding: 20, marginBottom: 16 }}>
				<div className="chart-title" style={{ marginBottom: 4 }}>GitHub access</div>
				<p className="muted" style={{ fontSize: 12, marginBottom: 14 }}>
					{githubLinked
						? "App installed — cloud runs can clone/push/PR on your repos."
						: "Install the Kronyx GitHub App on your repos so cloud runs can work on them (scoped, revocable)."}
				</p>
				{githubLinked ? (
					<span style={{ color: "var(--ok)", fontSize: 13 }}>✓ Enabled</span>
				) : (
					<a className="btn ghost" href={`https://github.com/apps/${appSlug}/installations/new`} target="_blank" rel="noreferrer">
						Enable GitHub access
					</a>
				)}
			</div>
			<div className="card" style={{ padding: 20, marginBottom: 20 }}>
				<div className="chart-title" style={{ marginBottom: 4 }}>Shared secrets</div>
				<p className="muted" style={{ fontSize: 12, marginBottom: 14 }}>Stored server-side (opt-in). Blank keeps the synced value.</p>
				{SECRET_FIELDS.map((f) => (
					<Field key={f.key} label={f.label} hint={f.hint}>
						<input
							className="input mono"
							type="password"
							placeholder={f.key in secrets ? "(synced — blank to keep)" : "set to sync"}
							value={secrets[f.key] ?? ""}
							onChange={(e) => setSecrets({ ...secrets, [f.key]: e.target.value })}
						/>
					</Field>
				))}
			</div>

			<div style={{ display: "flex", gap: 12, alignItems: "center" }}>
				<button className="btn primary" onClick={() => void save()}>Save settings</button>
				<span className="muted" style={{ fontSize: 12 }}>{msg}</span>
			</div>
		</div>
	);
}
