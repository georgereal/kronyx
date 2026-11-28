const SECRET_PATTERNS = [
	/\b(?:sk|pk|xox[baprs]|ghp|github_pat|glpat|AIza|AKIA|ASIA)[-_A-Za-z0-9]{10,}\b/g,
	/\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?[^\s"']{8,}/gi,
];

/** Redacts common credential shapes before manifests, knowledge indexing, or artifacts leave the trusted boundary. */
export function redactText(text: string, extraSecrets: readonly string[] = []): string {
	let out = text;
	for (const secret of extraSecrets) if (secret && secret.length > 6) out = out.split(secret).join("•••");
	for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => `${m.slice(0, Math.min(8, m.length))}•••`);
	return out;
}
