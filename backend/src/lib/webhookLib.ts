import { createHmac, timingSafeEqual } from "node:crypto";

/** Pure helpers for the webhooks handler — kept dependency-free so tests can
 *  import them without pulling the route table (and its DOM-type deps). */

/** `{{dot.path}}` lookups into the payload; missing → empty string. */
export function renderTemplate(template: string, payload: unknown): string {
	return template.replace(/\{\{\s*([\w.[\]-]+)\s*\}\}/g, (_m, path: string) => {
		let cur: unknown = payload;
		for (const seg of path.replace(/\[(\d+)\]/g, ".$1").split(".")) {
			if (cur === null || typeof cur !== "object") return "";
			cur = (cur as Record<string, unknown>)[seg];
		}
		return cur === undefined || cur === null ? "" : typeof cur === "object" ? JSON.stringify(cur) : String(cur);
	});
}

const segRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

/** Every `path: glob` filter entry must match the payload (`*` = anything). */
export function matchFilter(filter: Record<string, string> | undefined, payload: unknown): boolean {
	if (!filter || !Object.keys(filter).length) return true;
	for (const [path, glob] of Object.entries(filter)) {
		let cur: unknown = payload;
		for (const seg of path.split(".")) {
			if (cur === null || typeof cur !== "object") return false;
			cur = (cur as Record<string, unknown>)[seg];
		}
		if (cur === undefined || !segRe(glob).test(String(cur))) return false;
	}
	return true;
}

/** Constant-time compare of `sha256=<hex>` signatures. */
export function verifySignature(secret: string, body: string, header: string | null): boolean {
	if (!header?.startsWith("sha256=")) return false;
	const want = createHmac("sha256", secret).update(body).digest("hex");
	const got = header.slice(7);
	if (got.length !== want.length) return false;
	return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

export const KRONYX_LABEL = "kronyx";

export interface GithubPayload {
	action?: string;
	repository?: { full_name?: string; default_branch?: string };
	installation?: { id?: number };
	issue?: { number?: number; title?: string; body?: string; pull_request?: unknown };
	label?: { name?: string };
	comment?: { body?: string; user?: { login?: string } };
	sender?: { login?: string };
}

/** Build the agent task for a supported GitHub event; null = ignore. */
export function githubTask(event: string, p: GithubPayload): string | null {
	if (event === "issues" && p.action === "labeled" && p.label?.name === KRONYX_LABEL && p.issue && !p.issue.pull_request) {
		return (
			`GitHub issue #${p.issue.number} on ${p.repository?.full_name} was labeled "kronyx" — implement it.\n\n` +
			`Title: ${p.issue.title}\n\n${(p.issue.body ?? "").slice(0, 4000)}\n\n` +
			`Open a pull request with the fix when done.`
		);
	}
	if (event === "issue_comment" && p.action === "created" && p.comment?.body?.includes(`@${KRONYX_LABEL}`)) {
		const ask = p.comment.body.replace(new RegExp(`@${KRONYX_LABEL}`, "g"), "").trim();
		if (!ask) return null;
		const on = p.issue?.pull_request ? `pull request` : `issue`;
		return (
			`On ${on} #${p.issue?.number} ("${p.issue?.title ?? ""}") of ${p.repository?.full_name}, ` +
			`@${p.comment.user?.login ?? "someone"} asks:\n\n${ask.slice(0, 4000)}\n\n` +
			`Do the work and open a pull request (or answer in your summary if it's a question).`
		);
	}
	return null;
}
