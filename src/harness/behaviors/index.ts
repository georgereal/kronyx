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
import type { AdapterCapabilities } from "../core/contracts";

/** Normalized descriptor for profile selection. */
export interface ModelDescriptor {
	providerId: string;
	modelId: string;
	profile?: string;
	contextWindow?: number;
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

/**
 * Budget share of the model window the harness may use before compacting.
 * The window must also carry the model's own output and the system/tools
 * overhead, so pressure starts well before the hard limit.
 */
const BUDGET_WINDOW_SHARE = 0.7;
/** Fallback when the window is unknown — matches the legacy fixed budget (~30k tokens). */
const FALLBACK_BUDGET_CHARS = 120_000;

/** Defaults merged under the first matching profile's overrides. */
export function resolveBehaviorProfile(descriptor: ModelDescriptor): HarnessBehavior {
	const base = defaultBehavior();
	// The compaction budget scales with the model's real window: a fixed budget
	// compacts a large-window model needlessly (amnesia loops) and a small-window
	// one far too late. Input tokens are per-request (usage.inputTokens), so the
	// recap trigger compares real per-turn size against this budget.
	const budgetChars = descriptor.contextWindow
		? Math.floor(descriptor.contextWindow * BUDGET_WINDOW_SHARE) * 4
		: FALLBACK_BUDGET_CHARS;
	if (budgetChars !== base.context.budgetChars) base.context = makeContextPolicy(budgetChars);
	const profile = profiles.find((p) => p.matches(descriptor));
	return profile ? { ...base, ...profile.overrides } : base;
}
