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
export const VERSION = "0.2.1-rc.2";

/**
 * Identifies adapter-owned bundles; a marker alone is not proof of a managed installation.
 */
export const MARKER = "// dsh-yaml-include adapter v1";

/**
 * Locates shipped helpers independently of the caller's working directory.
 */
const helperDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * Keeps destructive restore mode explicit and permits validation without writes.
 */
interface InstallOptions {
	/**
	 * Required at runtime; an omitted root must not guess which DSH installation to modify.
	 */
	dshDir?: string;

	/**
	 * Restores pre-adapter bytes rather than removing bundles; defaults to false.
	 */
	uninstall?: boolean;

	/**
	 * Validates and reports planned changes without acquiring a lock or writing files.
	 */
	dryRun?: boolean;

	/**
	 * Defaults to shipped helpers; alternate sources are checked again before commit.
	 */
	sourceDir?: string;

	/**
	 * Defaults to user-level storage outside DSH so package replacement need not erase backups.
	 */
	backupDir?: string;
}

/**
 * Pairs installed-byte ownership evidence with the recoverable pre-adapter state.
 */
interface BackupFile {
	/**
	 * Exact target path; manifests cannot nominate arbitrary restore destinations.
	 */
	path: string;

	/**
	 * Expected managed bytes, not original bytes; drift prevents overwriting external edits.
	 */
	installedHash: string;

	/**
	 * Original blob digest; null means the target did not exist before installation.
	 */
	originalHash: string | null;
}

/**
 * Binds restoration evidence to one installation and one supported backup format.
 */
interface BackupManifest {
	/**
	 * Resolved DSH root; backups from another root are not interchangeable.
	 */
	root: string;

	/**
	 * Supported DSH version; restoration must not silently accept a different release.
	 */
	version: string;

	/**
	 * Backup schema discriminator; only format 1 is accepted by installation planning.
	 */
	format: number;

	/**
	 * Complete expected target set, including helpers, to prevent partial ownership claims.
	 */
	files: BackupFile[];
}

/**
 * Separates rollback bytes from pre-adapter bytes so reinstallation remains reversible.
 */
interface Change {
	/**
	 * Validated bundle or helper destination, never an arbitrary manifest-provided path.
	 */
	path: string;

	/**
	 * Planning-time bytes used for concurrency checks and rollback; null means absent.
	 */
	current: Buffer | null;

	/**
	 * Pre-adapter bytes recovered from backup, not necessarily current bytes; null means originally absent.
	 */
	original: Buffer | null;

	/**
	 * Intended post-operation bytes; null requests removal rather than an empty file.
	 */
	next: Buffer | null;
}

/**
 * Reports byte changes separately from operation status, including validation-only runs.
 */
interface InstallResult {
	/**
	 * Distinguishes absent ownership, dry runs, and completed operations; unchanged means no target byte changes.
	 */
	status:
		| "not-installed"
		| "dry-run"
		| "uninstalled"
		| "installed"
		| "unchanged";

	/**
	 * Target paths whose bytes differ from the plan; dry-run entries are not completed writes.
	 */
	changed: string[];
}

/**
 * Allows object field inspection without treating null as a record; arrays also qualify.
 *
 * @param value - Untrusted parsed value.
 * @returns Whether the value is a non-null object, without validating its fields.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

/**
 * Checks manifest entry shape without claiming its paths or digests are trusted.
 *
 * @param value - Untrusted manifest entry.
 * @returns Whether required fields have their expected primitive types.
 */
function isBackupFile(value: unknown): value is BackupFile {
	return (
		isRecord(value) &&
		typeof value.path === "string" &&
		typeof value.installedHash === "string" &&
		(value.originalHash === null || typeof value.originalHash === "string")
	);
}

/**
 * Rejects malformed ownership evidence instead of treating it as an absent installation.
 *
 * @param content - Manifest bytes, or null when no manifest exists.
 * @returns A shape-checked manifest, or null only for absent input.
 * @throws If JSON parsing fails or required manifest fields have invalid types.
 */
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

/**
 * Limits patching to audited bundles rather than discovering speculative consumers.
 */
const packages = ["dsh-app-boot", "cordis-plugin-include", "dsh-config-editor"];

/**
 * Uses content-addressed identities so unchanged backups can be reused.
 *
 * @param value - Bytes or UTF-8 text whose identity is needed.
 * @returns Lowercase SHA-256 hexadecimal digest.
 */
const hash = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");

/**
 * Preserves absence as null instead of conflating it with an empty file.
 *
 * @param path - File to snapshot.
 * @returns File bytes, or null when the existence check reports absence.
 * @throws If reading an existing file fails, including a concurrent removal.
 */
const read = (path: string) => (existsSync(path) ? readFileSync(path) : null);

/**
 * Treats absence as a distinct state for rollback and concurrency checks.
 *
 * @param left - First snapshot; null denotes absence.
 * @param right - Second snapshot; null denotes absence.
 * @returns Whether both snapshots represent identical bytes or both are absent.
 */
const same = (left: Buffer | null, right: Buffer | null) =>
	left === null ? right === null : right !== null && left.equals(right);

/**
 * Refuses ambiguous sites rather than patching the wrong bundle revision.
 *
 * @param text - Bundle text to patch.
 * @param before - Exact audited site expected once.
 * @param after - Replacement text for that site.
 * @returns Text with the unique site replaced.
 * @throws If the expected site is missing or appears more than once.
 */
function replaceOnce(text: string, before: string, after: string) {
	if (text.split(before).length !== 2)
		throw new Error(`Expected exactly one adapter site: ${before}`);
	return text.replace(before, after);
}

/**
 * Keeps package-specific edits restricted to audited include-sensitive sites.
 *
 * @param packageName - Unscoped name of a supported DSH package.
 * @returns Original and replacement text pairs for the package.
 * @throws If the package has no audited patch sites.
 */
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

/**
 * Avoids exposing partially written bytes; this does not replace ownership checks.
 *
 * @param path - Destination whose parent may be created.
 * @param data - Complete replacement bytes or UTF-8 text.
 * @throws If directory creation, exclusive temporary writing, renaming, or cleanup fails.
 */
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

/**
 * Requires both runtime helpers so installation cannot silently ship an incomplete adapter.
 */
type Helpers = Record<"native.js" | "reader.js", Buffer>;

/**
 * Captures validated snapshots for later drift checks; it is not a filesystem lock.
 */
interface InstallPlan {
	/**
	 * Resolved installation root used to bind backups to the intended DSH instance.
	 */
	root: string;

	/**
	 * Root-specific backup and lock directory, separate from installed packages.
	 */
	storage: string;

	/**
	 * Ownership manifest destination; its bytes must remain stable until commit.
	 */
	manifestPath: string;

	/**
	 * Planning-time manifest bytes for concurrency checks; null means absent.
	 */
	manifestBytes: Buffer | null;

	/**
	 * Prior ownership evidence, or null for an unmanaged installation.
	 */
	previous: BackupManifest | null;

	/**
	 * Helper source location retained for checking that planned bytes remain current.
	 */
	sourceDir: string;

	/**
	 * Helper snapshots; null in uninstall mode because restoration does not need new helpers.
	 */
	helpers: Helpers | null;

	/**
	 * All validated targets, including unchanged ones that still need drift checks.
	 */
	changes: Change[];

	/**
	 * Only byte-changing targets, avoiding unnecessary writes and rollback entries.
	 */
	modified: Change[];

	/**
	 * Selects restoration of originals instead of producing new adapter bytes.
	 */
	uninstall: boolean;
}

/**
 * Rejects untested DSH releases rather than relying only on matching patch text.
 *
 * @param root - DSH installation root containing package metadata.
 * @throws If metadata cannot be read or parsed, or its package name or version is unsupported.
 */
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

/**
 * Uses resolved module entries so backups follow actual package destinations.
 *
 * @param root - Validated DSH root used for module resolution.
 * @returns Expected bundle/helper paths and each bundle's package name.
 * @throws If module resolution or realpath fails, or an entry is not index.js.
 */
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

/**
 * Prevents reusing ownership evidence from another root, release, or schema.
 *
 * @param previous - Existing manifest, or null when absent.
 * @param root - Resolved root that must match existing ownership evidence.
 * @throws If an existing manifest identifies another root, version, or format.
 */
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

/**
 * Rejects incomplete target sets and unusable hashes before any restore writes.
 *
 * @param previous - Shape-checked manifest, or null when absent.
 * @param expected - Complete target set resolved from installed packages.
 * @throws If an existing manifest has invalid hashes or does not match the expected target set.
 */
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

/**
 * Recovers pre-adapter bytes only when managed targets and backups still match their hashes.
 *
 * @param path - Expected target destination.
 * @param current - Planning-time target bytes, or null when absent.
 * @param saved - Prior manifest entry, or undefined for a first installation.
 * @param storage - Directory containing original content-addressed blobs.
 * @returns Pre-adapter bytes, or null for an originally absent helper.
 * @throws If ownership drift, backup corruption, a missing bundle, an unmanaged helper, or a read failure is detected.
 */
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

/**
 * Uses originals rather than current patched bundles to avoid stacking adapter edits.
 *
 * @param path - Expected bundle or helper destination.
 * @param original - Pre-adapter bytes; null denotes original absence.
 * @param uninstall - Whether to restore originals instead of installing.
 * @param packageByEntry - Audited package names indexed by bundle destination.
 * @param helpers - Helper snapshots; null is permitted only when not needed.
 * @returns Desired target bytes, or null when restoration removes a previously absent target.
 * @throws If a required target or helper is missing, or bundle patch validation fails.
 */
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

/**
 * Validates the full operation before writes; snapshots still require rechecking under the lock.
 *
 * @param root - Resolved DSH installation root.
 * @param backupDir - Base directory for root-specific ownership evidence.
 * @param sourceDir - Directory containing both runtime helpers.
 * @param uninstall - Whether the plan restores pre-adapter targets.
 * @returns Validated ownership, source, and target snapshots with the byte-changing subset.
 * @throws If package, manifest, target, backup, helper, or patch validation fails, or filesystem access fails.
 */
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

/**
 * Prevents mixing helper revisions after a plan has captured source bytes.
 *
 * @param plan - Plan whose helper snapshots must remain stable; null helpers require no check.
 * @throws If helper bytes differ from the plan or reading them fails.
 */
function verifyHelpers(plan: InstallPlan) {
	if (!plan.helpers) return;
	for (const [name, data] of Object.entries(plan.helpers))
		if (!same(read(join(plan.sourceDir, name)), data))
			throw new Error(`Helper source changed during installation: ${name}`);
}

/**
 * Refuses to replace ownership evidence changed since planning.
 *
 * @param plan - Plan containing the original manifest snapshot, including absence.
 * @throws If manifest bytes or existence changed, or reading fails.
 */
function verifyManifest(plan: InstallPlan) {
	if (!same(read(plan.manifestPath), plan.manifestBytes))
		throw new Error("Concurrent adapter manifest change");
}

/**
 * Checks even unchanged targets so external edits cannot be claimed as adapter-owned.
 *
 * @param changes - Target snapshots to verify.
 * @param state - Current for pre-write checks; next for post-write checks.
 * @throws If any target differs from the requested snapshot or reading fails.
 */
function verifyTargets(changes: Change[], state: "current" | "next") {
	for (const change of changes)
		if (!same(read(change.path), change[state]))
			throw new Error(`Concurrent adapter target change: ${change.path}`);
}

/**
 * Requires source and ownership stability in addition to destination stability.
 *
 * @param plan - Planned snapshots to compare with disk.
 * @throws If any source, manifest, or target has drifted, or reading fails.
 */
function verifyPlan(plan: InstallPlan) {
	verifyHelpers(plan);
	verifyManifest(plan);
	verifyTargets(plan.changes, "current");
}

/**
 * Preserves pre-adapter bytes without replacing existing content-addressed blobs.
 *
 * @param plan - Validated plan; uninstall mode does not create backups.
 * @throws If an existing blob differs, or reading, directory creation, or exclusive writing fails.
 */
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

/**
 * Distinguishes removal from an empty replacement; callers must validate ownership first.
 *
 * @param path - Destination authorized by the plan.
 * @param content - Replacement bytes, or null to remove the target.
 * @throws If removal or atomic replacement fails, including temporary-file cleanup.
 */
function writeContent(path: string, content: Buffer | null) {
	if (content === null) unlinkSync(path);
	else atomic(path, content);
}

/**
 * Publishes ownership only after target verification; uninstall removes evidence, not backup blobs.
 *
 * @param plan - Committed target plan whose ownership evidence is to be published.
 * @throws If manifest removal or atomic writing fails.
 */
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

/**
 * Leaves external edits intact instead of forcing restoration after a failed commit.
 *
 * @param completed - Written changes, reversed in place; rollback uses current rather than original bytes.
 * @throws If reading or restoring an eligible target fails; rollback may then be incomplete.
 */
function rollback(completed: Change[]) {
	for (const change of completed.reverse()) {
		if (!same(read(change.path), change.next)) continue;
		writeContent(change.path, change.current);
	}
}

/**
 * Rechecks ownership before publication and attempts rollback only for its own completed writes.
 *
 * @param plan - Locked and validated plan to commit.
 * @throws If drift checks or writes fail; rollback failures may replace the initiating error.
 */
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

/**
 * Retains nonempty helper directories because they may contain files owned by others.
 *
 * @param changes - Expected helper and bundle destinations after the operation.
 * @throws If directory inspection or removal fails, including concurrent directory changes.
 */
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

/**
 * Serializes adapter operations while still checking for writers that ignore the lock.
 *
 * @param plan - Validated plan to execute; callers must skip this for dry runs.
 * @throws If the exclusive lock cannot be acquired, validation or commit fails, or cleanup fails.
 */
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

/**
 * Reports validation-only mode ahead of write outcomes; absent ownership is handled by the caller.
 *
 * @param dryRun - Whether no writes will be attempted.
 * @param uninstall - Whether originals are being restored.
 * @param modified - Targets whose planned bytes differ from their current snapshots.
 * @returns Dry-run, uninstalled, installed, or unchanged status in that precedence.
 */
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
