import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function sha256Text(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function contentHash(value: unknown): string {
	return sha256Text(typeof value === "string" ? value : canonicalJson(value));
}
