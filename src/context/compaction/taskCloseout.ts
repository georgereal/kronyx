/** Deterministic end-of-run closeout extraction. Raw events remain authoritative; this is the durable compact handoff into later tasks. */

import type { SessionEvent } from "../../harness/core/contracts";
import type { CompactionRecord, TaskCloseoutRecord } from "../contracts/compaction";
import { zeroComponentVersions, type ComponentVersions } from "../contracts/execution";

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 80))}\n[… ${text.length - max + 80} chars elided; recover detail from the execution ledger]`);

const asRecord = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined);
const pathFromInput = (input: unknown): string | undefined => {
	const o = asRecord(input);
	if (!o) return undefined;
	for (const key of ["path", "file", "filePath", "rel", "target_file"]) if (typeof o[key] === "string") return o[key];
	return undefined;
};
const isWriteTool = (name: string): boolean => /^(write_file|edit_file|append_file|insert_lines|file_editor|apply_patch)/.test(name);
const isValidationCommand = (command: string): boolean => /test|spec|jest|vitest|pytest|go test|mvn test|gradle test|build|compile|tsc|lint|typecheck/i.test(command);

function versionsFor(events: readonly SessionEvent[], compactionVersion: number): ComponentVersions {
	const versions = zeroComponentVersions();
	versions.toolResultVersion = events.filter((e) => e.type === "tool.finished").length;
	versions.validationVersion = events.filter((e) => e.type === "verifier.result").length;
	versions.planVersion = events.filter((e) => e.type === "task.created" || e.type === "task.updated" || e.type === "step.updated").length;
	versions.fileChangeVersion = events.filter((e) => e.type === "tool.finished" && isWriteTool(e.name)).length;
	versions.compactionVersion = compactionVersion;
	versions.taskSummaryVersion = 1;
	return versions;
}

export interface RunCloseout {
	record: TaskCloseoutRecord;
	recapText: string;
	compaction: Omit<CompactionRecord, "summaryRef">;
}

/** Builds a compact, deterministic closeout for one run's events. */
export function buildRunCloseout(input: {
	events: readonly SessionEvent[];
	sessionId: string;
	runId: string;
	outcome: "completed" | "failed" | "stopped" | "paused";
	version: number;
	now?: Date;
}): RunCloseout | undefined {
	const events = input.events.filter((e) => e.runId === input.runId);
	if (!events.length) return undefined;
	const first = events[0]!.seq;
	const last = events.at(-1)!.seq;
	const user = events.find((e) => e.type === "user.input");
	const objective = clip(user?.type === "user.input" ? user.text.replace(/\s+/g, " ").trim() : "", 500);
	const finalResponse = [...events].reverse().find((e) => e.type === "model.response" && e.text.trim());
	const finalText = finalResponse?.type === "model.response" ? clip(finalResponse.text.trim(), 900) : "";
	// Pure conversational turns are ephemeral: writing a durable closeout for
	// every "hi"/one-line answer would churn the ledger without preserving
	// reusable execution knowledge. Work-bearing and substantive-answer runs
	// always close out.
	const meaningful = events.some((e) => e.type === "tool.finished" || e.type === "task.created" || e.type === "verifier.result") || finalText.length > 500;
	if (!meaningful) return undefined;
	const requested = new Map<string, { name: string; input: unknown }>();
	for (const event of events) if (event.type === "tool.requested") requested.set(event.callId, { name: event.name, input: event.input });
	const files = new Map<string, { path: string; evidenceRef?: string }>();
	const validationCommands: string[] = [];
	const validationRefs: string[] = [];
	const failures: string[] = [];
	const preserved = new Set<string>();
	let validationFailed = false;
	let validationPassed = false;
	for (const event of events) {
		if (event.type !== "tool.finished") continue;
		const req = requested.get(event.callId);
		const name = event.name || req?.name || "";
		if (event.envelope?.evidenceRef) preserved.add(event.envelope.evidenceRef);
		else if (event.evidenceRef) preserved.add(event.evidenceRef);
		if (isWriteTool(name) && event.ok) {
			const path = pathFromInput(req?.input);
			if (path) files.set(path, { path, ...(event.envelope?.evidenceRef || event.evidenceRef ? { evidenceRef: event.envelope?.evidenceRef ?? event.evidenceRef } : {}) });
		}
		const command = typeof asRecord(req?.input)?.command === "string" ? String(asRecord(req?.input)?.command) : "";
		if ((name === "run_command" || /^run_tests?/.test(name)) && command && isValidationCommand(command)) {
			validationCommands.push(command);
			if (event.envelope?.evidenceRef || event.evidenceRef) validationRefs.push(event.envelope?.evidenceRef ?? event.evidenceRef!);
			const exit = event.envelope?.structuredResult?.exitCode;
			if (event.ok && (exit === undefined || exit === 0)) validationPassed = true;
			else validationFailed = true;
		}
		if (!event.ok && failures.length < 6) failures.push(`${name || event.callId} failed at seq ${event.seq}`);
	}
	for (const event of events) {
		if (event.type !== "verifier.result") continue;
		if (event.command) validationCommands.push(event.command);
		validationRefs.push(`execution://seq/${event.seq}`);
		if (event.ok) validationPassed = true;
		else validationFailed = true;
	}
	const uniqueCommands = [...new Set(validationCommands)].slice(0, 10);
	const validationStatus = validationFailed && validationPassed ? "partial" : validationFailed ? "failed" : validationPassed ? "passed" : "not-run";
	const componentVersions = versionsFor(events, input.version);
	const createdAt = (input.now ?? new Date()).toISOString();
	const closeoutId = `closeout-${input.runId}-${last}`;
	const unresolvedIssues = failures.map((description) => ({ description, severity: "medium", evidenceRefs: [`execution://seq/${last}`] }));
	const priorCloseouts = input.events
		.filter((e): e is Extract<SessionEvent, { type: "context.closeout" }> => e.type === "context.closeout" && e.runId !== input.runId)
		.map((e) => e.record)
		.slice(-3)
		.map((r) => {
			const validation = r.validation.status === "not-run" ? "validation not run" : `validation ${r.validation.status}`;
			return clip(`${r.objective || "prior objective unavailable"} (${r.outcome}; ${validation})`, 220);
		});
	const summaryLines = [
		`Closeout of prior run (${input.outcome}):`,
		objective ? `Objective: ${objective}` : "",
		finalText ? `Final report: ${finalText}` : "",
		files.size ? `Files modified: ${[...files.keys()].slice(0, 20).join(", ")}` : "Files modified: none recorded",
		uniqueCommands.length ? `Validation (${validationStatus}): ${uniqueCommands.join("; ")}` : "Validation: not run",
		unresolvedIssues.length ? `Unresolved issues: ${unresolvedIssues.map((i) => i.description).join("; ")}` : "",
		`Evidence range: seq ${first}-${last}; use log_slice/recall_context for full outputs instead of re-deriving them.`,
		priorCloseouts.length ? `Earlier closeouts still relevant: ${priorCloseouts.join(" | ")}` : "",
	].filter(Boolean);
	const recapText = clip(summaryLines.join("\n"), 2200);
	const record: TaskCloseoutRecord = {
		schemaVersion: 1,
		closeoutId,
		sessionId: input.sessionId,
		runId: input.runId,
		sourceEventRange: { fromSeq: first, toSeq: last },
		objective,
		outcome: input.outcome,
		summary: recapText,
		decisions: [],
		filesModified: [...files.values()].map((f) => ({ path: f.path, ...(f.evidenceRef ? { evidenceRef: f.evidenceRef } : {}) })),
		validation: {
			status: validationStatus,
			...(uniqueCommands.length ? { commands: uniqueCommands } : {}),
			...(validationFailed ? { failureSummary: failures[0] ?? "validation failed" } : {}),
			evidenceRefs: [...new Set(validationRefs)].slice(0, 30),
		},
		unresolvedIssues,
		reusableKnowledgeRefs: [],
		preservedEvidenceRefs: [...preserved].slice(0, 60),
		componentVersions,
		version: input.version,
		createdAt,
	};
	const compaction: Omit<CompactionRecord, "summaryRef"> = {
		schemaVersion: 1,
		compactionId: `cmp-closeout-${input.runId}-${last}`,
		scope: "task_closeout",
		sourceEventRange: { from: first, to: last },
		preservedReferences: record.preservedEvidenceRefs,
		createdAt,
		version: input.version,
		componentVersions,
		modelGenerated: false,
	};
	return { record, recapText, compaction };
}
