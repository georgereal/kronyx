"use client";

import { signOut } from "firebase/auth";
import {
	BarChart3,
	ChevronsLeft,
	KeyRound,
	LogOut,
	Menu,
	Plus,
	Box,
	Settings,
	History,
	Home,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, useUser } from "@/lib/api";
import { getFirebaseAuth } from "@/lib/firebase";
import type { SessionDoc } from "@/lib/types";

const COLLAPSE_KEY = "kronyx.sidebarCollapsed";

const TABS = [
	{ href: "/sessions", label: "Sessions", icon: <History size={14} /> },
	{ href: "/", label: "Overview", icon: <Home size={14} /> },
	{ href: "/usage", label: "Usage", icon: <BarChart3 size={14} /> },
	{ href: "/sandboxes", label: "Sandboxes", icon: <Box size={14} /> },
	{ href: "/keys", label: "API Keys", icon: <KeyRound size={14} /> },
	{ href: "/settings", label: "Settings", icon: <Settings size={14} /> },
];

function ago(iso?: string): string {
	if (!iso) return "";
	const s = (Date.now() - new Date(iso).getTime()) / 1000;
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

export function Shell({ children }: { children: React.ReactNode }) {
	const user = useUser();
	const router = useRouter();
	const pathname = usePathname();
	const [sessions, setSessions] = useState<SessionDoc[]>([]);
	const [collapsed, setCollapsed] = useState(false);
	const [navOpen, setNavOpen] = useState(false);

	useEffect(() => {
		if (user === null) router.replace("/login");
	}, [user, router]);

	useEffect(() => {
		setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
	}, []);

	useEffect(() => {
		if (!user) return;
		let alive = true;
		const tick = async () => {
			const res = await apiFetch("/api/sessions", user);
			if (!alive || !res.ok) return;
			const body = (await res.json()) as { sessions: SessionDoc[] };
			setSessions(body.sessions);
			setTimeout(() => void tick(), 5 * 60_000);
		};
		void tick();
		return () => {
			alive = false;
		};
	}, [user, pathname]);

	const toggle = () => {
		setCollapsed((c) => {
			localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
			return !c;
		});
	};

	if (!user) {
		return (
			<main className="center-page">
				<div className="skeleton" style={{ width: 360, height: 220 }} />
			</main>
		);
	}

	const dot = (s: SessionDoc) =>
		s.lastStatus === "running" || s.lastStatus === "queued" ? "running"
		: s.lastStatus === "completed" ? "completed"
		: s.lastStatus === "failed" ? "failed"
		: "";

	// Sidebar is session-context only — all other pages render full-width
	// with a floating hamburger to reach the drawer.
	const showSidebar = pathname === "/sessions" || pathname.startsWith("/sessions/");

	return (
		<div className={`app-shell${collapsed ? " collapsed" : ""}`}>
			{!showSidebar && !navOpen && (
				<button className="icon-btn nav-float" onClick={() => setNavOpen(true)} title="Menu">
					<Menu size={16} />
				</button>
			)}
			{navOpen && (
				<>
					<div className="nav-backdrop" onClick={() => setNavOpen(false)} />
					<nav className="nav-drawer">
						<div className="side-top" style={{ paddingLeft: 14 }}>
							<Link href="/" className="brand" onClick={() => setNavOpen(false)}>
								<span>Kronyx</span>
							</Link>
							<button className="icon-btn" onClick={() => setNavOpen(false)}>✕</button>
						</div>
						{TABS.map((t) => (
							<Link key={t.href} href={t.href}
								className={`side-tab${pathname === t.href ? " active" : ""}`}
								onClick={() => setNavOpen(false)}>
								{t.icon} <span>{t.label}</span>
							</Link>
						))}
					</nav>
				</>
			)}
			{showSidebar && <aside className="sidebar">
				<div className="side-top">
					<button className="icon-btn" onClick={() => setNavOpen(true)} title="Menu">
						<Menu size={15} />
					</button>
					<Link href="/" className="brand side-label">
						<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"
							stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M5 4v16" /><path d="M19 4l-9 8 9 8" /><circle cx="10" cy="12" r="1.5" fill="currentColor" />
						</svg>
						<span className="side-label">Kronyx</span>
					</Link>
					<button className="icon-btn collapse-btn" onClick={toggle} title={collapsed ? "Expand" : "Collapse"}>
						{/* expand uses the opposite chevron */}
						{collapsed ? <ChevronsLeft size={15} style={{ transform: "rotate(180deg)" }} /> : <ChevronsLeft size={15} />}
					</button>
				</div>

				<Link href="/sessions" className="btn side-new">
					<Plus size={13} /> <span className="side-label">New session</span>
				</Link>

				<div className="side-section" style={{ marginTop: 4, borderTop: "none" }}>
					<div className="side-section-head side-label">Sessions</div>
					<div className="side-sessions">
						{sessions.length === 0 && <div className="side-empty side-label">No sessions yet</div>}
						{sessions.map((s) => (
							<Link
								key={s.sessionId}
								href={`/sessions/${s.sessionId}`}
								className={`side-sess${pathname === `/sessions/${s.sessionId}` ? " active" : ""}`}
								title={s.title ?? s.sessionId}
							>
								<span className={`dot ${dot(s)}`} />
								<span className="side-label sess-title">{s.title ?? s.repo ?? "Session"}</span>
								<span className="side-label sess-ago">{ago(s.updatedAt)}</span>
							</Link>
						))}
					</div>
				</div>

				<div className="side-foot">
					<button className="user-chip" onClick={() => void signOut(getFirebaseAuth())} title="Sign out">
						{user.photoURL && <img src={user.photoURL} alt="" />}
						<span className="side-label">{user.displayName ?? user.email ?? user.uid}</span>
						<LogOut size={14} />
					</button>
				</div>
			</aside>}
			<main className="container">{children}</main>
		</div>
	);
}
