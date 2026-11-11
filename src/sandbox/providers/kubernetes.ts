import { Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecResult, ProviderCreds, SandboxHandle, SandboxProvider } from "../provider";
import { swallow } from "../../lib/errlog";

/**
 * Kubernetes provider — one pod per session, exec via the k8s API.
 * The `@kubernetes/client-node` SDK is loaded lazily (variable specifier) so
 * this module typechecks and bundles without the dep installed; the backend
 * worker resolves it from its own node_modules at runtime.
 */
const K8S_PKG = "@kubernetes/client-node";
const DEFAULT_IMAGE = "node:22";

type K8sCtx = { api: any; exec: any; ns: string };

async function k8sCtx(creds: ProviderCreds): Promise<K8sCtx> {
	// eslint-disable-next-line @typescript-eslint/no-implied-eval
	const mod: any = await import(K8S_PKG);
	const kc = new mod.KubeConfig();
	if (creds.secrets.kubeconfig) kc.loadFromString(creds.secrets.kubeconfig);
	else kc.loadFromDefault();
	return { api: kc.makeApiClient(mod.CoreV1Api), exec: new mod.Exec(kc), ns: creds.secrets.k8sNamespace || "default" };
}

const podName = () => `kronyx-${randomUUID().slice(0, 12)}`;

/** Skip cluster calls for 60s after a failure — see listLive. */
let k8sDownUntil = 0;

async function waitRunning(api: any, ns: string, name: string, deadlineMs = 120_000): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		const pod = await api.readNamespacedPod({ name, namespace: ns }).catch(swallow("k8s", "op", null));
		const phase = pod?.status?.phase;
		if (phase === "Running") return;
		if (phase === "Failed" || phase === "Succeeded") throw new Error(`Pod ${name} entered ${phase}`);
		await new Promise((r) => setTimeout(r, 1_500));
	}
	throw new Error(`Pod ${name} not Running within ${deadlineMs / 1000}s`);
}

function execIn(ctx: K8sCtx, id: string, argv: string[], opts: { input?: string | Uint8Array; timeoutMs?: number } = {}): Promise<ExecResult> {
	let stdout = "";
	let stderr = "";
	const outStream = new Writable({ write: (chunk, _enc, cb) => ((stdout += chunk.toString()), cb()) });
	const errStream = new Writable({ write: (chunk, _enc, cb) => ((stderr += chunk.toString()), cb()) });
	return new Promise<ExecResult>((resolve) => {
		let settled = false;
		const done = (exitCode: number) => {
			if (settled) return;
			settled = true;
			resolve({ exitCode, stdout, stderr });
		};
		const timer = opts.timeoutMs ? setTimeout(() => done(124), opts.timeoutMs) : undefined;
		ctx.exec
			.exec(ctx.ns, id, "main", argv, outStream, errStream, null, false, (status: any) => {
				if (timer) clearTimeout(timer);
				done(status?.status === "Success" ? 0 : 1);
			})
			.catch((e: unknown) => {
				if (timer) clearTimeout(timer);
				stderr += String(e);
				done(1);
			});
	});
}

class K8sHandle implements SandboxHandle {
	constructor(
		private readonly ctx: K8sCtx,
		readonly id: string,
	) {}

	run(command: string, opts: { cwd: string; timeoutMs?: number }): Promise<ExecResult> {
		return execIn(this.ctx, this.id, ["sh", "-c", `cd ${JSON.stringify(opts.cwd)} && ${command}`], { timeoutMs: opts.timeoutMs });
	}

	async readFile(path: string): Promise<string> {
		const r = await execIn(this.ctx, this.id, ["cat", path]);
		if (r.exitCode !== 0) throw new Error(`readFile failed: ${r.stderr || r.stdout}`);
		return r.stdout;
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		const b64 = Buffer.from(content instanceof Uint8Array ? content : Buffer.from(content, "utf8")).toString("base64");
		const r = await execIn(this.ctx, this.id, ["sh", "-c", `echo ${b64} | base64 -d > ${JSON.stringify(path)}`]);
		if (r.exitCode !== 0) throw new Error(`writeFile failed: ${r.stderr || r.stdout}`);
	}
}

export const kubernetesProvider: SandboxProvider = {
	name: "kubernetes",
	capabilities: { pause: false, reconnect: true, orphanSweep: true },
	secretKeys: ["kubeconfig"],

	validate(creds) {
		// Configured via secret, KUBECONFIG, or ~/.kube/config — otherwise skip
		// entirely so listLive doesn't hammer a nonexistent cluster every poll.
		if (creds.secrets.kubeconfig) return null;
		if (process.env.KUBECONFIG || existsSync(join(homedir(), ".kube", "config"))) return null;
		return "No kubeconfig — set it in Settings → Secrets.";
	},

	async create(creds, opts) {
		const ctx = await k8sCtx(creds);
		const name = podName();
		const image = opts.template || creds.secrets.k8sImage || DEFAULT_IMAGE;
		await ctx.api.createNamespacedPod({
			namespace: ctx.ns,
			body: {
				metadata: { name, labels: { app: "kronyx" } },
				spec: {
					restartPolicy: "Never",
					containers: [{ name: "main", image, command: ["sleep", "infinity"], stdin: true, tty: false }],
				},
			},
		});
		await waitRunning(ctx.api, ctx.ns, name);
		return new K8sHandle(ctx, name);
	},

	async connect(id, creds) {
		const ctx = await k8sCtx(creds).catch(swallow("k8s", "op", null));
		if (!ctx) return null;
		const pod = await ctx.api.readNamespacedPod({ name: id, namespace: ctx.ns }).catch(swallow("k8s", "op", null));
		return pod?.status?.phase === "Running" ? new K8sHandle(ctx, id) : null;
	},

	async killById(id, creds) {
		const ctx = await k8sCtx(creds).catch(swallow("k8s", "op", null));
		if (!ctx) return false;
		await ctx.api.deleteNamespacedPod({ name: id, namespace: ctx.ns }).catch(swallow("k8s", "op"));
		return true;
	},

	async listLive(creds) {
		// Cooldown: a configured-but-unreachable cluster would otherwise log
		// "fetch failed" on every sandboxes poll.
		if (Date.now() < k8sDownUntil) return [];
		const ctx = await k8sCtx(creds).catch(swallow("k8s", "op", null));
		const res = ctx
			? await ctx.api.listNamespacedPod({ namespace: ctx.ns, labelSelector: "app=kronyx" }).catch(swallow("k8s", "op", null))
			: null;
		if (!ctx || !res) {
			k8sDownUntil = Date.now() + 60_000;
			return [];
		}
		return (res.items ?? [])
			.filter((p: any) => p.status?.phase === "Running" || p.status?.phase === "Pending")
			.map((p: any) => ({ id: String(p.metadata?.name ?? ""), startedAt: p.status?.startTime }));
	},
};
