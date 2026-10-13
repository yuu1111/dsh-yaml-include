import { readFileSync, realpathSync, statSync } from "node:fs";
import {
	dirname,
	extname,
	isAbsolute,
	relative,
	resolve,
	sep,
} from "node:path";
import yaml from "js-yaml";

type IncludeErrorCode =
	| "FILE_UNAVAILABLE"
	| "INVALID_PATH"
	| "OUTSIDE_ROOT"
	| "CYCLE"
	| "LIMIT"
	| "INVALID_YAML";

interface ReaderOptions {
	maxDepth?: number;
	maxBytes?: number;
	maxFiles?: number;
	maxNodes?: number;
}

interface LoadState {
	stack: string[];
	bytes: number;
	files: number;
	sourceText?: string;
	schema?: yaml.Schema;
}

/**
 * Reports a YAML include failure without exposing source text or file paths.
 */
export class YamlIncludeError extends Error {
	/**
	 * Identifies the failure category independently of the diagnostic message.
	 */
	readonly code: IncludeErrorCode;

	/**
	 * Creates an include failure from safe diagnostic information.
	 *
	 * @param code - Failure category.
	 * @param message - Diagnostic text that contains no source text or paths.
	 * @param options - Error options containing only a sanitized cause, if any.
	 */
	constructor(code: IncludeErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "YamlIncludeError";
		this.code = code;
	}
}

function inside(root: string, path: string) {
	const part = relative(root, path);
	return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}

function sanitizedFailure(
	code: IncludeErrorCode,
	message: string,
	error: unknown,
): YamlIncludeError {
	// Original errors can retain YAML snippets and file paths in nested properties.
	const cause = new Error(
		error instanceof Error
			? "Underlying error details redacted"
			: "Underlying thrown value redacted",
	);
	return new YamlIncludeError(code, message, { cause });
}

/**
 * Reads local YAML includes within a canonical root and bounded resource limits.
 */
export class YamlIncludeReader {
	/**
	 * Canonical root used to confine every include, including symlink targets.
	 */
	readonly directory: string;

	/**
	 * Resource limits shared by file loading and expanded graph validation.
	 */
	readonly limits: Required<ReaderOptions>;

	/**
	 * Creates a reader confined to an existing local root.
	 *
	 * @param directory - Root directory resolved through the filesystem.
	 * @param options - Positive integer limits for depth, bytes, files, and nodes.
	 * @throws {@link YamlIncludeError} when the root cannot be resolved.
	 * @throws {@link TypeError} when a limit is not a positive safe integer.
	 */
	constructor(directory: string, options: ReaderOptions = {}) {
		const {
			maxDepth = 32,
			maxBytes = 1024 * 1024,
			maxFiles = 128,
			maxNodes = 100000,
		} = options;
		try {
			this.directory = realpathSync(directory);
		} catch (error) {
			throw sanitizedFailure(
				"FILE_UNAVAILABLE",
				"Cannot open YAML include root",
				error,
			);
		}
		this.limits = { maxDepth, maxBytes, maxFiles, maxNodes };
		for (const limit of Object.values(this.limits)) {
			if (!Number.isSafeInteger(limit) || limit < 1)
				throw new TypeError("Include limits must be positive integers");
		}
	}

	/**
	 * Reads and validates a YAML file with recursively expanded includes.
	 *
	 * @param filename - Relative YAML path beneath the root.
	 * @returns Parsed value after resource and alias validation.
	 * @throws {@link YamlIncludeError} when loading or validation fails.
	 */
	read(filename: string): unknown {
		return this.validate(
			this.load(filename, this.directory, { stack: [], bytes: 0, files: 0 }),
		);
	}

	/**
	 * Parses supplied root text while resolving nested includes from its location.
	 *
	 * @param content - Root YAML text counted toward the aggregate byte limit.
	 * @param filename - Relative root path; the root file need not exist.
	 * @param schema - Base schema extended with the include scalar type.
	 * @returns Parsed value after resource and alias validation.
	 * @throws {@link YamlIncludeError} when loading or validation fails.
	 */
	readText(
		content: string,
		filename: string,
		schema: yaml.Schema = yaml.JSON_SCHEMA,
	): unknown {
		return this.validate(
			this.load(filename, this.directory, {
				stack: [],
				bytes: 0,
				files: 0,
				sourceText: content,
				schema,
			}),
		);
	}

	/**
	 * Checks an expanded graph for resource limits, finite numbers, and cycles.
	 *
	 * @param value - Graph to inspect; repeated non-circular aliases are allowed.
	 * @returns The unchanged input value.
	 * @throws {@link YamlIncludeError} when a graph constraint is violated.
	 */
	validate(value: unknown): unknown {
		const ancestors = new Set<object>();
		let nodes = 0;
		let bytes = 0;
		const checkScalar = (node: unknown): void => {
			if (typeof node === "number" && !Number.isFinite(node))
				throw new YamlIncludeError(
					"INVALID_YAML",
					"YAML numbers must be finite",
				);
			if (typeof node === "string") bytes += Buffer.byteLength(node);
			if (bytes > this.limits.maxBytes)
				throw new YamlIncludeError(
					"LIMIT",
					"Expanded YAML byte limit exceeded",
				);
		};
		const visit = (node: unknown, depth: number): void => {
			if (++nodes > this.limits.maxNodes || depth > this.limits.maxDepth)
				throw new YamlIncludeError(
					"LIMIT",
					"Expanded YAML graph limit exceeded",
				);
			checkScalar(node);
			if (!node || typeof node !== "object") return;
			if (ancestors.has(node))
				throw new YamlIncludeError("CYCLE", "Circular YAML alias");
			ancestors.add(node);
			for (const [key, child] of Object.entries(node)) {
				bytes += Buffer.byteLength(key);
				visit(child, depth + 1);
			}
			ancestors.delete(node);
		};
		visit(value, 0);
		return value;
	}

	/**
	 * Loads one include using shared traversal state without graph validation.
	 *
	 * @param filename - Relative local YAML path supplied by an include scalar.
	 * @param base - Directory used to resolve the relative path.
	 * @param state - Shared file counters, include stack, and optional root text.
	 * @returns Parsed value with nested includes expanded.
	 * @throws {@link YamlIncludeError} when an include constraint or parse fails.
	 */
	load(filename: unknown, base: string, state: LoadState): unknown {
		const path = this.resolvePath(filename, base, state);
		this.checkFileLimits(path, state);
		const text = this.readSource(path, state);
		state.bytes += Buffer.byteLength(text);
		if (state.bytes > this.limits.maxBytes)
			throw new YamlIncludeError("LIMIT", "YAML include byte limit exceeded");
		state.stack.push(path);
		try {
			const include = new yaml.Type("!include", {
				kind: "scalar",
				construct: (child: unknown) => this.load(child, dirname(path), state),
			});
			return yaml.load(text, {
				schema: (state.schema ?? yaml.JSON_SCHEMA).extend(include),
			});
		} catch (error) {
			if (error instanceof YamlIncludeError) throw error;
			throw sanitizedFailure("INVALID_YAML", "Invalid YAML document", error);
		} finally {
			state.stack.pop();
		}
	}

	private resolvePath(
		filename: unknown,
		base: string,
		state: LoadState,
	): string {
		if (
			typeof filename !== "string" ||
			!filename ||
			isAbsolute(filename) ||
			/^[a-z][a-z0-9+.-]*:/i.test(filename)
		) {
			throw new YamlIncludeError(
				"INVALID_PATH",
				"Include requires a relative local YAML path",
			);
		}
		const candidate = resolve(base, filename);
		if (!inside(this.directory, candidate))
			throw new YamlIncludeError(
				"OUTSIDE_ROOT",
				"Include escapes configured root",
			);
		const path = this.canonicalPath(candidate, state);
		if (!inside(this.directory, path))
			throw new YamlIncludeError(
				"OUTSIDE_ROOT",
				"Include symlink escapes configured root",
			);
		if (![".yml", ".yaml"].includes(extname(path).toLowerCase()))
			throw new YamlIncludeError(
				"INVALID_PATH",
				"Include requires a .yml or .yaml file",
			);
		return path;
	}

	private canonicalPath(candidate: string, state: LoadState): string {
		try {
			return realpathSync(candidate);
		} catch (error) {
			if (state.stack.length === 0 && state.sourceText !== undefined)
				return candidate;
			throw sanitizedFailure(
				"FILE_UNAVAILABLE",
				"Cannot open YAML file",
				error,
			);
		}
	}

	private checkFileLimits(path: string, state: LoadState): void {
		if (state.stack.includes(path))
			throw new YamlIncludeError("CYCLE", "Circular YAML include");
		if (state.stack.length >= this.limits.maxDepth)
			throw new YamlIncludeError("LIMIT", "YAML include depth limit exceeded");
		if (++state.files > this.limits.maxFiles)
			throw new YamlIncludeError("LIMIT", "YAML include file limit exceeded");
	}

	private readSource(path: string, state: LoadState): string {
		try {
			if (state.stack.length === 0 && state.sourceText !== undefined)
				return state.sourceText;
			if (!statSync(path).isFile()) throw new Error();
			if (statSync(path).size > this.limits.maxBytes - state.bytes)
				throw new YamlIncludeError("LIMIT", "YAML include byte limit exceeded");
			return readFileSync(path, "utf8");
		} catch (error) {
			if (error instanceof YamlIncludeError) throw error;
			throw sanitizedFailure(
				"FILE_UNAVAILABLE",
				"Cannot read YAML file",
				error,
			);
		}
	}
}
