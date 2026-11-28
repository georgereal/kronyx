/**
 * Mode guards — the policy stages that used to live inline in the runner's
 * beforeTool hook, kept in their original order:
 *
 *   savePlanGuard   save_plan is auto-allowed in plan mode; other modes fall through to permissions/approval.
 *   writeModeGuard  file_editor read commands bypass; non-writes pass;
 *                   ask/plan deny writes (one-shot mode-blocked notice);
 *                   smart/bypass allow; code-mode writes delegate to the
 *                   approval stage. (Runs AFTER rules.)
 *
 * Full pipeline order: repeat → save_plan → permissions → write-mode → approval.
 */

import os from "node:os";
import path from "node:path";
import type { PreTool } from "../pipeline";
import type { AgentMode } from "../runner";

export function createSavePlanGuard(currentMode: () => AgentMode): PreTool {
	return async (call, next) => {
		if (call.name === "save_plan" && currentMode() === "plan") return { kind: "allow" };
		// Outside plan mode, save_plan falls through to permissions/approval —
		// saving a plan deliverable mid-run is a normal approved write.
		return next();
	};
}

/** Side-effecting tools outside WRITE_TOOL_NAMES that read-only modes (ask, plan) still refuse. */
export const READ_ONLY_DENY = new Set(["memory_write", "browser_click", "browser_type", "browser_eval"]);

export interface WriteModeGuardOptions {
	currentMode(): AgentMode;
	/** WRITE_TOOL_NAMES from tools/fileTools.ts — injected to avoid a tool import here. */
	writeTools: ReadonlySet<string>;
	/** Workspace root — required for the plan-mode write allowance (.kronyx/** + the OS temp dir). */
	root?: string;
	/** Plan document directory relative to root (default "plans") — the only
	 * user-content location plan mode may write, and only through approval. */
	planDir?: string;
	/** One-shot notice when a write is denied by mode. */
	onModeBlocked?: (mode: AgentMode) => void;
}

/** Plan mode may write only harness-owned scratch: <root>/.kronyx/** or the OS temp dir. */
const planWriteAllowed = (root: string, input: unknown): boolean => {
	const p = (input as { path?: unknown })?.path;
	if (typeof p !== "string" || !p) return false;
	const abs = path.resolve(root, p);
	const kronyx = path.join(root, ".kronyx") + path.sep;
	const tmp = path.resolve(os.tmpdir()) + path.sep;
	return abs.startsWith(kronyx) || abs.startsWith(tmp);
};

export function createWriteModeGuard(opts: WriteModeGuardOptions): PreTool {
	let warned = false;
	return async (call, next) => {
		if (call.name === "file_editor") {
			const cmd = (call.input as { command?: string })?.command;
			if (cmd === "view" || cmd === "symbols") return { kind: "allow" };
		}
		const mode = opts.currentMode();
		if ((mode === "ask" || mode === "plan") && READ_ONLY_DENY.has(call.name)) {
			return { kind: "deny", reason: `${call.name} is disabled in ${mode} mode. Switch to Code mode to use it.` };
		}
		if (!opts.writeTools.has(call.name)) return { kind: "allow" };
		if (mode === "plan" && opts.root && planWriteAllowed(opts.root, call.input)) return { kind: "allow" };
		// Plan mode's only legitimate file write is the plan document itself,
		// and even that goes through user approval. Other path-carrying writes
		// are implementation — denied outright, not deferred to approval, because
		// approving them one-by-one defeats the mode's purpose. Path-less writeish
		// tools (run_command, rename_symbol) can't be plan-doc writes but are
		// legitimately useful for planning-time verification — they fall through
		// to approval so the user decides case by case.
		if (mode === "plan") {
			const p = (call.input as { path?: unknown })?.path;
			if (typeof p === "string" && p && opts.root) {
				const abs = path.resolve(opts.root, p);
				const plans = path.resolve(opts.root, opts.planDir ?? "plans") + path.sep;
				if (!abs.startsWith(plans)) {
					return { kind: "deny", reason: `Writes in plan mode are limited to the plan document (${opts.planDir ?? "plans"}/). Save findings with save_plan; implementation belongs to a code-mode run — finish the plan and let the user start it.` };
				}
			}
			return next();
		}
		if (mode === "ask") {
			if (!warned) {
				warned = true;
				opts.onModeBlocked?.(mode);
			}
			return { kind: "deny", reason: "Writes are disabled in ask mode. Ask the user to switch to Plan, Code or Smart mode." };
		}
		if (mode === "smart" || mode === "bypass") return { kind: "allow" };
		return next();
	};
}
