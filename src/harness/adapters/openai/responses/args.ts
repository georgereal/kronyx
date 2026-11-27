/** Parses streamed tool arguments. Invalid JSON is kept as the raw string, so the ledger reports it as an input error. */
export function parseArguments(args: string): unknown {
	if (!args.trim()) return {};
	try {
		return JSON.parse(args);
	} catch {
		return args;
	}
}
