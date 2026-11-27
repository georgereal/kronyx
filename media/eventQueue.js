"use strict";
/**
 * RunEventQueue — ordered, coalescing event queue for run views.
 *
 * One instance per run surface (a session tab today; a run_id in cloud later).
 * Events are pushed as they arrive and applied in ordered batches by a single
 * drain, which gives the consumer three properties it cannot get from
 * paint-on-receipt:
 *
 *  - Look-ahead: a batch contains related events (tool.requested →
 *    permission-request), so pairs resolve in one step instead of racing a
 *    timer.
 *  - Coalescing: consecutive streaming frames (deltas) fold into one apply —
 *    the queue itself is the render throttle.
 *  - Replay convergence: a replayed history is the same queue, pre-filled in
 *    a burst. Live and replay use identical ordering logic.
 *
 * Reentrancy: JS is single-threaded, but apply handlers may schedule work that
 * pushes more events. The drain guard ensures pushes during a pass are
 * processed by the next pass — never mid-mutation, never lost.
 *
 * Dependency-free on purpose: no DOM, no vscode — the same class can back the
 * web dashboard's event pipeline.
 */
(() => {
	class RunEventQueue {
		/**
		 * @param {{ applyBatch: (events: any[]) => void, fold?: (prev: any, next: any) => any | null }} opts
		 *   applyBatch: applies one ordered, folded batch.
		 *   fold: given two adjacent queued events, returns a merged event to
		 *   replace both, or null to keep them separate. Runs on every pass.
		 */
		constructor(opts) {
			if (typeof opts?.applyBatch !== "function") throw new Error("RunEventQueue requires applyBatch(events)");
			this.applyBatch = opts.applyBatch;
			this.fold = opts.fold || null;
			/** @type {any[]} */
			this.q = [];
			this.draining = false;
			this.burst = false;
			this.scheduled = false;
		}

		push(event) {
			this.q.push(event);
			this.#schedule();
		}

		pushAll(events) {
			for (const e of events) this.q.push(e);
			this.#schedule();
		}

		/** Burst brackets (replay-start/replay-end): hold the drain until the
		 * burst ends so the whole replay applies as one ordered batch. */
		setBurst(on) {
			this.burst = !!on;
			if (!on) this.drain();
		}

		get size() {
			return this.q.length;
		}

		clear() {
			this.q.length = 0;
		}

		#schedule() {
			if (this.scheduled || this.draining || this.burst) return;
			this.scheduled = true;
			// Microtask drain: everything posted in the same flush coalesces.
			Promise.resolve().then(() => {
				this.scheduled = false;
				this.drain();
			});
		}

		drain() {
			if (this.draining || this.burst) return;
			this.draining = true;
			try {
				while (this.q.length) {
					this.applyBatch(this.#takeBatch());
				}
			} finally {
				this.draining = false;
				// Events pushed during apply run next pass — never mid-batch.
				if (this.q.length) this.#schedule();
			}
		}

		#takeBatch() {
			const out = this.q.splice(0);
			if (!this.fold || out.length < 2) return out;
			const merged = [out[0]];
			for (let i = 1; i < out.length; i++) {
				const m = this.fold(merged[merged.length - 1], out[i]);
				if (m) merged[merged.length - 1] = m;
				else merged.push(out[i]);
			}
			return merged;
		}
	}

	// Global for the webview bundle; also exportable for tests/cloud reuse.
	const root = typeof globalThis !== "undefined" ? globalThis : window;
	root.KronyxRunQueue = RunEventQueue;
	if (typeof module !== "undefined" && module.exports) module.exports = { RunEventQueue };
})();
