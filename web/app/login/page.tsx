"use client";

import { signInWithPopup } from "firebase/auth";
import { Activity, KeyRound, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { SiGithub } from "react-icons/si";
import { getFirebaseAuth, getGithubProvider } from "@/lib/firebase";

function Logo({ size = 24 }: { size?: number }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width={size}
			height={size}
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
	);
}

export default function LoginPage() {
	const router = useRouter();
	return (
		<main className="landing">
			<section>
				<div className="hero-eyebrow">Kronyx</div>
				<h1 className="hero-title">From Prompts to Production.</h1>
				<p className="hero-sub">
					Transforms developer intent into production-ready software through intelligent agentic engineering.
				</p>
				<div className="hero-feats">
					<div className="hero-feat">
						<Sparkles size={15} />
						<span>
							<b>Agentic coding in your editor.</b> Plan, act, verify — full run timelines, not black boxes.
						</span>
					</div>
					<div className="hero-feat">
						<KeyRound size={15} />
						<span>
							<b>Bring your own keys.</b> Any OpenAI-compatible provider — your models, your terms.
						</span>
					</div>
					<div className="hero-feat">
						<Activity size={15} />
						<span>
							<b>Learns from every run.</b> Project memory, eval gates and feedback loops that get sharper
							with use.
						</span>
					</div>
				</div>
				<p className="hero-myth">
					Named for <b>Cronus (Κρόνος)</b>, the Titan of time and cosmic order — power, orchestration,
					autonomy, control.
				</p>
			</section>
			<div className="card auth-card" style={{ width: "100%", maxWidth: 380, justifySelf: "end" }}>
				<div className="logo">
					<Logo size={24} />
				</div>
				<h1>Kronyx</h1>
				<p className="tagline-sub">Sign in to your account</p>
				<button
					className="btn w-full"
					style={{ justifyContent: "center" }}
					onClick={async () => {
						await signInWithPopup(getFirebaseAuth(), getGithubProvider());
						const next = new URLSearchParams(window.location.search).get("next") ?? "/";
						router.replace(next.startsWith("/") ? next : "/");
					}}
				>
					<SiGithub size={15} />
					Continue with GitHub
				</button>
			</div>
		</main>
	);
}
