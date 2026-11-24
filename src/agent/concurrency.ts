/** Bounded concurrency gate for tool execution (vscode-free). */
export class Semaphore {
	private active = 0;
	private readonly waiting: (() => void)[] = [];

	constructor(private readonly limit: number) {}

	async run<T>(fn: () => Promise<T> | T): Promise<T> {
		if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
		this.active++;
		try {
			return await fn();
		} finally {
			this.active--;
			this.waiting.shift()?.();
		}
	}
}

/** Default in-flight tool ceiling when a run doesn't configure one. */
export const DEFAULT_MAX_PARALLEL_TOOLS = 6;
