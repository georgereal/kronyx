/** Upload-size cap for run events and memory details (vscode-free, unit-testable). */

export function safeJson(v: unknown): unknown {
	try {
		return JSON.parse(String(v));
	} catch {
		return v;
	}
}

/** Per-event cap on the upload. The local row keeps the full payload; only the wire copy is truncated. */
export const EVENT_WIRE_CAP = 16 * 1024;

/**
 * Upload form of one run event. Payloads larger than EVENT_WIRE_CAP are replaced
 * by a truncated preview plus a marker, so one large tool result cannot push a
 * batch past the server's body limit or fill the database.
 */
export function capEventForWire(raw: unknown, cap = EVENT_WIRE_CAP): unknown {
	if (raw === null || raw === undefined) return null;
	const text = String(raw);
	if (text.length <= cap) return safeJson(text);
	return { truncated: true, originalBytes: Buffer.byteLength(text, "utf8"), preview: text.slice(0, cap) };
}
