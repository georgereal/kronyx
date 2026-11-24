import { spawn, type ChildProcess } from "node:child_process";
import type { AgentTool } from "@cline/shared";

/**
 * Background process registry — tracked alternatives to `cmd &` in
 * run_command. Children are spawned detached (own process group) so
 * killAll() tears the whole tree down when the run ends; nothing leaks a
 * dev server into the user's machine.
 *
 * The host disposes the registry at run end (run-finished/failed/stopped)
 * via `procs.dispose()`.
 */

const BUF_MAX = 200_000;
const TAIL_CHARS = 6_000;
const GRACE_MS = 2_000;

interface Proc {
	id: string;
	child: ChildProcess;
	command: string;
	pid: number;
	out: string;
	code: number | null;
	done: boolean;
}

export interface ProcTools {
	tools: AgentTool<any, string>[];
	/** Kill every tracked process group. Idempotent. */
	dispose(): void;
	/** Live process count — handy for run-end reporting/tests. */
	size(): number;
}

export function createProcessTools(opts: { root: string; isAborted?: () => boolean }): ProcTools {
	const procs = new Map<string, Proc>();
	let seq = 0;

	const kill = (p: Proc, sig: NodeJS.Signals) => {
		try {
			// Negative pid → the child's whole process group (detached spawn).
			process.kill(-p.pid, sig);
		} catch {
			try {
				p.child.kill(sig);
			} catch {
				/* already gone */
			}
		}
	};

	const track = (command: string): Proc | string => {
		let child: ChildProcess;
		try {
			child = spawn(command, { cwd: opts.root, shell: true, detached: true });
		} catch (e) {
			return `start_process: failed to spawn — ${e instanceof Error ? e.message : String(e)}`;
		}
		const p: Proc = { id: `p${++seq}`, child, command, pid: child.pid ?? 0, out: "", code: null, done: false };
		const append = (d: Buffer | string) => {
			p.out += d.toString();
			if (p.out.length > BUF_MAX) p.out = p.out.slice(p.out.length - BUF_MAX);
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.on("error", (e) => append(`\n[spawn error: ${e.message}]`));
		child.on("exit", (code) => {
			p.code = code;
			p.done = true;
		});
		procs.set(p.id, p);
		return p;
	};

	const status = (p: Proc) => {
		const state = p.done ? `exited (${p.code === null ? "signal" : `code ${p.code}`})` : "running";
		const tail = p.out.trim().slice(-TAIL_CHARS);
		return `${p.id} [${state}] ${p.command}\n${tail || "(no output yet)"}`;
	};

	const lookup = (id: string) => {
		const p = procs.get(String(id ?? "").trim());
		return p ?? `unknown process ${JSON.stringify(id)} — ids look like "p1".`;
	};

	const startProcess: AgentTool<{ command: string }, string> = {
		name: "start_process",
		description:
			"Start a background shell command (dev server, watcher, long test run) and return an id. Follow with poll_process for output/status and stop_process to end it. Prefer this over '&' in run_command — tracked processes are killed when the run ends.",
		inputSchema: {
			type: "object",
			properties: { command: { type: "string", description: "Shell command to run in the background." } },
			required: ["command"],
		},
		async execute(input) {
			const p = track(String(input.command ?? ""));
			if (typeof p === "string") return p;
			// Brief settle — immediate exits (bad command, port in use) surface here.
			await new Promise((r) => setTimeout(r, 400));
			return status(p);
		},
	};

	const pollProcess: AgentTool<{ id: string; wait_seconds?: number }, string> = {
		name: "poll_process",
		description: "Read a background process's recent output and status. wait_seconds blocks briefly for output — useful while a dev server boots.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Process id from start_process (p1, p2, …)." },
				wait_seconds: { type: "integer", minimum: 0, maximum: 60, description: "Seconds to wait for output before replying (default 0)." },
			},
			required: ["id"],
		},
		async execute(input) {
			const p = lookup(String(input.id ?? ""));
			if (typeof p === "string") return `poll_process: ${p}`;
			const wait = Math.min(Math.max(0, input.wait_seconds ?? 0), 60) * 1000;
			const deadline = Date.now() + wait;
			while (!p.done && Date.now() < deadline && !(opts.isAborted?.() ?? false))
				await new Promise((r) => setTimeout(r, 250));
			return status(p);
		},
	};

	const stopProcess: AgentTool<{ id: string }, string> = {
		name: "stop_process",
		description: "Terminate a background process (SIGTERM, then SIGKILL after a short grace).",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string", description: "Process id from start_process." } },
			required: ["id"],
		},
		async execute(input) {
			const p = lookup(String(input.id ?? ""));
			if (typeof p === "string") return `stop_process: ${p}`;
			if (!p.done) {
				kill(p, "SIGTERM");
				const deadline = Date.now() + GRACE_MS;
				while (!p.done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
				if (!p.done) kill(p, "SIGKILL");
			}
			return status(p);
		},
	};

	return {
		tools: [startProcess, pollProcess, stopProcess],
		dispose() {
			for (const p of procs.values()) {
				if (p.done) continue;
				kill(p, "SIGTERM");
				setTimeout(() => {
					if (!p.done) kill(p, "SIGKILL");
				}, GRACE_MS).unref?.();
			}
		},
		size: () => procs.size,
	};
}
