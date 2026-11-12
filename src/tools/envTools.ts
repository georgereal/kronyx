import type { AgentTool } from "@cline/shared";

export interface EnvToolOptions {
	/**
	 * Perform a sandbox template switch. Blocks until the new VM is ready
	 * (interim commit → recreate → reclone) and returns the outcome shown to
	 * the agent — either the switched confirmation or a validation/refusal
	 * error. Bound per-run through the executor's live slot.
	 */
	requestSwitch: (template: string, reason: string, evidence: string) => Promise<string>;
}

/**
 * Environment tools for sandboxed runs. switch_environment lets the agent
 * move to a different VM image when the current one lacks needed tooling —
 * the worker commits in-flight work, recreates the sandbox on the new
 * template, reclones the branch, and continues the run.
 */
export function createEnvTools(opts: EnvToolOptions): AgentTool<any, string>[] {
	const switchEnv: AgentTool<{ template: string; reason: string; evidence: string }, string> = {
		name: "switch_environment",
		// Ordering boundary: the swap must fully resolve before any later tool
		// call executes — every command after this runs on the NEW VM.
		executionMode: "sequential",
		description:
			"Switch this workspace's VM to a different template/image when the task needs a capability " +
			"the current image cannot provide (e.g. GUI/Qt work needs a display-capable image, " +
			"browser testing needs a browser image, k8s needs a cluster image). " +
			"Do NOT call to explore or speculate — 'evidence' must show a concrete gap: a failed " +
			"command/tool error, a probe result (import check, `which`, missing lib), or a hard " +
			"capability requirement stated by the task. " +
			"The switch happens during this call: uncommitted work is pushed to the session branch, a new " +
			"VM is created, and when this tool returns you are already on the new environment — verify the " +
			"capability exists, then continue.",
		inputSchema: {
			type: "object",
			properties: {
				template: { type: "string", description: "Target template name (from the available list)." },
				reason: { type: "string", description: "Why the current environment can't complete the task." },
				evidence: {
					type: "string",
					description:
						"Concrete proof of the capability gap: error output from a failed command/tool, a probe result " +
						"(e.g. import check fails, binary missing), or the task's stated hard requirement the image can't meet. Required.",
				},
			},
			required: ["template", "reason", "evidence"],
		},
		async execute(input) {
			const template = String(input.template ?? "").trim();
			const reason = String(input.reason ?? "").trim();
			const evidence = String(input.evidence ?? "").trim();
			if (!template || !reason) return "Both template and reason are required.";
			if (evidence.length < 10) {
				return "Refused: provide real 'evidence' — a failed command/tool error, a probe result, or the task's stated requirement proving the current VM lacks the capability.";
			}
			return opts.requestSwitch(template, reason, evidence);
		},
	};

	return [switchEnv];
}
