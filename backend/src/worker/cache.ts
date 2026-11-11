/**
 * Context cache seam: in-process Map today, Redis-backed when REDIS_URL is set.
 * Swap point is `getCache()` — everything else consumes the interface.
 */
import { swallow } from "../lib/log";

export interface ContextCache {
	get(key: string): Promise<unknown | undefined>;
	set(key: string, value: unknown, ttlMs?: number): Promise<void>;
	del(key: string): Promise<void>;
}

class InProcessCache implements ContextCache {
	private store = new Map<string, { v: unknown; exp: number }>();
	private static readonly MAX = 500;
	async get(key: string) {
		const e = this.store.get(key);
		if (!e) return undefined;
		if (e.exp < Date.now()) {
			this.store.delete(key);
			return undefined;
		}
		return e.v;
	}
	async set(key: string, value: unknown, ttlMs = 60_000) {
		if (this.store.size >= InProcessCache.MAX) this.store.delete(this.store.keys().next().value!);
		this.store.set(key, { v: value, exp: Date.now() + ttlMs });
	}
	async del(key: string) {
		this.store.delete(key);
	}
}

class RedisCache implements ContextCache {
	// biome-ignore lint/suspicious/noExplicitAny: ioredis is an optional lazy dep
	private constructor(private readonly client: any) {}
	static async create(url: string): Promise<RedisCache> {
		const { Redis } = await import("ioredis");
		return new RedisCache(new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 }));
	}
	async get(key: string) {
		const raw = await this.client.get(`kronyx:${key}`).catch(swallow("cache", `get ${key}`, null));
		return raw ? JSON.parse(raw) : undefined;
	}
	async set(key: string, value: unknown, ttlMs = 60_000) {
		await this.client
			.set(`kronyx:${key}`, JSON.stringify(value), "PX", Math.round(ttlMs))
			.catch(swallow("cache", `set ${key}`));
	}
	async del(key: string) {
		await this.client.del(`kronyx:${key}`).catch(swallow("cache", `del ${key}`));
	}
}

let cached: ContextCache | undefined;
export async function getCache(): Promise<ContextCache> {
	if (cached) return cached;
	const url = process.env.REDIS_URL;
	if (url) {
		try {
			cached = await RedisCache.create(url);
			console.log("[cache] redis-backed");
			return cached;
		} catch {
			console.log("[cache] redis unavailable — falling back to in-process");
		}
	}
	return (cached = new InProcessCache());
}
