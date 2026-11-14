/**
 * Real E2B template builds via the SDK — the durable variant of
 * snapshot-baking (real templates don't age out and show in listTemplates).
 * Behind the `templateBuildApi` flag.
 *
 * Flow (verified against e2b@2.63): Template().fromDockerfile(df) serializes
 * the spec → buildInBackground does POST /v3/templates (allocates
 * templateID+buildID) then triggers POST /v2/templates/{id}/builds/{id} →
 * getBuildStatus polls /templates/{id}/builds/{id}/status.
 */
import { Template } from "e2b";

const POLL_MS = 15_000;
const TIMEOUT_MS = 45 * 60_000;

export async function buildE2bTemplate(apiKey: string, opts: { name: string; dockerfile: string }): Promise<{ templateId: string }> {
	const template = Template().fromDockerfile(opts.dockerfile);
	const data = await Template.buildInBackground(template, { alias: opts.name, apiKey });
	const deadline = Date.now() + TIMEOUT_MS;
	let logsOffset = 0;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, POLL_MS));
		const st = await Template.getBuildStatus(data, { apiKey, logsOffset });
		logsOffset = st.logEntries.length;
		if (st.status === "ready") return { templateId: data.templateId };
		if (st.status === "error") {
			const tail = st.logEntries.slice(-8).map((l) => l.message).join("\n");
			throw new Error(`template build failed: ${st.reason?.message ?? "unknown"}${tail ? `\n${tail}` : ""}`);
		}
	}
	throw new Error("template build timed out after 45m");
}
