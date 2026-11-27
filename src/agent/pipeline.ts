/**
 * Tool-execution pipeline: ordered waterfalls around every model tool call.
 * vscode-free — shared by the extension and the cloud worker.
 *
 * Three stages, all sequential:
 *   pre    — policy: each listener sees the call and may allow, ask, deny, or
 *            delegate to the next listener via next(). Returning a verdict
 *            without calling next() short-circuits (that IS the mechanism —
 *            the first non-delegating listener wins).
 *   around — execution wrappers (timeouts, retries, metrics); each wraps the
 *            remaining chain. Not exposed to model-facing policy.
 *   post   — result rewriting: may return a replacement value; short-circuit
 *            by returning without next().
 *
 * Registrations return disposers; a guard/plugin that unloads unwinds its
 * listeners without touching the runner.
 */

export interface ToolCall {
	readonly name: string;
	readonly input: unknown;
	/** The model call this guards — present when the caller threads it through. */
	readonly callId?: string;
}

export type PreVerdict = { kind: "allow" } | { kind: "ask" } | { kind: "deny"; reason: string };
export type PreTool = (call: ToolCall, next: () => Promise<PreVerdict>) => Promise<PreVerdict>;
export type AroundTool = <T>(call: ToolCall, run: () => Promise<T>) => Promise<T>;
export type PostTool = <T>(call: ToolCall, result: T, next: (result: T) => Promise<T>) => Promise<T>;

export type Disposable = () => void;

export class ToolPipeline {
	private readonly preListeners: PreTool[] = [];
	private readonly aroundListeners: AroundTool[] = [];
	private readonly postListeners: PostTool[] = [];

	pre(fn: PreTool): Disposable {
		this.preListeners.push(fn);
		return () => {
			const i = this.preListeners.indexOf(fn);
			if (i >= 0) this.preListeners.splice(i, 1);
		};
	}

	around(fn: AroundTool): Disposable {
		this.aroundListeners.push(fn);
		return () => {
			const i = this.aroundListeners.indexOf(fn);
			if (i >= 0) this.aroundListeners.splice(i, 1);
		};
	}

	post<T>(fn: (call: ToolCall, result: T, next: (result: T) => Promise<T>) => Promise<T>): Disposable {
		const stored = fn as PostTool;
		this.postListeners.push(stored);
		return () => {
			const i = this.postListeners.indexOf(stored);
			if (i >= 0) this.postListeners.splice(i, 1);
		};
	}

	/** First non-delegating verdict wins; empty chain defaults to "ask" so a
	 *  bare pipeline never silently authorizes a call. */
	async runPre(call: ToolCall): Promise<PreVerdict> {
		const dispatch = (i: number): Promise<PreVerdict> =>
			i >= this.preListeners.length ? Promise.resolve({ kind: "ask" }) : this.preListeners[i](call, () => dispatch(i + 1));
		return dispatch(0);
	}

	async runAround<T>(call: ToolCall, body: () => Promise<T>): Promise<T> {
		const dispatch = (i: number): Promise<T> => (i >= this.aroundListeners.length ? body() : this.aroundListeners[i](call, () => dispatch(i + 1)));
		return dispatch(0);
	}

	async runPost<T>(call: ToolCall, result: T): Promise<T> {
		const dispatch = (i: number, current: T): Promise<T> =>
			i >= this.postListeners.length ? Promise.resolve(current) : this.postListeners[i](call, current, (r) => dispatch(i + 1, r));
		return dispatch(0, result);
	}
}
