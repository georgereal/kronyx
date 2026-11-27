/**
 * Behavior profiles (vscode-free). resolveBehaviorProfile starts from the
 * default composition and applies a registered profile's overrides, selected
 * on provider/model identity and adapter capabilities — never on transport
 * kind alone (the same provider can ride different transports, and one
 * transport can serve many providers). Profiles ship only real differences;
 * an absent profile means the default behavior is the provider's behavior.
 */

import { defaultBehavior, type HarnessBehavior } from "../core/behavior";
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

/** Defaults merged under the first matching profile's overrides. */
export function resolveBehaviorProfile(descriptor: ModelDescriptor): HarnessBehavior {
	const base = defaultBehavior();
	const profile = profiles.find((p) => p.matches(descriptor));
	return profile ? { ...base, ...profile.overrides } : base;
}
