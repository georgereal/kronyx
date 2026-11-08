import { getApps, initializeApp } from "firebase/app";
import { getAuth, GithubAuthProvider, type Auth } from "firebase/auth";

let authInstance: Auth | undefined;

/** Lazy init — prerendering must not require env vars; only touch auth in the browser. */
export function getFirebaseAuth(): Auth {
	if (authInstance) return authInstance;
	const app = getApps().length
		? getApps()[0]
		: initializeApp({
				apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
				authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
				projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
			});
	authInstance = getAuth(app);
	return authInstance;
}

export function getGithubProvider(): GithubAuthProvider {
	const provider = new GithubAuthProvider();
	provider.addScope("user:email");
	return provider;
}
