import * as os from "node:os";
import * as path from "node:path";

/**
 * Zero-config local embeddings: all-MiniLM-L6-v2 via ONNX in-process
 * (@huggingface/transformers). Used when kronyx.memory.embeddingModel is unset,
 * so memory/recall work without an embeddings API. The ~23MB quantized model
 * downloads once to ~/.kronyx/models.
 */
const MODEL = "Xenova/all-MiniLM-L6-v2";
export const LOCAL_DIM = 384;

type Pipeline = (texts: string[], opts: { pooling: string; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

let pipe: Promise<Pipeline> | undefined;

function extractor(): Promise<Pipeline> {
	pipe ??= (async () => {
		const { pipeline, env } = await import("@huggingface/transformers");
		env.cacheDir = path.join(os.homedir(), ".kronyx", "models");
		return (await pipeline("feature-extraction", MODEL, { dtype: "q8" })) as unknown as Pipeline;
	})();
	return pipe;
}

/** Why the last embedLocal call failed (for diagnostics) — e.g. Electron ABI
 *  mismatch on onnxruntime-node. */
export let localEmbedError = "";

/** Embeds texts locally. Returns [] if the model/runtime can't load — callers
 *  treat that as "embeddings unavailable" and fall back to keyword paths. */
export async function embedLocal(texts: string[]): Promise<Float32Array[]> {
	if (!texts.length) return [];
	try {
		const extract = await extractor();
		const out = await extract(texts, { pooling: "mean", normalize: true });
		return out.tolist().map((row) => new Float32Array(row));
	} catch (err) {
		localEmbedError = err instanceof Error ? err.message : String(err);
		return [];
	}
}
