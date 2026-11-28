import { Agent } from "@cline/agents";
import type { AgentTool } from "@cline/shared";
import type { ProviderSettings } from "./types";

/**
 * Subagent seam (vscode-free): a uniform handle for child agents that work
 * in their own context window. The extension's explore_codebase is the
 * in-process implementation; the worker's multi-slice fanout (PLAN-011)
 * adapts to the same interface so policy/UI see one shape.
 */

export interface SubagentHandle {
	readonly id: string;
	readonly task: string;
}

export interface SubagentProvider {
	/** Launch the child agent; resolves once it has started (not finished). */
	start(task: string): Promise<SubagentHandle>;
	/** Human-readable status for UI streaming. */
	progress(handle: SubagentHandle): Promise<string>;
	/** Final output — resolves when the child finishes (success or failure
	 *  reported in the text, same contract as a tool result). */
	result(handle: SubagentHandle): Promise<string>;
	cancel(handle: SubagentHandle): Promise<void>;
}

export interface InProcessSubagentOptions {
	settings: ProviderSettings;
	tools: readonly AgentTool<any, string>[];
	systemPrompt: string;
	maxIterations?: number;
	onEvent?: (text: string) => void;
}

interface LiveSubagent extends SubagentHandle {
	done: Promise<{ status: string; text: string; iterations?: number }>;
	cancelled: boolean;
}

let nextId = 1;

/** A child `Agent` run inside this process — the explore_codebase shape. */
export class InProcessSubagent implements SubagentProvider {
	private live = new Map<string, LiveSubagent>();

	constructor(private opts: InProcessSubagentOptions) {}

	async start(task: string): Promise<SubagentHandle> {
		const agent = new Agent({
			providerId: this.opts.settings.providerId,
			modelId: this.opts.settings.modelId,
			apiKey: this.opts.settings.apiKey,
			baseUrl: this.opts.settings.baseUrl || undefined,
			systemPrompt: this.opts.systemPrompt,
			tools: [...this.opts.tools],
			maxIterations: this.opts.maxIterations ?? 12,
			toolExecution: "sequential",
			...(this.opts.settings.maxTokens ? { modelOptions: { maxTokens: this.opts.settings.maxTokens } } : {}),
		});
		const handle: LiveSubagent = {
			id: `sub-${nextId++}`,
			task,
			cancelled: false,
			done: agent.run(task).then((r) => ({
				status: r.status,
				text: r.status === "completed" ? r.outputText || "(subagent returned no text)" : `Subagent ${r.status}: ${r.error?.message ?? r.outputText ?? "no answer"}`,
				iterations: r.iterations,
			})),
		};
		this.live.set(handle.id, handle);
		void handle.done.finally(() => this.live.delete(handle.id));
		return handle;
	}

	async progress(handle: SubagentHandle): Promise<string> {
		return this.live.has(handle.id) ? "running" : "finished";
	}

	async result(handle: SubagentHandle): Promise<string> {
		const h = this.live.get(handle.id) ?? (handle as LiveSubagent);
		if (h.cancelled) return "Subagent cancelled.";
		const r = await h.done;
		this.opts.onEvent?.(`subagent finished in ${r.iterations ?? "?"} iteration(s)`);
		return h.cancelled ? "Subagent cancelled." : r.text;
	}

	async cancel(handle: SubagentHandle): Promise<void> {
		const h = this.live.get(handle.id);
		if (h) h.cancelled = true;
	}
}
