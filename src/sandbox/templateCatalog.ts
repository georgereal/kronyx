/**
 * Capability catalog for E2B sandbox templates. Known public templates get a
 * description the model can reason over; account-built templates (E2B Pro,
 * `e2b template build`) are still selectable — presented as custom images
 * whose purpose is inferred from the name.
 */

export interface TemplateInfo {
	id: string;
	names: string[];
	public: boolean;
}

interface KnownTemplate {
	description: string;
	/** Warning shown to the model when the template has a trap. */
	caveat?: string;
}

const KNOWN_TEMPLATES: Record<string, KnownTemplate> = {
	base: { description: "Stock image — node/python/git, no GUI or browser tooling." },
	desktop: {
		description: "Ubuntu 22.04 + XFCE desktop, real X display, VNC, xdotool/scrot, LibreOffice. Use for GUI/Qt/desktop-app tasks (PyQt5, PySide, Tkinter).",
	},
	"code-interpreter-v1": {
		description: "Python data stack (numpy/pandas/matplotlib) + code-interpreter SDK.",
	},
	"kernel-browser": {
		description: "Kernel SDK + Playwright + browser-use for REMOTE cloud browsers.",
		caveat: "Browsers run on Kernel's managed infra — they cannot reach localhost inside this sandbox and need a separate KERNEL_API_KEY. Do not pick for testing apps running in this VM.",
	},
	claude: { description: "Claude Code CLI image.", caveat: "CLI-agent image — Kronyx's own agent loop runs in the sandbox, not this CLI; usually not needed." },
	codex: { description: "OpenAI Codex CLI image.", caveat: "CLI-agent image — usually not needed." },
	opencode: { description: "OpenCode CLI image.", caveat: "CLI-agent image — usually not needed." },
	openclaw: { description: "OpenClaw agent image.", caveat: "CLI-agent image — usually not needed." },
	amp: { description: "Amp CLI image.", caveat: "CLI-agent image — usually not needed." },
	droid: { description: "Factory Droid CLI image.", caveat: "CLI-agent image — usually not needed." },
	grok: { description: "Grok CLI image.", caveat: "CLI-agent image — usually not needed." },
	qm: { description: "QM agent image.", caveat: "CLI-agent image — usually not needed." },
	"qm-sandbox": { description: "QM sandbox image.", caveat: "CLI-agent image — usually not needed." },
	"e2b/pi": { description: "E2B Pi image." },
	k3s: { description: "Lightweight Kubernetes (k3s) image — use when the task needs a cluster." },
};

/**
 * E2B's public fleet — usable by name for Sandbox.create() but NOT returned by
 * GET /templates (that endpoint lists only team/account builds). Verified
 * against the public template catalog; merged with the API list in the
 * provider so callers see everything they can actually create.
 */
export const PUBLIC_E2B_TEMPLATES: TemplateInfo[] = [
	"base",
	"desktop",
	"code-interpreter-v1",
	"kernel-browser",
	"claude",
	"codex",
	"opencode",
	"openclaw",
	"amp",
	"droid",
	"grok",
	"qm",
	"qm-sandbox",
	"e2b/pi",
	"k3s",
].map((n) => ({ id: n, names: [n], public: true }));

const slugOf = (name: string): string => name.split(":")[0].replace(/^e2b\//, "");

/** Images that ship a competing agent CLI — useless as Kronyx's VM since our own loop runs inside. */
const AGENT_CLI_TEMPLATES = new Set(["claude", "codex", "opencode", "openclaw", "amp", "droid", "grok", "qm", "qm-sandbox"]);

export function isAgentCliTemplate(name: string): boolean {
	return AGENT_CLI_TEMPLATES.has(slugOf(name));
}

/**
 * True when `name` refers to a template the account can actually create:
 * matches a template ID or any of its alias names (with/without registry prefix).
 */
export function isSelectable(name: string, live: TemplateInfo[]): boolean {
	const want = slugOf(name.trim());
	return live.some((t) => t.id === name || t.names.some((n) => n === name || slugOf(n) === want));
}

/** Resolve a requested name to the canonical alias E2B accepts for create(). */
export function resolveTemplateName(name: string, live: TemplateInfo[]): string | null {
	const want = slugOf(name.trim());
	const hit = live.find((t) => t.id === name || t.names.some((n) => n === name || slugOf(n) === want));
	if (!hit) return null;
	return hit.names.find((n) => slugOf(n) === want)?.split(":")[0] ?? hit.names[0]?.split(":")[0] ?? hit.id;
}

/** Prompt-ready description of every usable template for the LLM pick. */
export function describeCatalog(live: TemplateInfo[]): string {
	return live
		.map((t) => {
			const alias = t.names[0]?.split(":")[0] ?? t.id;
			const known = KNOWN_TEMPLATES[alias] ?? KNOWN_TEMPLATES[t.id];
			const desc = known?.description ?? (t.public ? "Public image — purpose unclear from name." : "Account-built custom image — infer purpose from its name.");
			const caveat = known?.caveat ? ` CAVEAT: ${known.caveat}` : "";
			return `- ${alias}: ${desc}${caveat}`;
		})
		.join("\n");
}
