import * as vscode from "vscode";

interface GitRepository {
	state: { HEAD?: { name?: string } };
	createBranch(name: string, checkout: boolean): Promise<void>;
	add(paths: string[]): Promise<void>;
	commit(message: string): Promise<void>;
}

interface GitApi {
	repositories: GitRepository[];
}

function api(): GitApi | undefined {
	try {
		const ext = vscode.extensions.getExtension("vscode.git");
		if (!ext) return undefined;
		const git = ext.isActive ? ext.exports : undefined;
		const candidate = (git?.getAPI?.(1) ?? git) as GitApi | undefined;
		return candidate?.repositories ? candidate : undefined;
	} catch {
		return undefined;
	}
}

export function getRepo(root: string): GitRepository | undefined {
	const repos = api()?.repositories ?? [];
	return repos.find((r) => root.startsWith(repoRoot(r))) ?? repos[0];
}

function repoRoot(repo: GitRepository): string {
	return (repo as unknown as { rootUri?: { fsPath?: string } }).rootUri?.fsPath ?? "";
}

export function currentBranch(repo: GitRepository): string {
	return repo.state.HEAD?.name ?? "";
}

export async function createBranch(repo: GitRepository, name: string): Promise<void> {
	await repo.createBranch(name, true);
}

export async function commitPaths(repo: GitRepository, paths: string[], message: string): Promise<void> {
	if (paths.length > 0) await repo.add(paths);
	await repo.commit(message);
}

export function slugify(text: string, max = 40): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/g, "");
	return slug || "run";
}
