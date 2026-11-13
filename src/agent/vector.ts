import { createHash } from "node:crypto";

/** Chunking: 150-line windows with 20-line overlap (ADR-0004 local index). */
export const CHUNK_LINES = 150;
export const CHUNK_OVERLAP = 20;
/** Per-file chunk ceiling; the number dropped beyond it is reported, not silent. */
export const MAX_CHUNKS_PER_FILE = 64;

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Top-k items by score, best first. Keeps only k candidates while scanning, so
 * a large index never gets fully sorted per query.
 */
export function topK<T>(items: Iterable<T>, k: number, score: (item: T) => number): { item: T; score: number }[] {
	const best: { item: T; score: number }[] = [];
	if (k <= 0) return best;
	for (const item of items) {
		const s = score(item);
		if (best.length === k && s <= best[k - 1].score) continue;
		let i = best.length;
		while (i > 0 && best[i - 1].score < s) i--;
		best.splice(i, 0, { item, score: s });
		if (best.length > k) best.pop();
	}
	return best;
}

export function chunkTextInfo(text: string): { chunks: string[]; dropped: number } {
	const lines = text.split("\n");
	const windows: string[] = [];
	for (let i = 0; i < lines.length; i += CHUNK_LINES - CHUNK_OVERLAP) {
		windows.push(lines.slice(i, i + CHUNK_LINES).join("\n"));
		if (i + CHUNK_LINES >= lines.length) break;
	}
	const kept = windows.filter((c) => c.trim().length > 20);
	return {
		chunks: kept.slice(0, MAX_CHUNKS_PER_FILE),
		dropped: Math.max(0, kept.length - MAX_CHUNKS_PER_FILE),
	};
}

export function chunkText(text: string): string[] {
	return chunkTextInfo(text).chunks;
}

export function contentHash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
