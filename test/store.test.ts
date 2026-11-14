import { describe, expect, it } from "vitest";
import Sqlite from "better-sqlite3";
import { getEmbeddingCache, listChunks, putEmbeddingCache, upsertChunk } from "../src/store";

// Mirrors the tables openStore() creates; the cache and chunk helpers take the
// database as an argument, so tests can run against an in-memory instance.
function memoryStore() {
	const d = new Sqlite(":memory:");
	d.exec(`CREATE TABLE IF NOT EXISTS chunks(
		root TEXT, path TEXT, idx INTEGER, text TEXT, embedding BLOB,
		PRIMARY KEY(root, path, idx))`);
	d.exec(`CREATE TABLE IF NOT EXISTS embedding_cache(
		hash TEXT, model TEXT, embedding BLOB, PRIMARY KEY(hash, model))`);
	return d;
}

const vec = (...xs: number[]) => new Float32Array(xs);

describe("embedding cache", () => {
	it("misses when nothing is cached", () => {
		expect(getEmbeddingCache(memoryStore(), "h1", "m1")).toBeUndefined();
	});

	it("hits after put and round-trips the vector", () => {
		const d = memoryStore();
		putEmbeddingCache(d, "h1", "m1", vec(0.5, -1.25, 3));
		const hit = getEmbeddingCache(d, "h1", "m1");
		expect(hit).toBeInstanceOf(Float32Array);
		expect(Array.from(hit!)).toEqual([0.5, -1.25, 3]);
	});

	it("keys on both hash and model", () => {
		const d = memoryStore();
		putEmbeddingCache(d, "h1", "m1", vec(1));
		expect(getEmbeddingCache(d, "h1", "m2")).toBeUndefined();
		expect(getEmbeddingCache(d, "h2", "m1")).toBeUndefined();
	});

	it("overwrites an existing entry for the same hash and model", () => {
		const d = memoryStore();
		putEmbeddingCache(d, "h1", "m1", vec(1, 2));
		putEmbeddingCache(d, "h1", "m1", vec(9));
		expect(Array.from(getEmbeddingCache(d, "h1", "m1")!)).toEqual([9]);
	});

	it("returns a copy, so callers cannot mutate the cached bytes", () => {
		const d = memoryStore();
		putEmbeddingCache(d, "h1", "m1", vec(4));
		getEmbeddingCache(d, "h1", "m1")![0] = 99;
		expect(Array.from(getEmbeddingCache(d, "h1", "m1")!)).toEqual([4]);
	});

	it("treats a missing database as a miss and ignores writes", () => {
		expect(getEmbeddingCache(undefined, "h1", "m1")).toBeUndefined();
		expect(() => putEmbeddingCache(undefined, "h1", "m1", vec(1))).not.toThrow();
	});
});

describe("listChunks", () => {
	it("caps rows at the default limit of 1000", () => {
		const d = memoryStore();
		for (let i = 0; i < 1_200; i++) upsertChunk(d, "a.ts", i, `chunk ${i}`, vec(i), "/r");
		expect(listChunks(d, undefined, "/r")).toHaveLength(1_000);
	});

	it("honours an explicit limit and root filter", () => {
		const d = memoryStore();
		upsertChunk(d, "a.ts", 0, "a", vec(1), "/r1");
		upsertChunk(d, "b.ts", 0, "b", vec(2), "/r2");
		upsertChunk(d, "c.ts", 0, "c", vec(3), "/r1");
		const rows = listChunks(d, 10, "/r1");
		expect(rows.map((r) => r.path).sort()).toEqual(["a.ts", "c.ts"]);
		expect(listChunks(d, 1, "/r1")).toHaveLength(1);
	});
});
