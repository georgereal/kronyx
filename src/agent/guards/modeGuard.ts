/**
 * Mode guards — the policy stages that used to live inline in the runner's
 * beforeTool hook, kept in their original order:
 *
 *   savePlanGuard   save_plan is plan-mode-only (runs BEFORE rule evaluation).
 *   writeModeGuard  file_editor read commands bypass; non-writes pass;
 *                   ask/plan deny writes (one-shot mode-blocked notice);
 *                   smart/bypass allow; code-mode writes delegate to the
 *                   approval stage. (Runs AFTER rules.)
 *
 * Full pipeline order: repeat → save_plan → permissions → write-mode → approval.
 */

import type { PreTool } from "../pipeline";
import type { AgentMode } from "../runner";

export function createSavePlanGuard(currentMode: () => AgentMode): PreTool {
	return async (call, next) => {
		if (call.name === "save_plan") {
			return currentMode() === "plan"
				? { kind: "allow" }
				: { kind: "deny", reason: "Plans are saved in Plan mode only." };
		}
		return next();
	};
}

export interface WriteModeGuardOptions {
	currentMode(): AgentMode;
	/** WRITE_TOOL_NAMES from tools/fileTools.ts — injected to avoid a tool import here. */
	writeTools: ReadonlySet<string>;
	/** One-shot notice when a write is denied by mode. */
	onModeBlocked?: (mode: AgentMode) => void;
}

export function createWriteModeGuard(opts: WriteModeGuardOptions): PreTool {
	let warned = false;
	return async (call, next) => {
		if (call.name === "file_editor") {
			const cmd = (call.input as { command?: string })?.command;
			if (cmd === "view" || cmd === "symbols") return { kind: "allow" };
		}
		const mode = opts.currentMode();
		if (!opts.writeTools.has(call.name)) return { kind: "allow" };
		if (mode === "ask" || mode === "plan") {
			if (!warned) {
				warned = true;
				opts.onModeBlocked?.(mode);
			}
			return { kind: "deny", reason: `Writes are disabled in ${mode} mode. Ask the user to switch to Code or Smart mode.` };
		}
		if (mode === "smart" || mode === "bypass") return { kind: "allow" };
		return next();
	};
}
