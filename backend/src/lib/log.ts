const DEBUG = process.env.BACKEND_DEBUG === "1";

export function dbg(scope: string, msg: string, extra?: unknown): void {
	if (!DEBUG) return;
	const suffix = extra === undefined ? "" : ` ${JSON.stringify(extra).slice(0, 400)}`;
	console.log(`[dbg:${scope}] ${msg}${suffix}`);
}
