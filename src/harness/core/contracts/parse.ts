/**
 * Validators for the on-disk / wire format (vscode-free). Every parser throws
 * SchemaError with the offending path so a corrupt log fails loudly, never silently.
 */

export class SchemaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SchemaError";
	}
}


/** Compact description of what was actually received — object keys, array
 * length, or a truncated preview. Model-facing errors need this: "expected an
 * object" alone leaves the model guessing what it sent. */
const describe = (value: unknown): string => {
	if (value === undefined) return "missing";
	if (value === null) return "null";
	if (Array.isArray(value)) return `an array (${value.length} items)`;
	if (typeof value === "object") {
		const keys = Object.keys(value as object);
		return `an object with keys: ${keys.slice(0, 12).join(", ") || "(none)"}${keys.length > 12 ? "…" : ""}`;
	}
	if (typeof value === "string") return `a string: ${JSON.stringify(value.length > 80 ? value.slice(0, 80) + "…" : value)}`;
	return `${typeof value}: ${JSON.stringify(value)}`;
};

export const expectObject = (value: unknown, path: string): Record<string, unknown> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SchemaError(`${path}: expected an object, got ${describe(value)}`);
	return value as Record<string, unknown>;
};

export const expectString = (value: unknown, path: string, { allowEmpty = false } = {}): string => {
	if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
		throw new SchemaError(`${path}: expected a ${allowEmpty ? "" : "non-empty "}string, got ${describe(value)}`);
	}
	return value;
};

export const expectBoolean = (value: unknown, path: string): boolean => {
	if (typeof value !== "boolean") throw new SchemaError(`${path}: expected a boolean, got ${describe(value)}`);
	return value;
};

export const expectOptionalString = (value: unknown, path: string): string | undefined =>
	value === undefined ? undefined : expectString(value, path);

export const expectStringArray = (value: unknown, path: string): string[] => {
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new SchemaError(`${path}: expected an array of strings, got ${describe(value)}`);
	return value as string[];
};

export const expectInteger = (value: unknown, path: string, min = 0): number => {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min) throw new SchemaError(`${path}: expected an integer >= ${min}, got ${describe(value)}`);
	return value;
};

export const expectOneOf = <T extends string>(value: unknown, options: readonly T[], path: string): T => {
	if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
		throw new SchemaError(`${path}: expected one of ${options.join(", ")}, got ${describe(value)}`);
	}
	return value as T;
};
