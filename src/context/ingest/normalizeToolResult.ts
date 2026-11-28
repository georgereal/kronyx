import type { NormalizeToolResultInput } from "../contracts/ports";
import type { ToolResultEnvelope } from "../contracts/execution";
import { sha256Text } from "../sharedCanonical";

const SUMMARY_LIMIT = 700;
const LARGE_OUTPUT_CHARS = 12_000;

const clip = (text: string, max = SUMMARY_LIMIT): string => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 80))}\n[… ${text.length - max + 80} chars truncated in summary]`);

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const countMatches = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

function commandSummary(output: string): { summary: string; structured: Record<string, unknown> } {
	const exit = /(?:^|\n)exit\s+(-?\d+)(?:\s|$)/i.exec(output)?.[1];
	const command = /^\s*[$>]\s*(.+)$/m.exec(output)?.[1];
	const failedTests = countMatches(output, /(?:^|\n)\s*(?:✕|×|FAIL(?:ED)?|failed)\s+[\w.()[\]<>/-]+/gi);
	const passed = /(\d+)\s+(?:tests?\s+)?passed/i.exec(output)?.[1];
	const failed = /(\d+)\s+(?:tests?\s+)?failed/i.exec(output)?.[1];
	const skipped = /(\d+)\s+(?:tests?\s+)?skipped/i.exec(output)?.[1];
	const errorLines = output.split("\n").filter((line) => /\b(error|exception|failed|failure|traceback|assert)\b/i.test(line)).slice(0, 4);
	const tail = output.trimEnd().split("\n").slice(-4).join("\n");
	const status = exit !== undefined ? `exit ${exit}` : "completed";
	const testPart = passed || failed || skipped ? `; tests ${passed ?? "?"} passed/${failed ?? "?"} failed/${skipped ?? "?"} skipped` : "";
	const errorPart = errorLines.length ? `; errors: ${oneLine(errorLines.join(" | ")).slice(0, 240)}` : "";
	return {
		summary: clip(`run_command ${status}${testPart}${errorPart}${!errorLines.length && tail ? `; tail: ${oneLine(tail).slice(0, 240)}` : ""}`),
		structured: {
			...(command ? { command } : {}),
			...(exit !== undefined ? { exitCode: Number(exit) } : {}),
			...(passed ? { passed: Number(passed) } : {}),
			...(failed ? { failed: Number(failed) } : {}),
			...(skipped ? { skipped: Number(skipped) } : {}),
			failedTestLines: failedTests || undefined,
			errorLines: errorLines.length ? errorLines : undefined,
		},
	};
}

function filePathFromInput(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const o = input as Record<string, unknown>;
	for (const key of ["path", "file", "filePath", "rel", "target_file"]) if (typeof o[key] === "string") return o[key];
	return undefined;
}

function genericSummary(toolName: string, input: unknown, output: string, ok: boolean): { summary: string; structured?: Record<string, unknown> } {
	const path = filePathFromInput(input);
	const lines = output ? output.split("\n").length : 0;
	if (/^run_command$/.test(toolName)) return { ...commandSummary(output) };
	if (/^(read_file|read_files|open_file)$/.test(toolName)) {
		return {
			summary: `${toolName} ${ok ? "read" : "failed to read"}${path ? ` ${path}` : ""}: ${output.length} chars, ${lines} lines.`,
			structured: { path, chars: output.length, lines },
		};
	}
	if (/^(write_file|edit_file|append_file|insert_lines|file_editor)$/.test(toolName)) {
		return {
			summary: `${toolName} ${ok ? "completed" : "failed"}${path ? ` on ${path}` : ""}: ${oneLine(output).slice(0, 220) || "no detail"}`,
			structured: { path, chars: output.length },
		};
	}
	if (/^(search_files|grep|list_files|glob|find_files)$/.test(toolName)) {
		const matches = countMatches(output, /\n/) + (output.trim() ? 1 : 0);
		return {
			summary: `${toolName} ${ok ? "returned" : "failed"} about ${matches} result line${matches === 1 ? "" : "s"}.`,
			structured: { resultLines: matches, chars: output.length },
		};
	}
	if (/^run_tests?/.test(toolName)) return { ...commandSummary(output) };
	return {
		summary: clip(`${toolName} ${ok ? "completed" : "failed"}: ${oneLine(output).slice(0, 300) || `${output.length} chars`}`),
		structured: { chars: output.length, lines },
	};
}

export function evidenceRefFor(toolExecutionId: string): string {
	return `execution://tool/${encodeURIComponent(toolExecutionId)}/full-output`;
}

/** Creates the stable ingestion envelope. Raw output remains in the ledger/artifact store; this is the compact model/context representation. */
export function normalizeToolResult(input: NormalizeToolResultInput): ToolResultEnvelope {
	const summary = genericSummary(input.toolName, input.input, input.output, input.ok);
	const truncated = input.output.length > LARGE_OUTPUT_CHARS || /truncated|elided|\[…/.test(input.output.slice(0, 2000));
	const critical = !input.ok || /^run_command$/.test(input.toolName) || /^run_tests?/.test(input.toolName);
	return {
		schemaVersion: 1,
		toolExecutionId: input.toolExecutionId,
		toolName: input.toolName,
		status: input.interrupted ? "interrupted" : input.ok ? "completed" : "failed",
		summary: summary.summary,
		...(summary.structured ? { structuredResult: summary.structured } : {}),
		evidenceRef: evidenceRefFor(input.toolExecutionId),
		truncated,
		rawChars: input.output.length,
		rawSha256: sha256Text(input.output),
		retentionClass: critical ? "critical" : input.output.length > LARGE_OUTPUT_CHARS ? "compactable" : "active",
		provenance: { source: "tool_execution", verification: input.ok ? "observed" : "unverified" },
	};
}
