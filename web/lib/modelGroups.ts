import type { ModelGroup } from "./types";

/** Narrow provider groups to one profile (empty = all) and a search query over id, label and owner. */
export function filterModelGroups(groups: ModelGroup[], profile: string, query: string): ModelGroup[] {
	const q = query.trim().toLowerCase();
	return groups
		.filter((g) => !profile || g.profile === profile)
		.map((g) => ({ ...g, models: g.models.filter((m) => !q || `${m.id} ${m.label ?? ""} ${m.owner ?? ""}`.toLowerCase().includes(q)) }))
		.filter((g) => g.models.length > 0);
}
