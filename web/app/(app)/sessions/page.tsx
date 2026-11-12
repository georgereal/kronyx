"use client";

import { GitBranch } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Composer, emptyEnv, type EnvState, type Mode } from "@/components/Composer";
import { Modal } from "@/components/Modal";
import { ProviderGate } from "@/components/ProviderGate";
import { apiFetch, useUser } from "@/lib/api";
import type { SessionDoc } from "@/lib/types";

const ENV_KEY = "kronyx.env";

interface SavedEnv {
	repo: string;
	base: string;
	installationId: number;
}

interface Repo {
	repo: string;
	defaultBranch: string;
	installationId: number;
}

interface Installation {
	id: number;
	account: string;
	type: string;
}

function ago(iso?: string): string {
	if (!iso) return "";
	const s = (Date.now() - new Date(iso).getTime()) / 1000;
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

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
	const [lastSession, setLastSession] = useState<SessionDoc | null>(null);
	const [repoModal, setRepoModal] = useState(false);
	const [repos, setRepos] = useState<Repo[]>([]);
	const [installations, setInstallations] = useState<Installation[]>([]);
	const [appSlug, setAppSlug] = useState("");
	const [repoQuery, setRepoQuery] = useState("");
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const [newOrg, setNewOrg] = useState(0);
	const [createErr, setCreateErr] = useState("");
	const [createBusy, setCreateBusy] = useState(false);
	const [addingUrl, setAddingUrl] = useState(false);
	const [addUrl, setAddUrl] = useState("");
	const [addWaiting, setAddWaiting] = useState("");
	const [addErr, setAddErr] = useState("");
	const [pending, setPending] = useState<{ task: string; attachmentIds: string[] } | null>(null);

	useEffect(() => {
		if (!user) return;
		void apiFetch("/api/sessions", user).then(async (res) => {
			if (!res.ok) return;
			const body = (await res.json()) as { sessions: SessionDoc[] };
			setLastSession(body.sessions?.[0] ?? null);
		});
	}, [user]);

	// Restore last-used repo once, validated against installed repos.
	useEffect(() => {
		if (!user) return;
		const raw = localStorage.getItem(ENV_KEY);
		if (!raw) return;
		let saved: SavedEnv;
		try {
			saved = JSON.parse(raw) as SavedEnv;
		} catch {
			localStorage.removeItem(ENV_KEY);
			return;
		}
		void apiFetch("/api/github/repos", user).then(async (res) => {
			if (!res.ok) return;
			const { repos } = (await res.json()) as { repos: Repo[] };
			const match = (repos ?? []).find((r) => r.repo === saved.repo && r.installationId === saved.installationId);
			if (!match) {
				localStorage.removeItem(ENV_KEY);
				return;
			}
			setEnv((e) => (e.repo ? e : { ...e, repo: match.repo, base: match.defaultBranch, installationId: match.installationId }));
		});
	}, [user]);

	if (!user) return null;

	const refreshRepos = async () => {
		const res = await apiFetch("/api/github/repos", user).catch(() => null);
		if (!res?.ok) return;
		const body = (await res.json()) as { repos: Repo[]; installations?: Installation[]; appSlug?: string };
		setRepos(body.repos ?? []);
		const insts = body.installations ?? [];
		setInstallations(insts);
		setNewOrg((cur) => cur || insts.find((i) => i.type === "Organization")?.id || 0);
		if (body.appSlug) setAppSlug(body.appSlug);
	};

	const pickRepo = (r: Repo) => {
		const next: EnvState = { ...env, repo: r.repo, base: r.defaultBranch, startRef: "", prLabel: "", installationId: r.installationId };
		setEnv(next);
		setRepoModal(false);
		if (pending) {
			const p = pending;
			setPending(null);
			void start(p.task, p.attachmentIds, next);
		}
	};

	const createRepo = async () => {
		if (!newOrg || !newName.trim() || createBusy) return;
		setCreateBusy(true);
		setCreateErr("");
		const res = await apiFetch("/api/github/create-repo", user, {
			method: "POST",
			body: JSON.stringify({ installationId: newOrg, name: newName.trim(), private: true }),
		});
		const body = (await res.json().catch(() => ({}))) as { repo?: Repo; error?: string };
		setCreateBusy(false);
		if (!res.ok || !body.repo) {
			setCreateErr(body.error ?? "Could not create repository");
			return;
		}
		void refreshRepos();
		pickRepo(body.repo);
	};

	const parseRepoUrl = (v: string) =>
		v.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/\/.*$/, "");

	const resolveRepo = async () => {
		const repo = parseRepoUrl(addUrl);
		if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
			setAddErr("Enter owner/repo or a GitHub URL");
			return;
		}
		setAddErr("");
		const res = await apiFetch("/api/github/resolve", user, {
			method: "POST",
			body: JSON.stringify({ repo }),
		});
		const body = (await res.json().catch(() => ({}))) as {
			covered?: boolean;
			repo?: Repo;
			installUrl?: string;
			error?: string;
		};
		if (res.ok && body.covered && body.repo) {
			void refreshRepos();
			pickRepo(body.repo);
			return;
		}
		if (res.ok && body.installUrl) {
			setAddWaiting(body.installUrl);
			return;
		}
		setAddErr(body.error ?? "Could not resolve that repo");
	};

	const submit = async (task: string, attachmentIds: string[]) => {
		if (mode !== "ask" && !env.repo) {
			setPending({ task, attachmentIds });
			setRepoModal(true);
			await refreshRepos();
			return;
		}
		await start(task, attachmentIds, env);
	};

	const start = async (task: string, attachmentIds: string[], e: EnvState, m: Mode = mode) => {
		setBusy(true);
		setError("");
		const res = await apiFetch("/api/sessions", user, {
			method: "POST",
			body: JSON.stringify({
				repo: e.repo,
				base: e.base,
				startRef: e.startRef || e.base,
				mode: m,
				modelId: modelId || undefined,
				profile: modelProfile || undefined,
				title: task.slice(0, 80),
				template: e.template || undefined,
				extraRepos: e.extraRepos,
				securityProfile: e.securityProfile,
			}),
		});
		if (!res.ok) {
			setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not create session");
			setBusy(false);
			return;
		}
		if (e.repo && e.installationId) {
			const saved: SavedEnv = { repo: e.repo, base: e.base, installationId: e.installationId };
			localStorage.setItem(ENV_KEY, JSON.stringify(saved));
		}
		const { session } = (await res.json()) as { session: { sessionId: string } };
		await apiFetch(`/api/sessions/${session.sessionId}/messages`, user, {
			method: "POST",
			body: JSON.stringify({ task, mode: m, attachmentIds, modelId: modelId || undefined, profile: modelProfile || undefined }),
		});
		router.push(`/sessions/${session.sessionId}`);
	};

	return (
		<ProviderGate user={user}>
		<div className="composer-wrap">
			{lastSession && (
				<Link
					href={`/sessions/${lastSession.sessionId}`}
					className="card"
					style={{ display: "block", padding: "10px 14px", marginBottom: 18, fontSize: 12.5, textDecoration: "none" }}
				>
					<span className="muted">Resume — </span>
					{lastSession.title ?? lastSession.repo ?? "Session"}
					<span className="muted"> · {ago(lastSession.updatedAt)}</span>
				</Link>
			)}
			<div style={{ textAlign: "center", marginBottom: 28 }}>
				<h1 style={{ fontSize: 22 }}>Kronyx</h1>
				<p className="muted" style={{ fontSize: 13 }}>
					{mode === "ask"
						? "Ask questions — no sandbox needed"
						: mode === "multi"
							? "Describe a task — parallel agents split the work and merge into one PR"
							: "Describe a task — Kronyx works in a cloud sandbox and opens a PR"}
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
		{repoModal && (
			<Modal
				title="Select a repository"
				onClose={() => {
					setRepoModal(false);
					setPending(null);
					setAddingUrl(false);
					setAddWaiting("");
					setAddErr("");
					setCreating(false);
					setCreateErr("");
				}}
			>
				<p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
					Kronyx clones this repo into a cloud sandbox and opens a PR against it.
				</p>
				<input
					className="pop-search"
					style={{ width: "100%", margin: "0 0 8px" }}
					placeholder="Search repos…"
					value={repoQuery}
					onChange={(ev) => setRepoQuery(ev.target.value)}
					autoFocus
				/>
				<div className="pop-scroll" style={{ maxHeight: 320 }}>
					{repos
						.filter((r) => r.repo.toLowerCase().includes(repoQuery.toLowerCase()))
						.map((r) => (
							<button
								key={`${r.installationId}:${r.repo}`}
								className="pop-item"
								onClick={() => pickRepo(r)}
							>
								<GitBranch size={13} />
								<span className="mono" style={{ flex: 1 }}>{r.repo}</span>
								<span className="right">{r.defaultBranch}</span>
							</button>
						))}
					{repos.length === 0 && (
						<div className="pop-item disabled">
							No repos — <Link href="/connect" style={{ color: "var(--accent)" }}>connect GitHub</Link>
						</div>
					)}
				</div>
				{!addingUrl && !addWaiting && (
					<button
						className="pop-item"
						style={{ borderTop: "1px solid var(--border)", marginTop: 6 }}
						onClick={() => setAddingUrl(true)}
					>
						<span style={{ flex: 1, color: "var(--accent)" }}>Add a repo by URL…</span>
					</button>
				)}
				{addingUrl && !addWaiting && (
					<div style={{ borderTop: "1px solid var(--border)", marginTop: 6, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
						<div className="muted" style={{ fontSize: 11 }}>
							Repo under another account or org — paste its URL and we&apos;ll get access
						</div>
						<div style={{ display: "flex", gap: 8 }}>
							<input
								className="pop-search"
								style={{ margin: 0, flex: 1 }}
								placeholder="owner/repo or https://github.com/owner/repo"
								value={addUrl}
								autoFocus
								onChange={(ev) => setAddUrl(ev.target.value)}
								onKeyDown={(ev) => ev.key === "Enter" && void resolveRepo()}
							/>
							<button className="btn sm" onClick={() => void resolveRepo()}>Add</button>
							<button className="btn ghost sm" onClick={() => { setAddingUrl(false); setAddErr(""); }}>Cancel</button>
						</div>
						{addErr && <div style={{ color: "var(--err)", fontSize: 11.5 }}>{addErr}</div>}
					</div>
				)}
				{addWaiting && (
					<div style={{ borderTop: "1px solid var(--border)", marginTop: 6, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
						<div className="muted" style={{ fontSize: 12 }}>
							We don&apos;t have access to <span className="mono">{parseRepoUrl(addUrl)}</span> yet. Grant the Kronyx app
							access on GitHub (org installs may need an admin&apos;s approval), then check again.
						</div>
						<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
							<a href={addWaiting} target="_blank" rel="noreferrer" className="btn sm">Grant access on GitHub ↗</a>
							<button className="btn ghost sm" onClick={() => void resolveRepo()}>Check again</button>
							<span style={{ flex: 1 }} />
							<button className="btn ghost sm" onClick={() => setAddWaiting("")}>Back</button>
						</div>
						{addErr && <div style={{ color: "var(--err)", fontSize: 11.5 }}>{addErr}</div>}
					</div>
				)}
				{installations.some((i) => i.type === "Organization") && !creating && (
					<button className="pop-item" style={{ borderTop: "1px solid var(--border)", marginTop: 6 }} onClick={() => setCreating(true)}>
						<span style={{ flex: 1, color: "var(--accent)" }}>+ New private repository…</span>
					</button>
				)}
				{creating && (
					<div style={{ borderTop: "1px solid var(--border)", marginTop: 6, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
						<div className="muted" style={{ fontSize: 11 }}>Create a private repo in an organization</div>
						<div style={{ display: "flex", gap: 8 }}>
							<select
								className="pop-search"
								style={{ margin: 0, width: 140 }}
								value={newOrg}
								onChange={(ev) => setNewOrg(Number(ev.target.value))}
							>
								{installations.filter((i) => i.type === "Organization").map((i) => (
									<option key={i.id} value={i.id}>{i.account}</option>
								))}
							</select>
							<input
								className="pop-search"
								style={{ margin: 0, flex: 1 }}
								placeholder="repo-name"
								value={newName}
								onChange={(ev) => setNewName(ev.target.value)}
							/>
						</div>
						{createErr && <div style={{ color: "var(--err)", fontSize: 11.5 }}>{createErr}</div>}
						<div style={{ display: "flex", gap: 8 }}>
							<button className="btn sm" disabled={!newName.trim() || createBusy} onClick={() => void createRepo()}>
								{createBusy ? "Creating…" : "Create & use"}
							</button>
							<button className="btn ghost sm" onClick={() => { setCreating(false); setCreateErr(""); }}>
								Cancel
							</button>
						</div>
					</div>
				)}
				<div className="actions" style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
					{appSlug && repos[0] && (
						<a
							href={`https://github.com/apps/${appSlug}/installations/${repos[0].installationId}`}
							target="_blank"
							rel="noreferrer"
							style={{ fontSize: 12 }}
						>
							Manage repo access on GitHub ↗
						</a>
					)}
					<button className="btn ghost sm" onClick={() => void refreshRepos()}>
						Refresh
					</button>
					<span style={{ flex: 1 }} />
					<button
						className="btn ghost sm"
						onClick={() => {
							setRepoModal(false);
							setMode("ask");
							if (pending) {
								const p = pending;
								setPending(null);
								void start(p.task, p.attachmentIds, emptyEnv, "ask");
							}
						}}
					>
						Continue in Ask mode instead
					</button>
				</div>
			</Modal>
		)}
		</ProviderGate>
	);
}
