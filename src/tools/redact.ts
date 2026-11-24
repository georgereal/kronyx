/**
 * Model-facing redaction — the last step before tool output enters context.
 * Masks values the host knows are secrets (MCP/env/settings values) and
 * high-confidence credential shapes. vscode-free.
 */

const MIN_KNOWN_LENGTH = 8;
const MASK = "[redacted]";

const SHAPES: RegExp[] = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
	/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
	/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/g,
	/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
	/\bAIza[0-9A-Za-z_-]{35}\b/g,
	/\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g,
	/\blin_api_[A-Za-z0-9]{30,}\b/g,
	/\bntn_[A-Za-z0-9]{30,}\b/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/** Replace known secret values and credential-shaped strings with a fixed mask. */
export function redactForModel(text: string, known: Iterable<string> = []): string {
	let out = text;
	// Longest first so a value that contains a shorter secret is masked whole.
	const values = [...new Set(known)].filter((v) => v.length >= MIN_KNOWN_LENGTH).sort((a, b) => b.length - a.length);
	for (const v of values) if (out.includes(v)) out = out.split(v).join(MASK);
	for (const re of SHAPES) out = out.replace(re, MASK);
	return out;
}
