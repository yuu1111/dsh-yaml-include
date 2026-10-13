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

/**
 * The sole supported DSH version; other versions are refused rather than patched speculatively.
 */
export const VERSION = "0.2.0-rc.2";

/**
 * Identifies adapter-owned bundles; a marker alone is not proof of a managed installation.
 */
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
		throw new Error(`Expected exactly one adapter site: ${before}`);
	return text.replace(before, after);
}

function patchSites(packageName: string): [string, string][] {
	switch (packageName) {
		case "dsh-app-boot":
			return [
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
			];
		case "cordis-plugin-include":
			return [
				[
					"yaml.load(content, { schema: entryListSchema })",
					"parseYamlWithIncludes(content, this.filename, entryListSchema)",
				],
			];
		case "dsh-config-editor":
			return [
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
			];
		default:
			throw new Error("Unknown adapter package");
	}
}

/**
 * Patches an unmarked supported bundle; unknown or ambiguous patch sites are refused.
 *
 * @param content - Original UTF-8 bundle text.
 * @param packageName - Supported DSH package name without its scope.
 * @returns Bundle text with the adapter import and include-safe YAML entry points.
 * @throws If the package is unsupported, a marker already exists, or a patch site is missing or duplicated.
 */
export function patchBundle(content: string, packageName: string) {
	if (content.includes(MARKER)) throw new Error("Unmanaged adapter marker");
	const sites = patchSites(packageName);
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
	const temp = `${path}.include-${process.pid}-${Date.now()}.tmp`;
	try {
		writeFileSync(temp, data, { flag: "wx" });
		renameSync(temp, path);
	} finally {
		if (existsSync(temp)) unlinkSync(temp);
	}
}

type Helpers = Record<"native.js" | "reader.js", Buffer>;

interface InstallPlan {
	root: string;
	storage: string;
	manifestPath: string;
	manifestBytes: Buffer | null;
	previous: BackupManifest | null;
	sourceDir: string;
	helpers: Helpers | null;
	changes: Change[];
	modified: Change[];
	uninstall: boolean;
}

function validateRoot(root: string) {
	const pkg: unknown = JSON.parse(
		readFileSync(join(root, "package.json"), "utf8"),
	);
	if (
		!isRecord(pkg) ||
		pkg.name !== "@deepseek-ai/dsh" ||
		pkg.version !== VERSION
	)
		throw new Error(`Adapter requires @deepseek-ai/dsh@${VERSION}`);
}

function resolveTargets(root: string) {
	const expected: string[] = [];
	const packageByEntry = new Map<string, string>();
	const require = createRequire(join(root, "package.json"));
	for (const name of packages) {
		const entry = realpathSync(require.resolve(`@deepseek-ai/${name}`));
		const lib = dirname(entry);
		if (entry !== join(lib, "index.js"))
			throw new Error(`Unexpected adapter module entry: ${entry}`);
		packageByEntry.set(entry, name);
		expected.push(
			entry,
			join(lib, "dsh-yaml-include", "native.js"),
			join(lib, "dsh-yaml-include", "reader.js"),
		);
	}
	return { expected, packageByEntry };
}

function validateManifestIdentity(
	previous: BackupManifest | null,
	root: string,
) {
	if (
		previous &&
		(previous.root !== root ||
			previous.version !== VERSION ||
			previous.format !== 1)
	)
		throw new Error("Invalid adapter backup manifest");
}

function validateManifestTargets(
	previous: BackupManifest | null,
	expected: string[],
) {
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
}

function restoreOriginal(
	path: string,
	current: Buffer | null,
	saved: BackupFile | undefined,
	storage: string,
) {
	let original = current;
	if (saved) {
		if (current === null || hash(current) !== saved.installedHash)
			throw new Error(`Installed adapter drift: ${path}`);
		original =
			saved.originalHash === null
				? null
				: read(join(storage, `${saved.originalHash}.bin`));
		if (
			saved.originalHash !== null &&
			(original === null || hash(original) !== saved.originalHash)
		)
			throw new Error(`Original backup integrity failure: ${path}`);
	} else if (path.endsWith("index.js")) {
		if (current === null) throw new Error(`Missing adapter target: ${path}`);
	} else if (current !== null)
		throw new Error(`Unmanaged helper target: ${path}`);
	return original;
}

function nextContent(
	path: string,
	original: Buffer | null,
	uninstall: boolean,
	packageByEntry: Map<string, string>,
	helpers: Helpers | null,
) {
	let next = original;
	if (!uninstall) {
		if (path.endsWith("index.js")) {
			const name = packageByEntry.get(path);
			if (original === null || name === undefined)
				throw new Error(`Missing adapter target: ${path}`);
			next = Buffer.from(patchBundle(original.toString(), name));
		} else {
			if (!helpers) throw new Error("Missing adapter helpers");
			next = helpers[path.endsWith("native.js") ? "native.js" : "reader.js"];
		}
	}
	return next;
}

function planInstallation(
	root: string,
	backupDir: string,
	sourceDir: string,
	uninstall: boolean,
): InstallPlan {
	validateRoot(root);
	const storage = join(resolve(backupDir), hash(root));
	const manifestPath = join(storage, "manifest.json");
	const manifestBytes = read(manifestPath);
	const previous = readManifest(manifestBytes);
	validateManifestIdentity(previous, root);
	const { expected, packageByEntry } = resolveTargets(root);
	validateManifestTargets(previous, expected);
	const helpers = uninstall
		? null
		: {
				"native.js": readFileSync(join(sourceDir, "native.js")),
				"reader.js": readFileSync(join(sourceDir, "reader.js")),
			};
	const changes = expected.map((path): Change => {
		const current = read(path);
		const saved = previous?.files.find((file) => file.path === path);
		const original = restoreOriginal(path, current, saved, storage);
		const next = nextContent(
			path,
			original,
			uninstall,
			packageByEntry,
			helpers,
		);
		return { path, current, original, next };
	});
	const modified = changes.filter(
		(change) => !same(change.current, change.next),
	);
	return {
		root,
		storage,
		manifestPath,
		manifestBytes,
		previous,
		sourceDir,
		helpers,
		changes,
		modified,
		uninstall,
	};
}

function verifyHelpers(plan: InstallPlan) {
	if (!plan.helpers) return;
	for (const [name, data] of Object.entries(plan.helpers))
		if (!same(read(join(plan.sourceDir, name)), data))
			throw new Error(`Helper source changed during installation: ${name}`);
}

function verifyManifest(plan: InstallPlan) {
	if (!same(read(plan.manifestPath), plan.manifestBytes))
		throw new Error("Concurrent adapter manifest change");
}

function verifyTargets(changes: Change[], state: "current" | "next") {
	for (const change of changes)
		if (!same(read(change.path), change[state]))
			throw new Error(`Concurrent adapter target change: ${change.path}`);
}

function verifyPlan(plan: InstallPlan) {
	verifyHelpers(plan);
	verifyManifest(plan);
	verifyTargets(plan.changes, "current");
}

function saveBackups(plan: InstallPlan) {
	if (plan.uninstall) return;
	for (const change of plan.changes) {
		if (change.original === null) continue;
		const blob = join(plan.storage, `${hash(change.original)}.bin`);
		const existing = read(blob);
		if (existing !== null && !same(existing, change.original))
			throw new Error("Backup hash collision or corruption");
		if (existing === null) {
			mkdirSync(plan.storage, { recursive: true });
			writeFileSync(blob, change.original, { flag: "wx" });
		}
	}
}

function writeContent(path: string, content: Buffer | null) {
	if (content === null) unlinkSync(path);
	else atomic(path, content);
}

function writeManifest(plan: InstallPlan) {
	const { uninstall, manifestPath, root, changes } = plan;
	if (uninstall) unlinkSync(manifestPath);
	else
		atomic(
			manifestPath,
			`${JSON.stringify(
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
			)}\n`,
		);
}

function rollback(completed: Change[]) {
	for (const change of completed.reverse()) {
		if (!same(read(change.path), change.next)) continue;
		writeContent(change.path, change.current);
	}
}

function commitPlan(plan: InstallPlan) {
	const completed: Change[] = [];
	try {
		for (const change of plan.modified) {
			verifyTargets([change], "current");
			writeContent(change.path, change.next);
			completed.push(change);
		}
		verifyManifest(plan);
		verifyHelpers(plan);
		verifyTargets(plan.changes, "next");
		writeManifest(plan);
	} catch (error) {
		rollback(completed);
		throw error;
	}
}

function cleanHelperDirectories(changes: Change[]) {
	for (const change of changes)
		if (
			!change.path.endsWith("index.js") &&
			!existsSync(change.path) &&
			existsSync(dirname(change.path)) &&
			readdirSync(dirname(change.path)).length === 0
		)
			rmdirSync(dirname(change.path));
}

function executePlan(plan: InstallPlan) {
	mkdirSync(plan.storage, { recursive: true });
	const lock = join(plan.storage, "operation.lock");
	writeFileSync(lock, String(process.pid), { flag: "wx" });
	try {
		verifyPlan(plan);
		saveBackups(plan);
		verifyPlan(plan);
		commitPlan(plan);
	} finally {
		try {
			cleanHelperDirectories(plan.changes);
		} finally {
			unlinkSync(lock);
		}
	}
}

function resultStatus(
	dryRun: boolean,
	uninstall: boolean,
	modified: Change[],
): InstallResult["status"] {
	if (dryRun) return "dry-run";
	if (uninstall) return "uninstalled";
	return modified.length ? "installed" : "unchanged";
}

/**
 * Installs or restores the adapter only on the supported DSH version; unmanaged or changed targets are refused.
 *
 * @param options - DSH location, helper and backup locations, and uninstall or dry-run mode.
 * @returns The operation status and paths whose bytes would change; dry runs do not write files.
 * @throws If targets, backups, or sources fail validation, another operation holds the lock, or filesystem access fails.
 */
export function install(options: InstallOptions = {}): InstallResult {
	const {
		dshDir,
		uninstall = false,
		dryRun = false,
		sourceDir = helperDirectory,
		backupDir = join(homedir(), ".dsh-yaml-include", "native-backups"),
	} = options;
	if (!dshDir) throw new Error("dshDir is required");
	const plan = planInstallation(
		resolve(dshDir),
		backupDir,
		sourceDir,
		uninstall,
	);
	if (uninstall && plan.previous === null)
		return { status: "not-installed", changed: [] };
	const result: InstallResult = {
		status: resultStatus(dryRun, uninstall, plan.modified),
		changed: plan.modified.map((change) => change.path),
	};
	if (!dryRun) executePlan(plan);
	return result;
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
