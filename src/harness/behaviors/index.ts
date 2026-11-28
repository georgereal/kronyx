/**
 * Behavior profiles (vscode-free). resolveBehaviorProfile starts from the
 * default composition and applies a registered profile's overrides, selected
 * on provider/model identity and adapter capabilities — never on transport
 * kind alone (the same provider can ride different transports, and one
 * transport can serve many providers). Profiles ship only real differences;
 * an absent profile means the default behavior is the provider's behavior.
 */

import { defaultBehavior, type HarnessBehavior } from "../core/behavior";
import { makeContextPolicy } from "../defaults/context";
import { inputBudgetForWindow } from "../../context/adapters/harnessProjection";
import type { AdapterCapabilities } from "../core/contracts";

/** Normalized descriptor for profile selection. */
export interface ModelDescriptor {
	providerId: string;
	modelId: string;
	profile?: string;
	contextWindow?: number;
	maxOutputTokens?: number;
	capabilities?: AdapterCapabilities;
}

export interface BehaviorProfile {
	matches(d: ModelDescriptor): boolean;
	/** Only the stages that differ from the defaults. */
	overrides: Partial<HarnessBehavior>;
}

const profiles: BehaviorProfile[] = [];

export function registerBehaviorProfile(profile: BehaviorProfile): void {
	profiles.push(profile);
}

/** Defaults merged under the first matching profile's overrides. */
export function resolveBehaviorProfile(descriptor: ModelDescriptor): HarnessBehavior {
	const base = defaultBehavior();
	// The input budget is derived in real tokens: window minus the model's
	// output reserve minus the provider/tokenizer safety margin. A fixed budget
	// compacts a large-window model needlessly (amnesia loops) and a small-window
	// one far too late; chars-based heuristics miscount code by 20-40%.
	const budget = inputBudgetForWindow(descriptor.contextWindow, descriptor.maxOutputTokens);
	if (budget.inputTokens !== base.context.budgetTokens) base.context = makeContextPolicy(budget);
	const profile = profiles.find((p) => p.matches(descriptor));
	return profile ? { ...base, ...profile.overrides } : base;
}
