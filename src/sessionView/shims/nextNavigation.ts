/**
 * IDE substitute for `next/navigation`.
 *
 * The bundled session page only uses `useParams` (session id); router/pathname
 * stubs keep any incidental usage from crashing and forward navigations to the
 * host via `__kronyxPost` so links land in the real dashboard instead.
 */

let params: Record<string, string> = {};

export function setSessionParams(next: Record<string, string>): void {
	params = next;
}

declare global {
	// Injected by the webview entry; forwards to the extension host.
	// eslint-disable-next-line no-var
	var __kronyxPost: ((msg: unknown) => void) | undefined;
}

function nav(href: string): void {
	globalThis.__kronyxPost?.({ type: "nav", href });
}

export function useParams<T extends Record<string, string>>(): T {
	return params as T;
}

export function usePathname(): string {
	return params.id ? `/sessions/${params.id}` : "/";
}

export function useRouter(): { push: (href: string) => void; replace: (href: string) => void; back: () => void; refresh: () => void } {
	return {
		push: nav,
		replace: nav,
		back: () => nav("/sessions"),
		refresh: () => {},
	};
}

export function useSearchParams(): URLSearchParams {
	return new URLSearchParams("");
}
