/**
 * Permission guard: layered allow/ask/deny rule-file evaluation
 * (see agent/permissions.ts). deny short-circuits, allow short-circuits,
 * ask/no-match delegates to the rest of the pipeline (mode defaults decide).
 */

import type { PermissionDecision } from "../permissions";
import type { PreTool } from "../pipeline";

export function createPermissionGuard(check: (toolName: string, input: unknown) => Promise<PermissionDecision>): PreTool {
	return async (call, next) => {
		const rule = await check(call.name, call.input);
		if (rule === "deny") {
			return {
				kind: "deny",
				reason: `Denied by permissions rules — ${call.name} is not allowed here. Choose a different approach.`,
			};
		}
		if (rule === "allow") return { kind: "allow" };
		return next();
	};
}
