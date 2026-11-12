import type { AgentTool } from "@cline/shared";
import type { SandboxHandle } from "../sandbox/provider";

export const BROWSER_DRIVER_PATH = "/tmp/kronyx_browser_use.py";
const ENV_PATH = "/tmp/kronyx_bu_env.sh";
const SHOTS_DIR = ".kronyx/shots";
const MAX_STEPS = 30;
const TIMEOUT_MS = 5 * 60_000;

export interface BrowserToolOptions {
	/** Provider creds for the embedded browser-use LLM (OpenAI-compatible endpoint). */
	apiKey: string;
	baseUrl: string;
	modelId: string;
	/** Called with a PNG data URL when the browser agent captures a screenshot — sinks it into the session timeline. */
	onScreenshot?: (dataUrl: string, label?: string) => void;
}

/**
 * Python driver executed inside the sandbox. Two modes:
 *   --task "..." [--url U] [--steps N]  → browser-use agent, prints KRONYX_RESULT:{json}
 *   --shot URL OUT.png                  → one-shot Playwright screenshot (no LLM)
 * Kept dependency-light: works with browser-use ≥0.1 and playwright sync API.
 */
export const BROWSER_DRIVER = `import argparse, asyncio, base64, json, os, sys

def shot(url, out):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        page = b.new_page(viewport={"width": 1280, "height": 800})
        page.goto(url, wait_until="networkidle", timeout=30000)
        page.screenshot(path=out, full_page=False)
        b.close()
    print("KRONYX_SHOT:" + base64.b64encode(open(out, "rb").read()).decode())

async def run(task, url, steps, shots_dir):
    try:
        from browser_use import Agent
    except ImportError:
        print("KRONYX_RESULT:" + json.dumps({"ok": False, "error": "browser-use not installed — use a template with browser tooling (see backend/e2b-template)"}))
        return
    try:
        from browser_use.llm import ChatOpenAI
    except ImportError:
        from browser_use import ChatOpenAI
    llm = ChatOpenAI(
        model=os.environ.get("KRONYX_BU_MODEL", "gpt-4o-mini"),
        api_key=os.environ["KRONYX_BU_KEY"],
        base_url=os.environ.get("KRONYX_BU_BASE") or None,
    )
    os.makedirs(shots_dir, exist_ok=True)
    full_task = f"Start at {url}. {task}" if url else task
    agent = Agent(task=full_task, llm=llm)
    shot = ""
    try:
        history = await agent.run(max_steps=steps)
        result = history.final_result() or ""
        errors = [e for e in history.errors() if e][:5]
        try:
            b64 = await agent.browser_session.take_screenshot()
            if b64:
                shot = os.path.join(shots_dir, "final.png")
                with open(shot, "wb") as f:
                    f.write(base64.b64decode(b64))
        except Exception:
            pass
        print("KRONYX_RESULT:" + json.dumps({"ok": True, "result": str(result)[:4000], "steps": len(history.history), "errors": [str(e)[:300] for e in errors], "screenshot": shot}))
    except Exception as e:
        print("KRONYX_RESULT:" + json.dumps({"ok": False, "error": str(e)[:500]}))

ap = argparse.ArgumentParser()
ap.add_argument("--task")
ap.add_argument("--url", default="")
ap.add_argument("--steps", type=int, default=${MAX_STEPS})
ap.add_argument("--shots", default="${SHOTS_DIR}")
ap.add_argument("--shot", help="screenshot mode: URL")
ap.add_argument("--out", default="/tmp/kronyx_shot.png")
a = ap.parse_args()
if a.shot:
    shot(a.shot, a.out)
else:
    asyncio.run(run(a.task or "", a.url, a.steps, a.shots))
`;

/** One-shot Playwright screenshotter used by the post-run verify step. */
export const SCREENSHOT_PATH = "/tmp/kronyx_shot.png";

export function createBrowserTools(sandbox: SandboxHandle, workdir: string, opts: BrowserToolOptions): AgentTool<any, string>[] {
	const run = (command: string, timeoutMs = 60_000): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
		sandbox.run(command, { cwd: workdir, timeoutMs });

	let driverReady: Promise<boolean> | undefined;
	const ensureDriver = (): Promise<boolean> => {
		driverReady ??= (async () => {
			const probe = await run(`python3 -c "import browser_use" 2>/dev/null`, 15_000);
			if (probe.exitCode !== 0) return false;
			await sandbox.writeFile(BROWSER_DRIVER_PATH, BROWSER_DRIVER);
			// Creds ride in a 0600 env file, never in the command line (tool
			// inputs/outputs are persisted to run_events).
			const env =
				`export KRONYX_BU_KEY=${JSON.stringify(opts.apiKey)}\n` +
				`export KRONYX_BU_BASE=${JSON.stringify(opts.baseUrl)}\n` +
				`export KRONYX_BU_MODEL=${JSON.stringify(opts.modelId)}\n`;
			await sandbox.writeFile(ENV_PATH, env);
			await run(`chmod 600 ${ENV_PATH}`, 10_000);
			return true;
		})().catch(() => false);
		return driverReady;
	};

	const browserUse: AgentTool<{ task: string; url?: string; max_steps?: number }, string> = {
		name: "browser_use",
		description:
			"Drive a headless browser inside the workspace to test a running web app: navigate, click, fill forms, and report what it sees. " +
			"Start the app with run_command first (background it, e.g. 'npm run dev &'), then pass the local URL and a natural-language goal. " +
			"Returns the agent's findings, errors encountered, and a final screenshot path under .kronyx/shots/.",
		inputSchema: {
			type: "object",
			properties: {
				task: { type: "string", description: "What to do/verify in the browser, e.g. 'log in with test@x.com/test and confirm the dashboard loads'." },
				url: { type: "string", description: "Starting URL, e.g. http://localhost:3000. Optional but recommended." },
				max_steps: { type: "integer", minimum: 1, maximum: 50, description: `Step cap, default ${MAX_STEPS}.` },
			},
			required: ["task"],
		},
		async execute(input) {
			if (!(await ensureDriver())) {
				return "Browser tooling is not installed in this sandbox (browser_use missing). Set an E2B template built from backend/e2b-template on this session, or ask the user.";
			}
			const steps = Math.min(Math.max(1, input.max_steps ?? MAX_STEPS), 50);
			const cmd =
				`. ${ENV_PATH} && python3 ${BROWSER_DRIVER_PATH} --task ${JSON.stringify(input.task)}` +
				(input.url ? ` --url ${JSON.stringify(input.url)}` : "") +
				` --steps ${steps} --shots ${JSON.stringify(`${workdir}/${SHOTS_DIR}`)}`;
			const r = await run(cmd, TIMEOUT_MS);
			const line = (r.stdout + "\n" + r.stderr).split("\n").find((l) => l.startsWith("KRONYX_RESULT:"));
			if (!line) {
				const out = `${r.stdout}${r.stderr}`.trim();
				return `browser_use failed to produce a result (exit ${r.exitCode}).\n${out.slice(0, 2000)}`;
			}
			try {
				const res = JSON.parse(line.slice("KRONYX_RESULT:".length)) as {
					ok?: boolean; result?: string; steps?: number; errors?: string[]; screenshot?: string; error?: string;
				};
				if (!res.ok) return `browser_use failed: ${res.error ?? "unknown error"}`;
				if (res.screenshot && opts.onScreenshot) {
					const shotR = await run(`base64 -w0 ${JSON.stringify(res.screenshot)}`, 15_000);
					const b64 = shotR.stdout.trim();
					if (shotR.exitCode === 0 && b64 && b64.length <= 800_000) {
						opts.onScreenshot(`data:image/png;base64,${b64}`, input.url);
					}
				}
				const shot = res.screenshot ? `\nScreenshot: ${res.screenshot.replace(`${workdir}/`, "")}` : "";
				const errs = res.errors?.length ? `\nPage/browser errors: ${res.errors.join(" | ")}` : "";
				return `browser_use completed in ${res.steps ?? "?"} step(s).\n${res.result || "(no result text)"}${errs}${shot}`;
			} catch {
				return `browser_use returned unparseable output: ${line.slice(0, 1000)}`;
			}
		},
	};

	return [browserUse];
}
