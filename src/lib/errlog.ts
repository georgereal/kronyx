/**
 * Shared always-on error logging for vscode-free modules (bundled into the
 * backend worker — cannot import vscode or backend code here).
 */
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
