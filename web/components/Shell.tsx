"use client";

import { signOut } from "firebase/auth";
import { LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useUser } from "@/lib/api";
import { getFirebaseAuth } from "@/lib/firebase";

const TABS = [
	{ href: "/", label: "Overview" },
	{ href: "/usage", label: "Usage" },
	{ href: "/runs", label: "Runs" },
	{ href: "/sandboxes", label: "Sandboxes" },
	{ href: "/keys", label: "API Keys" },
	{ href: "/settings", label: "Settings" },
];

export function Shell({ children }: { children: React.ReactNode }) {
	const user = useUser();
	const router = useRouter();
	const pathname = usePathname();

	useEffect(() => {
		if (user === null) router.replace("/login");
	}, [user, router]);

	if (!user) {
		return (
			<main className="center-page">
				<div className="skeleton" style={{ width: 360, height: 220 }} />
			</main>
		);
	}

	return (
		<>
			<nav className="shell-nav">
				<Link href="/" className="brand">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="20"
						height="20"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M5 4v16" />
						<path d="M19 4l-9 8 9 8" />
						<circle cx="10" cy="12" r="1.5" fill="currentColor" />
					</svg>
					Kronyx
				</Link>
				<nav className="nav-tabs">
					{TABS.map((t) => (
						<Link key={t.href} href={t.href} className={`nav-tab${pathname === t.href ? " active" : ""}`}>
							{t.label}
						</Link>
					))}
				</nav>
				<button className="user-chip" onClick={() => void signOut(getFirebaseAuth())} title="Sign out">
					{user.photoURL && <img src={user.photoURL} alt="" />}
					<span>{user.displayName ?? user.email ?? user.uid}</span>
					<LogOut size={14} />
				</button>
			</nav>
			<main className="container">{children}</main>
		</>
	);
}
