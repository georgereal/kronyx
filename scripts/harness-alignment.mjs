#!/usr/bin/env node
/**
 * harness-alignment.mjs — reconstruct the plan/harness/execution alignment from
 * a session's durable harness log (.kronyx/harness/<session>.jsonl).
 *
 * For every seeded or planned step it shows:
 *   - the step text and its signal (what the harness watches for)
 *   - how the step closed: AUTO (a matching call hit the signal) or MANUAL
 *     (the model called task_step_update) or never
 *   - the proving calls attached as evidence
 * and a timeline of run_command calls with hit/miss against the then-active
 * step's signal, so signal mismatches are visible at a glance.
 *
 * Usage: node scripts/harness-alignment.mjs <session.jsonl> [--timeline]
 */

import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
	console.error("usage: node scripts/harness-alignment.mjs <session.jsonl> [--timeline]");
	process.exit(1);
}
const events = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

const tasks = new Map(); // id -> {title, steps: Map(sid -> {text, signal, status, callIds, closedBy})}
const order = [];
const calls = new Map(); // callId -> {name, input, ok, seq}
const timeline = [];

const tokenMatch = (sig, cmd) => {
	if (cmd.includes(sig)) return true;
	const tokens = sig.split(/\s+/).filter(Boolean);
	let at = 0;
	for (const tok of cmd.split(/\s+/)) {
		if (at < tokens.length && (tok === tokens[at] || tok.endsWith(`/${tokens[at]}`))) at++;
	}
	return at === tokens.length;
};

for (const e of events) {
	switch (e.type) {
		case "task.created": {
			const t = e.task;
			if (!tasks.has(t.id)) order.push(t.id);
			tasks.set(t.id, {
				title: t.title,
				steps: new Map(
					t.steps.map((s) => [
						s.id,
						{ text: s.text, signal: s.signal, status: "pending", callIds: [], closedBy: undefined },
					]),
				),
			});
			break;
		}
		case "task.updated": {
			break;
		}
		case "step.updated": {
			const t = tasks.get(e.taskId);
			const s = t?.steps.get(e.stepId);
			if (s) {
				s.status = e.to;
				if (e.to === "done") {
					s.callIds = e.callIds ?? [];
					// manual close = the step update carries several evidence ids (harness-attached)
					// auto close = exactly one call id, the signal hit itself
					s.closedBy = (e.callIds ?? []).length === 1 ? "auto?" : "manual?";
				}
			}
			break;
		}
		case "tool.requested": {
			calls.set(e.callId, { name: e.name, input: e.input, seq: e.seq });
			break;
		}
		case "tool.finished": {
			const c = calls.get(e.callId) ?? { name: e.name, input: e.input };
			c.ok = e.ok;
			c.output = typeof e.output === "string" ? e.output.slice(0, 60) : "";
			calls.set(e.callId, c);
			if (e.name === "run_command") timeline.push({ seq: e.seq, callId: e.callId, input: c.input, ok: e.ok });
			break;
		}
	}
}

// distinguish auto vs manual: a step closed by a model task_step_update call is manual;
// steps closed without any task_step_update naming them are auto (harness signal hit).
const manualCloses = new Set();
for (const c of calls.values()) {
	if (c.name !== "task_step_update") continue;
	const inp = c.input ?? {};
	const tid = inp.taskId ?? inp.id;
	const sid = inp.stepId;
	if (tid && sid) manualCloses.add(`${tid}/${sid}`);
}

console.log("STEP ALIGNMENT — plan step → signal → how it closed → proving calls\n");
for (const tid of order) {
	const t = tasks.get(tid);
	console.log(`${tid}  ${t.title}`);
	for (const [sid, s] of t.steps) {
		const sig = s.signal ? `${s.signal.tool}${s.signal.path ? ` "${s.signal.path}"` : ""}` : "—";
		const how = s.status !== "done" ? s.status : manualCloses.has(`${tid}/${sid}`) ? "done MANUAL" : "done AUTO";
		const proofs = s.callIds
			.map((id) => {
				const c = calls.get(id);
				if (!c) return `${id.slice(0, 10)}?`;
				const tgt = c.input?.command ?? c.input?.path ?? (Array.isArray(c.input?.files) ? c.input.files.map((f) => f.path).join(",") : "") ?? "";
				return `${c.name}(${String(tgt).slice(0, 40)})`;
			})
			.join(", ");
		console.log(`  ${sid} [${how}] sig=${sig}`);
		console.log(`      text: ${s.text.slice(0, 90)}`);
		if (proofs) console.log(`      proof: ${proofs}`);
	}
	console.log();
}

if (process.argv.includes("--timeline")) {
	console.log("RUN_COMMAND TIMELINE — every command vs matching step signals\n");
	for (const row of timeline) {
		const cmd = row.input?.command ?? "";
		const hits = [];
		for (const tid of order) {
			for (const [sid, s] of tasks.get(tid).steps) {
				if (s.signal?.tool === "run_command" && s.signal.path && tokenMatch(s.signal.path, cmd)) hits.push(`${tid}/${sid}`);
			}
		}
		console.log(`  seq${row.seq} ok=${row.ok} ${cmd.slice(0, 70)}`);
		console.log(`      hits: ${hits.length ? hits.join(", ") : "NO SIGNAL MATCHED"}`);
	}
}
