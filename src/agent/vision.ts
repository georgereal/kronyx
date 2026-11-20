/**
 * Vision fallback for image attachments (vscode-free — shared by the
 * extension and the cloud worker).
 *
 * Case 1: the coding model accepts image input — attachments ride as image
 * parts on the task message (AgentRunner.run). Case 2: it doesn't — the host
 * asks the user, then runs the images through a vision-capable model and
 * injects the task-conditioned description as text.
 */

import { DEFAULT_MAX_IMAGE_DECODED_BYTES } from "@cline/shared";

export interface ModelModalityInfo {
	id: string;
	pricing?: { input?: number; output?: number };
	modalities?: { input?: string[]; output?: string[] };
}

/** Whether the model can receive image parts. Fails open: an unknown
 *  modality list means "no signal", not a denial — stripping images from a
 *  vision-capable model would lose user content silently. */
export function acceptsImages(meta: { modalities?: { input?: string[] } } | undefined): boolean {
	const input = meta?.modalities?.input;
	if (!input?.length) return true;
	return input.includes("image");
}

/** Cheapest priced vision-capable model in the catalog; unpriced vision
 *  models are the backfill. Returns undefined when nothing can see images. */
export function pickVisionModel(models: readonly ModelModalityInfo[], currentModelId: string): string | undefined {
	const vision = models.filter((m) => m.id !== currentModelId && acceptsImages(m));
	const price = (m: ModelModalityInfo) => (m.pricing?.input ?? Infinity) + (m.pricing?.output ?? Infinity);
	const priced = vision.filter((m) => price(m) < Infinity).sort((a, b) => price(a) - price(b));
	return (priced[0] ?? vision[0])?.id;
}

const DESCRIBE_IMAGE_CAP = 4;

/** One /chat/completions call describing the attached images for the coding
 *  model. Returns undefined on any failure — callers proceed without. */
export async function describeImages(opts: {
	baseUrl: string;
	apiKey: string;
	modelId: string;
	task: string;
	images: readonly { filename: string; mime: string; data: Uint8Array }[];
}): Promise<string | undefined> {
	const images = opts.images.filter((i) => i.data.byteLength > 0 && i.data.byteLength <= DEFAULT_MAX_IMAGE_DECODED_BYTES).slice(0, DESCRIBE_IMAGE_CAP);
	if (!images.length || !opts.baseUrl || !opts.apiKey || !opts.modelId) return undefined;
	const content: unknown[] = [
		{
			type: "text",
			text:
				"The user attached the following image(s) as reference for the task below. " +
				"Describe them so a coding agent can implement or answer the task without seeing them: " +
				"UI layout and component structure, text/copy verbatim, colors and styling cues, " +
				"data or diagrams' content, and anything else the task needs. Be specific, not generic.\n\n" +
				`Task: ${opts.task.slice(0, 4000)}`,
		},
		...images.map((i) => ({
			type: "image_url",
			image_url: { url: `data:${i.mime};base64,${Buffer.from(i.data).toString("base64")}` },
		})),
	];
	const res = await fetch(`${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
		body: JSON.stringify({ model: opts.modelId, messages: [{ role: "user", content }], max_tokens: 2000 }),
		signal: AbortSignal.timeout(60_000),
	}).catch(() => undefined);
	if (!res?.ok) return undefined;
	const body = (await res.json().catch(() => undefined)) as { choices?: { message?: { content?: unknown } }[] } | undefined;
	const text = body?.choices?.[0]?.message?.content;
	return typeof text === "string" && text.trim() ? text.trim() : undefined;
}
