/**
 * Append-only session log (vscode-free). The log stamps `seq` and `at`; it never
 * rewrites or removes an event. Two adapters: in-memory (tests, ephemeral runs)
 * and JSONL on disk (durable, one event per line, validated on open).
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { parseSessionEvent, type NewEvent, type SessionEvent } from "./contracts";

export interface EventLog {
	append(event: NewEvent): Promise<SessionEvent>;
	read(): Promise<SessionEvent[]>;
}

export class MemoryEventLog implements EventLog {
	private events: SessionEvent[] = [];

	constructor(private readonly now: () => number = Date.now) {}

	async append(event: NewEvent): Promise<SessionEvent> {
		const stamped = { ...event, seq: this.events.length + 1, at: this.now() } as SessionEvent;
		this.events.push(stamped);
		return stamped;
	}

	async read(): Promise<SessionEvent[]> {
		return [...this.events];
	}
}

export class FileEventLog implements EventLog {
	private events: SessionEvent[] = [];
	/** Bytes of the file already consumed — sync() resumes here. */
	private offset = 0;

	private constructor(
		private readonly path: string,
		private readonly now: () => number,
	) {}

	/** Opens (or creates) the log. Every existing line is validated and must carry the next seq. */
	static async open(path: string, now: () => number = Date.now): Promise<FileEventLog> {
		const log = new FileEventLog(path, now);
		const text = await fs.readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
			if (err.code === "ENOENT") return "";
			throw err;
		});
		log.events = log.parseLines(text.split("\n").filter((line) => line.trim()), 0);
		log.offset = Buffer.byteLength(text, "utf8");
		return log;
	}

	/** Parses `count`-less lines into events, enforcing seq continuity from `events.length`. */
	private parseLines(lines: string[], firstLineNo: number): SessionEvent[] {
		return lines.map((line, i) => {
			const where = `${this.path}:${firstLineNo + i + 1}`;
			let event: SessionEvent;
			try {
				event = parseSessionEvent(JSON.parse(line));
			} catch (err) {
				throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`);
			}
			const expected = this.events.length + i + 1;
			if (event.seq !== expected) throw new Error(`${where}: seq ${event.seq} out of order, expected ${expected}`);
			return event;
		});
	}

	/**
	 * Picks up events appended since the last open/sync. Only complete lines are
	 * consumed — a torn tail waits for the next sync. Returns the new-event count.
	 * A shrunken file is treated as rewritten and reloaded from scratch.
	 */
	async sync(): Promise<number> {
		const stat = await fs.stat(this.path).catch((err: NodeJS.ErrnoException) => {
			if (err.code === "ENOENT") return undefined;
			throw err;
		});
		if (!stat) return 0;
		if (stat.size < this.offset) {
			this.events = [];
			this.offset = 0;
		}
		if (stat.size === this.offset) return 0;
		const handle = await fs.open(this.path, "r");
		try {
			const buf = Buffer.alloc(stat.size - this.offset);
			let filled = 0;
			while (filled < buf.length) {
				const { bytesRead } = await handle.read(buf, filled, buf.length - filled, this.offset + filled);
				if (bytesRead === 0) break;
				filled += bytesRead;
			}
			const text = buf.subarray(0, filled).toString("utf8");
			const lastNl = text.lastIndexOf("\n");
			if (lastNl < 0) return 0;
			const chunk = text.slice(0, lastNl + 1);
			const lines = chunk.split("\n").filter((line) => line.trim());
			const parsed = this.parseLines(lines, this.events.length);
			this.events.push(...parsed);
			this.offset += Buffer.byteLength(chunk, "utf8");
			return parsed.length;
		} finally {
			await handle.close();
		}
	}

	async append(event: NewEvent): Promise<SessionEvent> {
		const stamped = { ...event, seq: this.events.length + 1, at: this.now() } as SessionEvent;
		await fs.mkdir(dirname(this.path), { recursive: true });
		const line = `${JSON.stringify(stamped)}\n`;
		await fs.appendFile(this.path, line, "utf8");
		this.events.push(stamped);
		this.offset += Buffer.byteLength(line, "utf8");
		return stamped;
	}

	async read(): Promise<SessionEvent[]> {
		return [...this.events];
	}
}
