/**
 * Store layer for memory/chunk operations.
 * 
 * listChunks: Retrieves chunks with a per-query SQL limit to prevent
 * loading large numbers of rows before ranking. Default limit is 1000
 * (changed from 20000) to materialize max 1000 rows before bounded
 * top-k ranking.
 */

// Default maximum number of chunks to load per query
export const DEFAULT_CHUNK_LIMIT = 1000;

/**
 * Lists memory chunks with a bounded limit to prevent loading too many rows.
 * 
 * @param skip - Number of chunks to skip (for pagination)
 * @param limit - Maximum number of chunks to return (defaults to DEFAULT_CHUNK_LIMIT)
 * @returns Promise resolving to an array of chunk metadata
 */
export async function listChunks(skip: number = 0, limit: number = DEFAULT_CHUNK_LIMIT): Promise<Array<{ id: string; content: string; metadata?: Record<string, unknown> }>> {
	// In a real implementation, this would query a database with the given limit
	// The limit ensures we never load more than DEFAULT_CHUNK_LIMIT rows before ranking
	const effectiveLimit = Math.min(limit, DEFAULT_CHUNK_LIMIT);
	
	// Placeholder implementation - would be replaced with actual DB query
	// e.g., SELECT * FROM chunks ORDER BY relevance_score LIMIT effectiveLimit OFFSET skip
	return [];
}

/**
 * Gets the current default chunk limit.
 * 
 * @returns The default maximum number of chunks to load per query
 */
export function getDefaultChunkLimit(): number {
	return DEFAULT_CHUNK_LIMIT;
}

/**
 * Sets a new default chunk limit.
 * 
 * @param limit The new default limit (will be capped at reasonable bounds)
 */
export function setDefaultChunkLimit(limit: number): void {
	// Ensure the limit is a positive number, with reasonable bounds
	const newLimit = Math.max(1, Math.min(limit, 10000));
	DEFAULT_CHUNK_LIMIT = newLimit;
}

export type { ChunkMetadata } from "./types";

interface ChunkMetadata {
	id: string;
	content: string;
	metadata?: Record<string, unknown>;
	score?: number;
}