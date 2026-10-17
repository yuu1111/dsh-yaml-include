import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/install.js";

/**
 * Anchors packing to the repository rather than the disposable consumer project.
 */
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Retains the package manager entry selected by pnpm run instead of invoking a shell wrapper.
 */
const pnpmCli = process.env.npm_execpath;
if (
	!pnpmCli ||
	!/^pnpm\/12\.3\.4(?:\s|$)/.test(process.env.npm_config_user_agent ?? "")
)
	throw new Error("Run with pnpm@12.3.4 run smoke");

/**
 * Confines package installation, store hardlinks, and backups to a disposable directory.
 */
const temp = mkdtempSync(join(tmpdir(), "dsh-yaml-package-"));

/**
 * Compares original bytes rather than trusting installation status messages.
 *
 * @param file - Installed runtime file whose original or restored bytes are checked.
 * @returns A SHA-256 digest used to detect byte-level changes.
 * @throws A filesystem error if the verification target cannot be read.
 */
const hash = (file: string) =>
	createHash("sha256").update(readFileSync(file)).digest("hex");

/**
 * Rejects subprocess failures instead of allowing later assertions to hide an incomplete command.
 *
 * @param args - Argument vector passed without shell interpretation.
 * @param cwd - Repository or disposable project that owns the command.
 * @param env - Child environment, optionally selecting an isolated DSH host.
 * @param executable - Native CLI or Node executable, avoiding Windows command wrappers.
 * @throws A spawn error or failed-exit report if the command does not complete successfully.
 */
function run(
	args: string[],
	cwd = project,
	env: NodeJS.ProcessEnv = process.env,
	executable = process.execPath,
) {
	const child = spawnSync(executable, args, {
		cwd,
		env,
		stdio: "inherit",
	});
	if (child.error) throw child.error;
	if (child.status !== 0)
		throw new Error(`Command failed (${child.status}): ${args.join(" ")}`);
}

/**
 * Supports native and JavaScript pnpm entries without enabling shell interpretation.
 *
 * @param args - pnpm command arguments, including disposable store selection when needed.
 * @param cwd - Project directory used for packing or isolated installation.
 * @param env - Child environment inherited from the verified pnpm invocation.
 * @throws A spawn error or failed-exit report when pnpm does not succeed.
 */
const pnpm = (
	args: string[],
	cwd = project,
	env: NodeJS.ProcessEnv = process.env,
) =>
	/\.(?:cjs|mjs|js)$/i.test(pnpmCli)
		? run([pnpmCli, ...args], cwd, env)
		: run(args, cwd, env, pnpmCli);
try {
	writeFileSync(
		join(temp, "package.json"),
		JSON.stringify({
			private: true,
			type: "module",
			packageManager: "pnpm@12.3.4",
		}),
	);
	pnpm(["pack", "--pack-destination", temp]);
	const metadata: unknown = JSON.parse(
		readFileSync(join(project, "package.json"), "utf8"),
	);
	assert.ok(
		typeof metadata === "object" && metadata !== null && "version" in metadata,
	);
	const version = metadata.version;
	assert.equal(typeof version, "string");
	pnpm(
		[
			"add",
			"--ignore-scripts",
			"--ignore-workspace",
			"--store-dir",
			join(temp, "store"),
			`@deepseek-ai/dsh@${VERSION}`,
			join(temp, `dsh-yaml-include-${version}.tgz`),
		],
		temp,
	);
	const dsh = realpathSync(join(temp, "node_modules/@deepseek-ai/dsh"));
	const hostEntry = join(dsh, "package.json");
	const require = createRequire(hostEntry);
	const targets = [
		"dsh-app-boot",
		"cordis-plugin-include",
		"dsh-config-editor",
	].map((name) => realpathSync(require.resolve(`@deepseek-ai/${name}`)));
	const originals = targets.map(hash);
	const args = [
		"exec",
		"--ignore-workspace",
		"--store-dir",
		join(temp, "store"),
		"dsh-yaml-include",
		"--dsh-dir",
		dsh,
		"--backup-dir",
		join(temp, "backups"),
	];
	pnpm([...args, "--dry-run"], temp);
	assert.deepEqual(targets.map(hash), originals);
	pnpm(args, temp);
	const installed = targets.map(hash);
	assert.ok(installed.every((value, index) => value !== originals[index]));
	pnpm(args, temp);
	assert.deepEqual(targets.map(hash), installed);
	run(["--test", "dist/tests/*.test.js"], project, {
		...process.env,
		DSH_TEST_HOST_ENTRY: hostEntry,
	});
	const fixture = join(temp, "fixture");
	mkdirSync(fixture);
	writeFileSync(join(fixture, "package.json"), "{}");
	writeFileSync(
		join(fixture, "providers.yml"),
		"example: {models: [{id: example}]}",
	);
	writeFileSync(
		join(fixture, "models.patch.yml"),
		"- id: llm\n  config:\n    providers: !include providers.yml\n",
	);
	const probe = join(temp, "probe.mjs");
	writeFileSync(
		probe,
		'import assert from "node:assert/strict"; import {createRequire} from "node:module"; import {pathToFileURL} from "node:url"; const req=createRequire(' +
			JSON.stringify(hostEntry) +
			'); const app=await import(pathToFileURL(req.resolve("@deepseek-ai/dsh-app-boot")).href); assert.deepEqual(app.loadOverlayPatches("test",' +
			JSON.stringify(join(fixture, "models.patch.yml")) +
			'),[{id:"llm",config:{providers:{example:{models:[{id:"example"}]}}}}]); console.log("PACKED_NATIVE_PARSE_OK")',
	);
	run([probe], temp);
	pnpm([...args, "--uninstall"], temp);
	assert.deepEqual(targets.map(hash), originals);
	console.log(
		"PACKAGE_SMOKE_OK: clean official DSH, packed CLI, native parse, editor tests, idempotence and byte-exact restoration",
	);
} finally {
	assert.equal(dirname(temp), resolve(tmpdir()));
	rmSync(temp, { recursive: true, force: true });
}
