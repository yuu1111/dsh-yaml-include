#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VERSION = "0.2.0-rc.2";
export const MARKER = "// dsh-yaml-include adapter v1";
const helperDirectory = dirname(fileURLToPath(import.meta.url));

interface InstallOptions {
	dshDir?: string;
	uninstall?: boolean;
	dryRun?: boolean;
	sourceDir?: string;
	backupDir?: string;
}

interface BackupFile {
	path: string;
	installedHash: string;
	originalHash: string | null;
}

interface BackupManifest {
	root: string;
	version: string;
	format: number;
	files: BackupFile[];
}

interface Change {
	path: string;
	current: Buffer | null;
	original: Buffer | null;
	next: Buffer | null;
}

interface InstallResult {
	status:
		| "not-installed"
		| "dry-run"
		| "uninstalled"
		| "installed"
		| "unchanged";
	changed: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function isBackupFile(value: unknown): value is BackupFile {
	return (
		isRecord(value) &&
		typeof value.path === "string" &&
		typeof value.installedHash === "string" &&
		(value.originalHash === null || typeof value.originalHash === "string")
	);
}

function readManifest(content: Buffer | null): BackupManifest | null {
	if (content === null) return null;
	const value: unknown = JSON.parse(content.toString());
	if (
		!isRecord(value) ||
		typeof value.root !== "string" ||
		typeof value.version !== "string" ||
		typeof value.format !== "number" ||
		!Array.isArray(value.files) ||
		!value.files.every(isBackupFile)
	)
		throw new Error("Invalid adapter backup manifest");
	return {
		root: value.root,
		version: value.version,
		format: value.format,
		files: value.files,
	};
}

const packages = ["dsh-app-boot", "cordis-plugin-include", "dsh-config-editor"];
const hash = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");
const read = (path: string) => (existsSync(path) ? readFileSync(path) : null);
const same = (left: Buffer | null, right: Buffer | null) =>
	left === null ? right === null : right !== null && left.equals(right);

function replaceOnce(text: string, before: string, after: string) {
	if (text.split(before).length !== 2)
		throw new Error("Expected exactly one adapter site: " + before);
	return text.replace(before, after);
}

export function patchBundle(content: string, packageName: string) {
	if (content.includes(MARKER)) throw new Error("Unmanaged adapter marker");
	const sites: [string, string][] | null =
		packageName === "dsh-app-boot"
			? [
					[
						"yaml.load(content, { schema: entryListSchema })",
						"parseYamlWithIncludes(content, this.filename, entryListSchema)",
					],
					[
						'load(readFileSync(filename, "utf8"), { schema: entryListSchema })',
						'parseYamlWithIncludes(readFileSync(filename, "utf8"), filename, entryListSchema)',
					],
					[
						"yaml.load(content, { schema: userPatchesSchema })",
						"parseYamlWithIncludes(content, file, userPatchesSchema)",
					],
				]
			: packageName === "cordis-plugin-include"
				? [
						[
							"yaml.load(content, { schema: entryListSchema })",
							"parseYamlWithIncludes(content, this.filename, entryListSchema)",
						],
					]
				: packageName === "dsh-config-editor"
					? [
							[
								'tag: "tag:yaml.org,2002:js",\n					resolve: (value) => value\n				}]',
								'tag: "tag:yaml.org,2002:js",\n					resolve: (value) => value\n				}, { tag: "!include", resolve: (value) => value }]',
							],
							[
								'if (!isSeq(document.contents)) throw new Error("Profile patch must be a YAML sequence");',
								'if (!isSeq(document.contents)) throw new Error("Profile patch must be a YAML sequence");\n				assertEditableIncludeRows(document, entry.options.id);',
							],
							[
								"yaml.load(String(document), { schema: entryListSchema })",
								"parseYamlWithIncludes(String(document), path, entryListSchema)",
							],
						]
					: null;
	if (!sites) throw new Error("Unknown adapter package");
	if (packageName === "dsh-app-boot") {
		content = replaceOnce(
			content,
			'source = extension === ".json" ? JSON.parse(content) : yaml.load(content, { schema: entryListSchema });',
			'source = extension === ".json" ? JSON.parse(content) : parseYamlWithIncludes(content, filename, entryListSchema);',
		);
		content = replaceOnce(
			content,
			"parsed = yaml.load(content, { schema: entryListSchema });",
			"parsed = parseYamlWithIncludes(content, absoluteConfigPath, entryListSchema);",
		);
	}
	for (const [before, after] of sites)
		content = replaceOnce(content, before, after);
	if (packageName !== "dsh-config-editor")
		content = replaceOnce(
			content,
			"async _writeFile(config) {",
			'async _writeFile(config) {\n		if (this.type === "application/yaml" && this.content !== undefined && containsYamlInclude(this.content, entryListSchema)) throw new Error("Cannot overwrite YAML containing !include");',
		);
	const names =
		packageName === "dsh-config-editor"
			? "parseYamlWithIncludes, assertEditableIncludeRows"
			: "parseYamlWithIncludes, containsYamlInclude";
	return (
		MARKER +
		"\nimport { " +
		names +
		' } from "./dsh-yaml-include/native.js";\n' +
		content
	);
}

function atomic(path: string, data: string | Buffer) {
	mkdirSync(dirname(path), { recursive: true });
	const temp = path + ".include-" + process.pid + "-" + Date.now() + ".tmp";
	try {
		writeFileSync(temp, data, { flag: "wx" });
		renameSync(temp, path);
	} finally {
		if (existsSync(temp)) unlinkSync(temp);
	}
}

export function install({
	dshDir,
	uninstall = false,
	dryRun = false,
	sourceDir = helperDirectory,
	backupDir = join(homedir(), ".dsh-yaml-include", "native-backups"),
}: InstallOptions = {}): InstallResult {
	if (!dshDir) throw new Error("dshDir is required");
	const root = resolve(dshDir);
	const pkg: unknown = JSON.parse(
		readFileSync(join(root, "package.json"), "utf8"),
	);
	if (
		!isRecord(pkg) ||
		pkg.name !== "@deepseek-ai/dsh" ||
		pkg.version !== VERSION
	)
		throw new Error("Adapter requires @deepseek-ai/dsh@" + VERSION);
	const storage = join(resolve(backupDir), hash(root));
	const manifestPath = join(storage, "manifest.json");
	const manifestBytes = read(manifestPath);
	const previous = readManifest(manifestBytes);
	if (
		previous &&
		(previous.root !== root ||
			previous.version !== VERSION ||
			previous.format !== 1)
	)
		throw new Error("Invalid adapter backup manifest");
	const changes: Change[] = [];
	const expected: string[] = [];
	const packageByEntry = new Map<string, string>();
	const require = createRequire(join(root, "package.json"));
	for (const name of packages) {
		const entry = realpathSync(require.resolve("@deepseek-ai/" + name));
		const lib = dirname(entry);
		if (entry !== join(lib, "index.js"))
			throw new Error("Unexpected adapter module entry: " + entry);
		packageByEntry.set(entry, name);
		expected.push(
			entry,
			join(lib, "dsh-yaml-include", "native.js"),
			join(lib, "dsh-yaml-include", "reader.js"),
		);
	}
	if (
		previous &&
		(!Array.isArray(previous.files) ||
			previous.files.some(
				(file) =>
					!/^[a-f0-9]{64}$/.test(file.installedHash) ||
					(file.originalHash !== null &&
						!/^[a-f0-9]{64}$/.test(file.originalHash)),
			))
	)
		throw new Error("Invalid adapter backup hashes");
	if (
		previous &&
		(previous.files.length !== expected.length ||
			expected.some(
				(path) => !previous.files.some((file) => file.path === path),
			))
	)
		throw new Error("Invalid adapter backup targets");
	const helpers = uninstall
		? null
		: {
				"native.js": readFileSync(join(sourceDir, "native.js")),
				"reader.js": readFileSync(join(sourceDir, "reader.js")),
			};
	for (const path of expected) {
		const current = read(path);
		const saved = previous?.files.find((file) => file.path === path);
		let original = current;
		if (saved) {
			if (current === null || hash(current) !== saved.installedHash)
				throw new Error("Installed adapter drift: " + path);
			original =
				saved.originalHash === null
					? null
					: read(join(storage, saved.originalHash + ".bin"));
			if (
				saved.originalHash !== null &&
				(original === null || hash(original) !== saved.originalHash)
			)
				throw new Error("Original backup integrity failure: " + path);
		} else if (path.endsWith("index.js")) {
			if (current === null) throw new Error("Missing adapter target: " + path);
		} else if (current !== null)
			throw new Error("Unmanaged helper target: " + path);
		let next = original;
		if (!uninstall) {
			if (path.endsWith("index.js")) {
				const name = packageByEntry.get(path);
				if (original === null || name === undefined)
					throw new Error("Missing adapter target: " + path);
				next = Buffer.from(patchBundle(original.toString(), name));
			} else {
				if (!helpers) throw new Error("Missing adapter helpers");
				next = helpers[path.endsWith("native.js") ? "native.js" : "reader.js"];
			}
		}
		changes.push({ path, current, original, next });
	}
	if (uninstall && previous === null)
		return { status: "not-installed", changed: [] };
	const modified = changes.filter(
		(change) => !same(change.current, change.next),
	);
	const result: InstallResult = {
		status: dryRun
			? "dry-run"
			: uninstall
				? "uninstalled"
				: modified.length
					? "installed"
					: "unchanged",
		changed: modified.map((change) => change.path),
	};
	if (dryRun) return result;
	mkdirSync(storage, { recursive: true });
	const lock = join(storage, "operation.lock");
	writeFileSync(lock, String(process.pid), { flag: "wx" });
	try {
		const verify = () => {
			if (helpers)
				for (const [name, data] of Object.entries(helpers))
					if (!same(read(join(sourceDir, name)), data))
						throw new Error(
							"Helper source changed during installation: " + name,
						);
			if (!same(read(manifestPath), manifestBytes))
				throw new Error("Concurrent adapter manifest change");
			for (const change of changes)
				if (!same(read(change.path), change.current))
					throw new Error("Concurrent adapter target change: " + change.path);
		};
		verify();
		if (!uninstall)
			for (const change of changes)
				if (change.original !== null) {
					const blob = join(storage, hash(change.original) + ".bin");
					const existing = read(blob);
					if (existing !== null && !same(existing, change.original))
						throw new Error("Backup hash collision or corruption");
					if (existing === null) {
						mkdirSync(storage, { recursive: true });
						writeFileSync(blob, change.original, { flag: "wx" });
					}
				}
		verify();
		const completed: Change[] = [];
		try {
			for (const change of modified) {
				if (!same(read(change.path), change.current))
					throw new Error("Concurrent adapter target change: " + change.path);
				if (change.next === null) unlinkSync(change.path);
				else atomic(change.path, change.next);
				completed.push(change);
			}
			if (!same(read(manifestPath), manifestBytes))
				throw new Error("Concurrent adapter manifest change");
			if (helpers)
				for (const [name, data] of Object.entries(helpers))
					if (!same(read(join(sourceDir, name)), data))
						throw new Error(
							"Helper source changed during installation: " + name,
						);
			for (const change of changes)
				if (!same(read(change.path), change.next))
					throw new Error("Concurrent adapter target change: " + change.path);
			if (uninstall) unlinkSync(manifestPath);
			else
				atomic(
					manifestPath,
					JSON.stringify(
						{
							format: 1,
							root,
							version: VERSION,
							files: changes.map((change) => ({
								path: change.path,
								originalHash:
									change.original === null ? null : hash(change.original),
								installedHash: change.next === null ? null : hash(change.next),
							})),
						},
						null,
						2,
					) + "\n",
				);
		} catch (error) {
			for (const change of completed.reverse()) {
				if (!same(read(change.path), change.next)) continue;
				if (change.current === null) unlinkSync(change.path);
				else atomic(change.path, change.current);
			}
			throw error;
		}
		return result;
	} finally {
		for (const change of changes)
			if (
				!change.path.endsWith("index.js") &&
				!existsSync(change.path) &&
				existsSync(dirname(change.path)) &&
				readdirSync(dirname(change.path)).length === 0
			)
				rmdirSync(dirname(change.path));
		unlinkSync(lock);
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
	try {
		const args = process.argv.slice(2);
		const options: InstallOptions = {};
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--dsh-dir" && args[i + 1])
				options.dshDir = args[++i] ?? "";
			else if (args[i] === "--backup-dir" && args[i + 1])
				options.backupDir = args[++i] ?? "";
			else if (args[i] === "--uninstall") options.uninstall = true;
			else if (args[i] === "--dry-run") options.dryRun = true;
			else
				throw new Error(
					"Usage: node dist/src/install.js --dsh-dir <root> [--backup-dir <path>] [--uninstall] [--dry-run]",
				);
		}
		console.log(JSON.stringify(install(options), null, 2));
	} catch (error) {
		console.error(
			error instanceof Error ? error.message : "Installation failed",
		);
		process.exitCode = 1;
	}
}
