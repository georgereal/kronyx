/**
 * Capability seam registry: named provider slots with disposers.
 * vscode-free — shared by the extension and the cloud worker.
 *
 * A seam is a swappable capability (tools, approvals, memory, …). Callers
 * register one provider per seam key; consumers resolve by key. Re-registering
 * a key replaces the provider and disposes nothing itself — the previous
 * disposer's owner decides when to release it. resolve() returns undefined for
 * an unprovided seam; required() fails loud for mandatory ones.
 */

import type { Disposable } from "./pipeline";

export class KronyxRegistry {
	private readonly providers = new Map<string, unknown>();

	register<T>(key: string, provider: T): Disposable {
		this.providers.set(key, provider);
		return () => {
			if (this.providers.get(key) === provider) this.providers.delete(key);
		};
	}

	resolve<T>(key: string): T | undefined {
		return this.providers.get(key) as T | undefined;
	}

	required<T>(key: string): T {
		const p = this.resolve<T>(key);
		if (p === undefined) throw new Error(`KronyxRegistry: required seam "${key}" has no provider`);
		return p;
	}
}
