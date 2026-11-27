/**
 * Canonical JSON (vscode-free): stable serialization with sorted object keys,
 * so equal arguments produce equal fingerprints regardless of key order.
 */

import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
	const entries = Object.keys(value as Record<string, unknown>)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
	return `{${entries.join(",")}}`;
}

/** Fingerprint of one tool call: name plus canonical arguments. */
export const callFingerprint = (name: string, input: unknown): string => `${name}:${canonicalJson(input)}`;

export const hashText = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);
