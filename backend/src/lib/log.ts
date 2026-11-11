const DEBUG = process.env.BACKEND_DEBUG === "1";

export function dbg(scope: string, msg: string, extra?: unknown): void {
	if (!DEBUG) return;
	const suffix = extra === undefined ? "" : ` ${JSON.stringify(extra).slice(0, 400)}`;
	console.log(`[dbg:${scope}] ${msg}${suffix}`);
}

/** Always-on error log — for catches that fall back but must not stay silent. */
export function errlog(scope: string, msg: string, err: unknown): void {
	console.error(`[${scope}] ${msg}:`, err instanceof Error ? err.message : err);
}

/** Drop-in for `.catch(() => <or>)` — logs the error, then returns the fallback. */
export function swallow(scope: string, msg: string): (err: unknown) => undefined;
export function swallow<T>(scope: string, msg: string, or: T): (err: unknown) => T;
export function swallow<T>(scope: string, msg: string, or?: T) {
	return (err: unknown): T | undefined => {
		errlog(scope, msg, err);
		return or;
	};
}
