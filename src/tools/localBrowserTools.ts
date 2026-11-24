import * as path from "node:path";
import { promises as fs } from "node:fs";
import type { AgentTool } from "@cline/shared";
import { checkUrl } from "./network";
import { WorkspaceGuard } from "./workspace";

/**
 * Host-side browser tools for IDE runs — granular actions the model drives
 * directly (open → snapshot → click/type → screenshot), not a sub-agent loop
 * like the cloud browser_use. Playwright is a lazy optional import: missing
 * it yields an honest "not installed" message rather than a hard failure.
 *
 * Element refs (`e1`, `e2`, …) are assigned per snapshot via a data attribute,
 * matching the click/type tools — same ref grammar as the snapshot the model read.
 */

interface RouteLike {
	request(): { url(): string };
	continue(): Promise<unknown>;
	abort(): Promise<unknown>;
}
interface PageLike {
	goto(url: string, o?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
	title(): Promise<string>;
	url(): string;
	evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
	screenshot(o: { path: string; fullPage?: boolean }): Promise<unknown>;
	route(pattern: string, handler: (route: RouteLike) => Promise<unknown>): Promise<unknown>;
	close(): Promise<unknown>;
}
interface BrowserLike {
	newPage(): Promise<PageLike>;
	close(): Promise<void>;
}

const REF_ATTR = "data-kb-ref";
const SNAPSHOT_JS = `(() => {
	const els = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[role="tab"],summary,label,[onclick]')]
		.filter(e => e.offsetParent !== null || e.tagName === 'OPTION');
	const lines = [];
	els.forEach((el, i) => {
		const ref = 'e' + (i + 1);
		el.setAttribute('${REF_ATTR}', ref);
		const tag = el.tagName.toLowerCase();
		const bits = [];
		if (el.id) bits.push('#' + el.id);
		const href = el.getAttribute('href'); if (href) bits.push('href=' + href.slice(0, 120));
		const type = el.getAttribute('type'); if (type) bits.push('type=' + type);
		const ph = el.getAttribute('placeholder'); if (ph) bits.push('placeholder=' + JSON.stringify(ph));
		const aria = el.getAttribute('aria-label'); if (aria) bits.push('aria=' + JSON.stringify(aria.slice(0, 60)));
		const txt = (el.innerText || (el.type === 'password' ? '' : el.value) || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
		lines.push(ref + ' <' + tag + (bits.length ? ' ' + bits.join(' ') : '') + '>' + (txt ? ' ' + JSON.stringify(txt) : ''));
	});
	return { title: document.title, url: location.href, count: els.length, lines: lines.join('\\n') };
})()`;

const MAX_SNAP = 8_000;
const MAX_OUT = 4_000;

export interface LocalBrowserTools {
	tools: AgentTool<any, string>[];
	dispose(): Promise<void>;
}

export function createLocalBrowserTools(opts: { root: string; shotsDir?: string; allowHosts?: () => readonly string[] }): LocalBrowserTools {
	const guard = new WorkspaceGuard(opts.root);
	const allowHosts = () => opts.allowHosts?.() ?? [];
	let browser: BrowserLike | undefined;
	let page: PageLike | undefined;

	const ensurePage = async (): Promise<PageLike | string> => {
		if (page) return page;
		let pw: { chromium?: { launch(o?: Record<string, unknown>): Promise<BrowserLike> } };
		try {
			pw = (await import("playwright-core")) as never;
		} catch {
			return "browser tools unavailable — playwright-core isn't installed. Run `npm i -D playwright-core` (and `npx playwright-core install chromium` if no system Chrome).";
		}
		try {
			// Prefer the user's Chrome; fall back to a playwright-managed chromium.
			browser = await pw.chromium!.launch({ channel: "chrome", headless: true }).catch(() => pw.chromium!.launch({ headless: true }));
			const p = await browser.newPage();
			// Every network request the page makes (navigations, redirects, subresources, fetch/XHR) runs the shared policy.
			await p.route("**/*", async (route) => {
				const refused = await checkUrl(new URL(route.request().url()), allowHosts());
				return refused ? route.abort() : route.continue();
			});
			page = p;
			return page;
		} catch (e) {
			return `browser launch failed — ${e instanceof Error ? e.message : String(e)}. Try \`npx playwright-core install chromium\`.`;
		}
	};

	const snapshot = async (p: PageLike): Promise<string> => {
		const snap = (await p.evaluate(SNAPSHOT_JS)) as { title: string; url: string; count: number; lines: string };
		const head = `${snap.title} — ${snap.url}\n${snap.count} interactive element(s):\n`;
		const body = snap.lines.length > MAX_SNAP ? `${snap.lines.slice(0, MAX_SNAP)}\n[…${snap.lines.length - MAX_SNAP} more snapshot chars]` : snap.lines;
		return head + body;
	};

	const withPage = async (fn: (p: PageLike) => Promise<string>): Promise<string> => {
		const p = await ensurePage();
		if (typeof p === "string") return p;
		try {
			return await fn(p);
		} catch (e) {
			return `browser action failed — ${e instanceof Error ? e.message : String(e)}`;
		}
	};

	const sel = (ref: string) => `[${REF_ATTR}="${String(ref).replace(/"/g, "")}"]`;

	const open: AgentTool<{ url: string }, string> = {
		name: "browser_open",
		description: "Open a URL in a headless browser and return an interactive-element snapshot (eN refs) plus title. Use for verifying local web apps — start the app with start_process first.",
		inputSchema: {
			type: "object",
			properties: { url: { type: "string", description: "http(s) URL, e.g. http://localhost:3000" } },
			required: ["url"],
		},
		execute: async (input) => {
			let target: URL;
			try {
				target = new URL(String(input.url ?? ""));
			} catch {
				return `browser_open: invalid URL ${JSON.stringify(input.url)}`;
			}
			const refused = await checkUrl(target, allowHosts());
			if (refused) return `browser_open: ${refused}`;
			return withPage(async (p) => {
				await p.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 20_000 });
				return snapshot(p);
			});
		},
	};

	const snap: AgentTool<Record<string, never>, string> = {
		name: "browser_snapshot",
		description: "Re-read the current page's interactive elements after navigation, scroll, or DOM changes.",
		inputSchema: { type: "object", properties: {} },
		execute: () => withPage((p) => snapshot(p)),
	};

	const click: AgentTool<{ ref: string }, string> = {
		name: "browser_click",
		description: "Click an element by its snapshot ref (e3, e12, …). Returns a fresh snapshot.",
		inputSchema: {
			type: "object",
			properties: { ref: { type: "string", description: "Element ref from the snapshot (e5)." } },
			required: ["ref"],
		},
		execute: (input) =>
			withPage(async (p) => {
				await p.evaluate(
					(s: string) => {
						const el = document.querySelector(s) as HTMLElement | null;
						if (!el) throw new Error(`no element ${s} — re-run browser_snapshot`);
						el.scrollIntoView({ block: "center" });
						el.click();
					},
					sel(input.ref),
				);
				await new Promise((r) => setTimeout(r, 400));
				return snapshot(p);
			}),
	};

	const type: AgentTool<{ ref: string; text: string; submit?: boolean }, string> = {
		name: "browser_type",
		description: "Type text into an input/textarea by snapshot ref. submit=true also presses Enter. Returns a fresh snapshot.",
		inputSchema: {
			type: "object",
			properties: {
				ref: { type: "string" },
				text: { type: "string" },
				submit: { type: "boolean" },
			},
			required: ["ref", "text"],
		},
		execute: (input) =>
			withPage(async (p) => {
				await p.evaluate(
					({ s, text, submit }: { s: string; text: string; submit: boolean }) => {
						const el = document.querySelector(s) as HTMLInputElement | null;
						if (!el) throw new Error(`no element ${s} — re-run browser_snapshot`);
						el.scrollIntoView({ block: "center" });
						el.focus();
						el.value = text;
						el.dispatchEvent(new Event("input", { bubbles: true }));
						el.dispatchEvent(new Event("change", { bubbles: true }));
						if (submit) {
							const form = el.closest("form");
							if (form) {
								const f = form as HTMLFormElement;
								if (f.requestSubmit) f.requestSubmit();
								else f.submit();
							}
							else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
						}
					},
					{ s: sel(input.ref), text: String(input.text ?? ""), submit: input.submit === true },
				);
				await new Promise((r) => setTimeout(r, 400));
				return snapshot(p);
			}),
	};

	const evalJs: AgentTool<{ js: string }, string> = {
		name: "browser_eval",
		description: "Run a JavaScript expression on the page and return its JSON result — for assertions a snapshot can't express (computed styles, counts, storage).",
		inputSchema: {
			type: "object",
			properties: { js: { type: "string", description: "JS expression evaluated in page context." } },
			required: ["js"],
		},
		execute: (input) =>
			withPage(async (p) => {
				const out = await p.evaluate(`(async () => (eval(${JSON.stringify(String(input.js ?? ""))})))()`);
				const s = typeof out === "string" ? out : JSON.stringify(out, null, 1);
				return s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}…[truncated]` : s;
			}),
	};

	const shot: AgentTool<{ path?: string; full_page?: boolean }, string> = {
		name: "browser_screenshot",
		description: "Screenshot the page to a PNG under .kronyx/shots/ (or the given workspace-relative path) and return the path.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Workspace-relative PNG path, default .kronyx/shots/<ts>.png" },
				full_page: { type: "boolean", description: "Capture the whole scrollable page, default false." },
			},
		},
		execute: (input) => {
			let abs: string;
			try {
				abs = guard.resolve(String(input.path ?? "") || path.join(".kronyx", "shots", `${Date.now()}.png`));
			} catch (e) {
				return Promise.resolve(`browser_screenshot: ${e instanceof Error ? e.message : String(e)}`);
			}
			return withPage(async (p) => {
				await fs.mkdir(path.dirname(abs), { recursive: true });
				await p.screenshot({ path: abs, fullPage: input.full_page === true });
				return `Screenshot saved: ${guard.relative(abs)}`;
			});
		},
	};

	const close: AgentTool<Record<string, never>, string> = {
		name: "browser_close",
		description: "Close the headless browser when verification is done.",
		inputSchema: { type: "object", properties: {} },
		execute: async () => {
			const had = !!browser;
			await dispose();
			return had ? "Browser closed." : "No browser was open.";
		},
	};

	const dispose = async () => {
		const b = browser;
		browser = undefined;
		page = undefined;
		await b?.close().catch(() => {});
	};

	return {
		tools: [open, snap, click, type, evalJs, shot, close],
		dispose,
	};
}
