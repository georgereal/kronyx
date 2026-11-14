import type { AgentTool } from "@cline/shared";

const MAX_CHARS = 60_000;
const TIMEOUT_MS = 20_000;
const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Loopback / private-IP literals — a fetch tool shouldn't probe the host's own network. */
function isPrivateHost(hostname: string): boolean {
	const h = hostname.toLowerCase();
	if (h === "localhost" || h === "0.0.0.0" || h === "::1" || h === "[::1]") return true;
	const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	if (!m) return false;
	const [a, b] = [Number(m[1]), Number(m[2])];
	return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " ", apos: "'" };

/** Crude HTML→text: drop scripts/styles, tags to newlines, decode common entities. */
export function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|pre|blockquote|table|ul|ol|br|hr)>/gi, "\n")
		.replace(/<(br|hr)[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&(#39|amp|lt|gt|quot|nbsp|apos);/g, (m, e) => ENTITIES[e] ?? m)
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n+/g, "\n\n")
		.trim();
}

/**
 * Worker-side URL reader — the agent's only way to fetch web pages/docs the
 * user shares. Runs on the backend host (not the sandbox), so it works in
 * ask/plan modes too and avoids E2B datacenter-IP rate limits.
 */
export function createFetchTools(): AgentTool<any, string>[] {
	const fetchUrl: AgentTool<{ url: string; max_chars?: number }, string> = {
		name: "fetch_url",
		description:
			"Fetch a web page or document the user links (docs, blog posts, API references) and return its readable text. " +
			"HTML is stripped to plain text; markdown/text/json pass through. Returns the HTTP status when a site refuses — report blocks honestly instead of retrying forever.",
		inputSchema: {
			type: "object",
			properties: {
				url: { type: "string", description: "Full http(s) URL to fetch." },
				max_chars: { type: "integer", minimum: 1000, maximum: MAX_CHARS, description: `Max characters to return, default ${MAX_CHARS}.` },
			},
			required: ["url"],
		},
		async execute(input) {
			let parsed: URL;
			try {
				parsed = new URL(String(input.url ?? ""));
			} catch {
				return `fetch_url: invalid URL ${JSON.stringify(input.url)}`;
			}
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
				return `fetch_url: only http/https URLs are supported (got ${parsed.protocol}).`;
			if (isPrivateHost(parsed.hostname)) return `fetch_url: refusing to fetch a private/loopback address.`;

			const HEADERS = {
				"User-Agent": UA,
				Accept: "text/html,application/xhtml+xml,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.5",
				"Accept-Language": "en-US,en;q=0.9",
			};
			// Manual redirect handling — each hop re-validates protocol + host,
			// otherwise a public URL could redirect into a private address.
			const get = async (): Promise<Response | string> => {
				let current = parsed;
				for (let hop = 0; hop <= 5; hop++) {
					let r: Response;
					try {
						r = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: HEADERS });
					} catch (e) {
						return `fetch_url: request failed — ${e instanceof Error ? e.message : String(e)}`;
					}
					if (![301, 302, 303, 307, 308].includes(r.status)) return r;
					const loc = r.headers.get("location");
					if (!loc) return r;
					let next: URL;
					try {
						next = new URL(loc, current);
					} catch {
						return `fetch_url: redirect to an invalid URL (${loc.slice(0, 120)})`;
					}
					if (next.protocol !== "http:" && next.protocol !== "https:")
						return `fetch_url: redirect to unsupported scheme ${next.protocol}`;
					if (isPrivateHost(next.hostname)) return `fetch_url: refusing redirect to a private/loopback address.`;
					current = next;
				}
				return "fetch_url: too many redirects (>5).";
			};
			let res = await get();
			if (typeof res === "string") return res;
			// One bounded retry on 429 — parallel agent fetches and origin
			// rate-limiters both trip on bursts; honor Retry-After, capped.
			if (res.status === 429) {
				const ra = Number(res.headers.get("retry-after") ?? "");
				const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 10) * 1000 : 4000 + Math.random() * 2000;
				await new Promise((r) => setTimeout(r, wait));
				res = await get();
				if (typeof res === "string") return res;
			}
			if (!res.ok) {
				const hint = res.status === 429 ? " (rate-limited — the site is blocking automated fetches)" : res.status === 403 ? " (forbidden — likely a bot block)" : "";
				return `fetch_url: HTTP ${res.status} ${res.statusText}${hint}`;
			}
			const ct = (res.headers.get("content-type") ?? "").toLowerCase();
			if (ct && !/text|json|xml|markdown|javascript|html/.test(ct))
				return `fetch_url: unsupported content type ${ct} — this tool reads text pages only.`;

			const raw = await res.text().catch(() => "");
			const isHtml = ct.includes("html") || /^<!doctype html|<html[\s>]/i.test(raw.slice(0, 500));
			const text = isHtml ? htmlToText(raw) : raw;
			const cap = Math.min(Math.max(1000, input.max_chars ?? MAX_CHARS), MAX_CHARS);
			const truncated = text.length > cap ? `\n\n[truncated — page is ${text.length} chars, showing first ${cap}]` : "";
			return (text.slice(0, cap) || "(empty page)") + truncated;
		},
	};
	return [fetchUrl];
}
