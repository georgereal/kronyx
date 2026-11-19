/**
 * Approval guard: the last pre-execute stage. Resolves whatever reached it
 * (code-mode writes, or an explicit "ask" verdict from the chain tail) through
 * the interactive confirm provider. Absent provider or rejection → deny.
 */

import type { ApprovalsProvider } from "../seams";
import type { PreTool } from "../pipeline";

export function createApprovalGuard(approvals: ApprovalsProvider | undefined): PreTool {
	return async (call) => {
		if (!approvals) return { kind: "deny", reason: "No approval channel is available." };
		const allowed = await approvals.confirm(call.name, call.input);
		return allowed ? { kind: "allow" } : { kind: "deny", reason: "The user denied this change." };
	};
}
