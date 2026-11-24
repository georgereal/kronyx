/**
 * Shared network policy for host-side web access (fetch_url and the local
 * browser). vscode-free. Private, loopback, and link-local destinations are
 * refused unless the host appears in `allowHosts` (kronyx.network.allowHosts).
 */

import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";

const DNS_TTL_MS = 60_000;
const dnsVerdicts = new Map<string, { at: number; error?: string }>();

/** IPv4 ranges that must never be reached from a host-side tool. */
export function isPrivateIPv4(ip: string): boolean {
	const [a, b] = ip.split(".").map(Number);
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224
	);
}

/** IPv6 + IPv4-mapped/compatible forms. Accepts a bare address (brackets and zone id tolerated). */
export function isPrivateAddress(addr: string): boolean {
	const ip = addr.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
	if (mapped) return isPrivateIPv4(mapped[1]);
	const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
	if (hexMapped) {
		const n = parseInt(hexMapped[1], 16) * 65536 + parseInt(hexMapped[2], 16);
		return isPrivateIPv4([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
	}
	const v = isIP(ip);
	if (v === 4) return isPrivateIPv4(ip);
	if (v !== 6) return false;
	return ip === "::" || ip === "::1" || /^f[cd]/.test(ip) || /^fe[89a-f]/.test(ip) || /^ff/.test(ip) || (ip.startsWith("::") && ip.includes(".") && isPrivateIPv4(ip.slice(ip.lastIndexOf(":") + 1)));
}

/** Hostnames that name private destinations without needing DNS. */
export function isPrivateName(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	return h === "localhost" || h.endsWith(".localhost") || h === "metadata.google.internal" || (isIP(h) !== 0 && isPrivateAddress(h));
}

/** allowHosts entries: "host", "host:port", or "*.suffix". */
export function isAllowedHost(url: URL, allowHosts: readonly string[]): boolean {
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const port = url.port || (url.protocol === "https:" ? "443" : "80");
	return allowHosts.some((entry) => {
		const e = entry.trim().toLowerCase();
		const [h, p] = e.includes(":") && !e.startsWith("[") ? [e.slice(0, e.lastIndexOf(":")), e.slice(e.lastIndexOf(":") + 1)] : [e, undefined];
		if (!h) return false;
		const hostOk = h.startsWith("*.") ? host.endsWith(h.slice(1)) : host === h;
		return hostOk && (p === undefined || p === port);
	});
}

/** Pre-request verdict: undefined when the URL may be fetched, otherwise a reason to show the model. */
export async function checkUrl(url: URL, allowHosts: readonly string[] = []): Promise<string | undefined> {
	if (url.protocol !== "http:" && url.protocol !== "https:") return `only http/https URLs are supported (got ${url.protocol}).`;
	if (isAllowedHost(url, allowHosts)) return undefined;
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (isPrivateName(host)) return `refusing to reach a private/loopback address (${host}). Add it to kronyx.network.allowHosts to allow it.`;
	if (isIP(host)) return undefined;
	const cached = dnsVerdicts.get(host);
	if (cached && Date.now() - cached.at < DNS_TTL_MS) return cached.error;
	const error = await new Promise<string | undefined>((resolve) =>
		dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => {
			if (err) return resolve(undefined); // unresolvable hosts fail naturally at request time
			const bad = addrs.find((a) => isPrivateAddress(a.address));
			resolve(bad ? `${host} resolves to a private address (${bad.address}); refusing.` : undefined);
		}),
	);
	dnsVerdicts.set(host, { at: Date.now(), error });
	return error;
}

/** DNS lookup hook: every socket validates its resolved address, so a rebinding host can't swap in a private IP after checkUrl. */
function guardedLookup(allowHosts: readonly string[]) {
	return (hostname: string, options: { all?: boolean }, callback: (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void) => {
		if (allowHosts.some((e) => e.trim().toLowerCase().split(":")[0] === hostname.toLowerCase())) {
			return dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => (err ? callback(err, "", 0) : options.all ? callback(null, addrs) : callback(null, addrs[0].address, addrs[0].family)));
		}
		dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
			if (err) return callback(err, "", 0);
			const bad = addrs.find((a) => isPrivateAddress(a.address));
			if (bad) return callback(new Error(`blocked: ${hostname} resolves to private address ${bad.address}`), "", 0);
			return options.all ? callback(null, addrs) : callback(null, addrs[0].address, addrs[0].family);
		});
	};
}

export interface SafeResponse {
	status: number;
	statusText: string;
	ok: boolean;
	url: string;
	headers: { get(name: string): string | null };
	text(): Promise<string>;
}

/** GET with connect-time address validation. Response body is capped at maxBytes. */
export function safeGet(url: URL, opts: { headers?: Record<string, string>; timeoutMs: number; maxBytes: number; allowHosts?: readonly string[] }): Promise<SafeResponse> {
	return new Promise((resolve, reject) => {
		const send = url.protocol === "https:" ? httpsRequest : httpRequest;
		const req = send(url, { method: "GET", headers: opts.headers, lookup: guardedLookup(opts.allowHosts ?? []) as never }, (res) => {
			const chunks: Buffer[] = [];
			let size = 0;
			res.on("data", (c: Buffer) => {
				if (size >= opts.maxBytes) return;
				size += c.length;
				chunks.push(c);
			});
			res.on("error", reject);
			res.on("end", () => {
				const headers: IncomingHttpHeaders = res.headers;
				const status = res.statusCode ?? 0;
				resolve({
					status,
					statusText: res.statusMessage ?? "",
					ok: status >= 200 && status < 300,
					url: url.toString(),
					headers: { get: (name) => { const v = headers[name.toLowerCase()]; return Array.isArray(v) ? v.join(", ") : (v ?? null); } },
					text: async () => Buffer.concat(chunks).toString("utf8"),
				});
			});
		});
		const timer = setTimeout(() => req.destroy(new Error(`timed out after ${Math.round(opts.timeoutMs / 1000)}s`)), opts.timeoutMs);
		req.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		req.on("close", () => clearTimeout(timer));
		req.end();
	});
}
