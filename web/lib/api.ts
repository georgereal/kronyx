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

/** fetch with the user's Firebase ID token attached. */
export async function apiFetch(path: string, user: User, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${await user.getIdToken()}`);
	if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
	return fetch(path, { ...init, headers });
}
