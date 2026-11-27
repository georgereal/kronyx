/**
 * Steering policy (vscode-free). Supplies the ordered hook rules the kernel
 * runs at beforeModel/beforeTool/afterTool/onStop/onError. Shared safety and
 * permission checks stay in the kernel and the host — a profile can add or
 * tune rules, never remove the mandatory ones.
 */

import type { RegisteredRule } from "../../defaults/steering";

export interface SteeringPolicy {
	rules(opts: { writable: boolean; runId: string }): RegisteredRule[];
}
