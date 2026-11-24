"use client";

/**
 * Harness report section on /runs/[id] — uploaded by the IDE after a harness
 * run finishes (POST /api/harness-reports). Mirrors src/harness/report.ts.
 */

interface ReportStep {
	id: string;
	text: string;
	status: string;
	signal?: { tool: string; path?: string };
	evidence: string[];
}

interface ReportTask {
	id: string;
	title: string;
	status: string;
	acceptance: { kind: string; command?: string; rubric?: string };
	dependsOn: string[];
	steps: ReportStep[];
}

interface Intervention {
	seq: number;
	at: number;
	runId: string;
	kind: string;
	label: string;
	detail?: string;
}

export interface HarnessReport {
	generatedAt: number;
	runs: { runId: string; status?: string; startedAt: number; endedAt: number; turns: number; toolCalls: number; tasksCreated: number; tokensIn: number; tokensOut: number }[];
	board: { tasks: ReportTask[] };
	interventions: Intervention[];
	interventionsOmitted: number;
	context: {
		turns: number;
		toolCalls: number;
		toolFailures: number;
		refusals: number;
		tokens: { input: number; output: number; cached: number };
		bySource: { model: number; planner: number; tools: number; recap: number };
		recaps: number;
		clears: number;
		budgetWarnings: number;
	};
	execution: {
		tools: { name: string; calls: number; failures: number }[];
		stepsSignalDone: number;
		stepsCoveredAtCloseout: number;
		readFileCalls: number;
		readFilesCalls: number;
		exploreCalls: number;
		exploreTurns: number;
		maxReadOnlyStreak: number;
	};
}

const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
const fmtWhen = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const STEP_MARK: Record<string, string> = { done: "✓", in_progress: "◐", pending: "○", blocked: "✕" };

function statusColor(status: string): string {
	return status === "done" || status === "completed" ? "var(--ok)" : status === "blocked" || status === "failed" ? "var(--err)" : status === "in_progress" || status === "running" ? "#d4a017" : "var(--muted)";
}

export function HarnessReportSection({ report }: { report: HarnessReport }) {
	const c = report.context;
	const src = c.bySource;
	const srcTotal = src.model + src.planner + src.tools + src.recap || 1;
	const pct = (n: number) => `${Math.round((n / srcTotal) * 100)}%`;

	return (
		<div style={{ marginTop: 28 }}>
			<h2 style={{ fontSize: 15, marginBottom: 12 }}>Harness report</h2>

			{/* Plan & board */}
			<h3 style={{ fontSize: 12, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", margin: "16px 0 8px" }}>Plan &amp; board</h3>
			{report.board.tasks.length === 0 && <div className="card muted" style={{ padding: 12 }}>No task board — conversational run or the planner produced nothing.</div>}
			{report.board.tasks.map((t) => (
				<div key={t.id} className="card" style={{ padding: 12, marginBottom: 8 }}>
					<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
						<strong>{t.id} · {t.title}</strong>
						<span className="pill" style={{ color: statusColor(t.status), borderColor: statusColor(t.status) }}>{t.status}</span>
					</div>
					<div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
						acceptance: {t.acceptance.kind === "command" ? <code>{t.acceptance.command}</code> : t.acceptance.kind}
						{t.dependsOn.length > 0 && <> · depends on {t.dependsOn.join(", ")}</>}
					</div>
					<ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
						{t.steps.map((s) => (
							<li key={s.id} style={{ display: "flex", gap: 8, padding: "2px 0", alignItems: "baseline" }}>
								<span style={{ color: statusColor(s.status), width: 14, textAlign: "center" }}>{STEP_MARK[s.status] ?? "○"}</span>
								<span style={{ flex: 1 }}>
									{s.text}
									{s.signal && <code className="muted" style={{ fontSize: 11, marginLeft: 6 }}>on {s.signal.tool}{s.signal.path ? ` ${s.signal.path}` : ""}</code>}
									{s.evidence.length > 0 && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{s.evidence.length} call{s.evidence.length === 1 ? "" : "s"}</span>}
								</span>
							</li>
						))}
					</ul>
				</div>
			))}

			{/* Harness interventions */}
			<h3 style={{ fontSize: 12, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", margin: "16px 0 8px" }}>Harness interventions</h3>
			{report.interventions.length === 0 && <div className="card muted" style={{ padding: 12 }}>The harness never had to intervene.</div>}
			{report.interventions.length > 0 && (
				<div className="card" style={{ padding: "4px 12px" }}>
					{report.interventions.map((i) => (
						<div key={i.seq} style={{ display: "flex", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
							<span className="muted" style={{ width: 110, flex: "none", fontSize: 11 }}>{fmtWhen(i.at)}</span>
							<span style={{ width: 70, flex: "none", fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--accent)" }}>{i.kind}</span>
							<span style={{ flex: 1, minWidth: 0 }}>
								<strong>{i.label}</strong>
								{i.detail && <div className="muted" style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{i.detail}</div>}
							</span>
						</div>
					))}
					{report.interventionsOmitted > 0 && <div className="muted" style={{ padding: "6px 0", fontSize: 12 }}>…and {report.interventionsOmitted} earlier interventions omitted.</div>}
				</div>
			)}

			{/* Context & budget */}
			<h3 style={{ fontSize: 12, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", margin: "16px 0 8px" }}>Context &amp; budget</h3>
			<div className="card" style={{ padding: 12 }}>
				<div className="stat-grid" style={{ marginBottom: 0 }}>
					<div className="stat"><div className="label">Model turns</div><div className="value">{c.turns}</div></div>
					<div className="stat"><div className="label">Tool calls</div><div className="value">{c.toolCalls}</div></div>
					<div className="stat"><div className="label">Failures</div><div className="value">{c.toolFailures}</div></div>
					<div className="stat"><div className="label">Tokens in</div><div className="value">{fmtTok(c.tokens.input)}</div></div>
					<div className="stat"><div className="label">Tokens out</div><div className="value">{fmtTok(c.tokens.output)}</div></div>
					<div className="stat"><div className="label">Cached</div><div className="value">{fmtTok(c.tokens.cached)}</div></div>
					<div className="stat"><div className="label">Finish refusals</div><div className="value">{c.refusals}</div></div>
				</div>
				<div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", margin: "12px 0 6px", background: "var(--border)" }}>
					<div style={{ width: pct(src.model), background: "var(--accent)" }} title={`model ${pct(src.model)}`} />
					<div style={{ width: pct(src.planner), background: "#c586c0" }} title={`planner ${pct(src.planner)}`} />
					<div style={{ width: pct(src.tools), background: "var(--ok)" }} title={`tools/subagents ${pct(src.tools)}`} />
					<div style={{ width: pct(src.recap), background: "#d4a017" }} title={`recap ${pct(src.recap)}`} />
				</div>
				<div className="muted" style={{ fontSize: 12, display: "flex", gap: 14, flexWrap: "wrap" }}>
					<span><span style={{ color: "var(--accent)" }}>■</span> model {fmtTok(src.model)}</span>
					<span><span style={{ color: "#c586c0" }}>■</span> planner {fmtTok(src.planner)}</span>
					<span><span style={{ color: "var(--ok)" }}>■</span> tools/subagents {fmtTok(src.tools)}</span>
					<span><span style={{ color: "#d4a017" }}>■</span> recap {fmtTok(src.recap)}</span>
				</div>
				<div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
					recaps {c.recaps} · context clears {c.clears} · budget warnings {c.budgetWarnings}
				</div>
			</div>

			{/* Execution stats */}
			<h3 style={{ fontSize: 12, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", margin: "16px 0 8px" }}>Execution stats</h3>
			<div className="card" style={{ padding: 12 }}>
				<div className="muted" style={{ fontSize: 12, display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 8 }}>
					<span>steps proven by tool calls <strong>{report.execution.stepsSignalDone}</strong></span>
					<span>steps covered by acceptance <strong>{report.execution.stepsCoveredAtCloseout}</strong></span>
					<span><code>read_file</code> <strong>{report.execution.readFileCalls}</strong></span>
					<span><code>read_files</code> <strong>{report.execution.readFilesCalls}</strong></span>
					<span><code>explore_codebase</code> <strong>{report.execution.exploreCalls}</strong></span>
					<span>read-only turns <strong>{report.execution.exploreTurns}</strong></span>
					<span>max read streak <strong>{report.execution.maxReadOnlyStreak}</strong></span>
				</div>
				{report.execution.tools.length > 0 && (
					<table>
						<thead>
							<tr><th>Tool</th><th style={{ textAlign: "right" }}>Calls</th><th style={{ textAlign: "right" }}>Failed</th></tr>
						</thead>
						<tbody>
							{report.execution.tools.map((t) => (
								<tr key={t.name}>
									<td className="mono">{t.name}</td>
									<td style={{ textAlign: "right" }}>{t.calls}</td>
									<td style={{ textAlign: "right" }}>{t.failures || ""}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		</div>
	);
}
