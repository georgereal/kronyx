import type { ProviderSettings } from "../../../src/agent/runner";
import { describeCatalog, isSelectable, resolveTemplateName, type TemplateInfo } from "../../../src/sandbox/templateCatalog";
import { swallow } from "../lib/log";

const PROMPT = (task: string, catalog: string) => `You pick the E2B sandbox template (VM image) for a coding-agent run.

Task: ${task.slice(0, 600)}

Available templates for this account:
${catalog}

Reply with exactly one template name from the list — the best fit for the task. Pick "base" when nothing specialized applies. No explanation, just the name.`;

/**
 * Ask the run's model which sandbox image fits the task. Returns a validated
 * template alias, or null (caller falls back to settings default / base).
 * One cheap chat call on cold sandbox create — 15s timeout, never throws.
 */
export async function pickTemplate(provider: ProviderSettings, task: string, live: TemplateInfo[]): Promise<string | null> {
	if (!live.length || !provider.baseUrl || !provider.apiKey || !provider.modelId) return null;
	const base = provider.baseUrl.replace(/\/+$/, "");
	const res = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
		body: JSON.stringify({
			model: provider.modelId,
			messages: [{ role: "user", content: PROMPT(task, describeCatalog(live)) }],
			max_tokens: 32,
			temperature: 0,
		}),
		signal: AbortSignal.timeout(15_000),
	}).catch(swallow("pickTemplate", "op", null));
	if (!res?.ok) return null;
	const body = (await res.json().catch(swallow("pickTemplate", "op", null))) as
		| { choices?: { message?: { content?: string } }[] }
		| null;
	const raw = body?.choices?.[0]?.message?.content?.trim() ?? "";
	// Models love wrapping the answer — grab the first word that validates.
	// Strip surrounding punctuation/backticks too: "desktop," or "`desktop`" must still match.
	const words = raw.split(/\s+/).map((w) => w.replace(/^[^\w/.-]+|[^\w/.:-]+$/g, "")).filter(Boolean);
	const candidate = words.find((w) => isSelectable(w, live)) ?? (isSelectable(raw, live) ? raw : "");
	return candidate ? resolveTemplateName(candidate, live) : null;
}
