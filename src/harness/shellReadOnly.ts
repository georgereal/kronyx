/**
 * Conservative read-only shell classifier (vscode-free). A command counts as
 * read-only only when every pipeline segment runs a known read-only binary
 * with no writes possible: no redirects, no command substitution, no mutating
 * flags. False negatives just keep today's behavior (treated as a write);
 * false positives would let a write count as exploration, so the allowlist
 * stays tight.
 */

/** Binaries that never modify the filesystem or environment given plain args. */
const READ_BINARIES = new Set([
	"ls",
	"cat",
	"head",
	"tail",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"wc",
	"pwd",
	"stat",
	"file",
	"du",
	"df",
	"sort",
	"uniq",
	"tr",
	"cut",
	"nl",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"which",
	"type",
	"test",
	"[",
	"comm",
	"diff",
	"md5",
	"shasum",
	"column",
	"tac",
	"rev",
	"paste",
	"fold",
	"expand",
	"unexpand",
	"od",
	"xxd",
	"hexdump",
	"strings",
	"cd",
	"echo",
	"printf",
	"true",
	"jq",
	"yq",
	"tree",
]);

/** git subcommands that only read. Everything else (config writes, stash, checkout...) is out. */
const GIT_READ = new Set(["status", "log", "diff", "show", "branch", "remote", "tag", "ls-files", "ls-tree", "blame", "describe", "rev-parse", "rev-list", "grep", "shortlog", "reflog", "count-objects"]);

const tokenize = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean);

const segmentReadOnly = (segment: string): boolean => {
	const tokens = tokenize(segment);
	while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) tokens.shift();
	const [bin, ...args] = tokens;
	if (!bin) return false;
	if (bin === "git") {
		if (args[0] === "config") return args[1] === "--get" || args[1] === "--list" || args[1] === "-l" || args[1] === "--get-regexp";
		// `git branch foo` / `git remote add` / `git tag -d` write — bare or list flags only.
		if (args[0] === "branch" || args[0] === "remote" || args[0] === "tag") return args[1] === undefined || /^-[lvra]*$|--list/.test(args[1]);
		return args[0] !== undefined && GIT_READ.has(args[0]);
	}
	if (bin === "find") return !args.some((a) => a === "-delete" || a === "-exec" || a === "-execdir" || a === "-ok" || a === "-fls" || a === "-fprint");
	if (bin === "sed") return !args.some((a) => a === "-i" || a === "--in-place" || /^-[^-\s]*i/.test(a));
	if (bin === "jq" || bin === "yq") return !args.some((a) => a === "-i" || a === "--in-place");
	return READ_BINARIES.has(bin);
};

/** True only when every segment of the command is provably read-only. */
export function isReadOnlyCommand(command: string): boolean {
	if (!command.trim()) return false;
	// Command substitution or heredocs can execute arbitrary code.
	if (/[`<]|\$\(/.test(command)) return false;
	// Redirects write — except stderr dupes to /dev/null or onto stdout.
	const scrubbed = command.replace(/2>\/dev\/null/g, "").replace(/2>&1/g, "").replace(/1>&2/g, "").replace(/>&2/g, "");
	if (/>/.test(scrubbed)) return false;
	const segments = command.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean);
	return segments.length > 0 && segments.every(segmentReadOnly);
}
