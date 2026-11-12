"use client";

import { onAuthStateChanged, type User } from "firebase/auth";
import { useEffect, useState } from "react";
import { getFirebaseAuth } from "@/lib/firebase";

/** Current Firebase user: undefined = loading, null = signed out. */
export function useUser(): User | null | undefined {
	const [user, setUser] = useState<User | null | undefined>(undefined);
	useEffect(() => onAuthStateChanged(getFirebaseAuth(), setUser), []);
	return user;
}

/** RBAC role from /api/me — gates admin-only UI. */
export function useRole(user: User | null | undefined): string {
	const [role, setRole] = useState("");
	useEffect(() => {
		if (!user) return setRole("");
		void apiFetch("/api/me", user)
			.then((r) => (r.ok ? r.json() : {}))
			.then((b) => setRole(typeof (b as { role?: string }).role === "string" ? (b as { role: string }).role : "user"))
			.catch(() => setRole("user"));
	}, [user]);
	return role;
}

/** fetch with the user's Firebase ID token attached. */
export async function apiFetch(path: string, user: User, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${await user.getIdToken()}`);
	if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
	return fetch(path, { ...init, headers });
}
