import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run with npm run smoke");
const temp = mkdtempSync(join(tmpdir(), "dsh-yaml-package-"));
const hash = (file: string) =>
	createHash("sha256").update(readFileSync(file)).digest("hex");

function run(
	args: string[],
	cwd = project,
	env: NodeJS.ProcessEnv = process.env,
) {
	const child = spawnSync(process.execPath, args, {
		cwd,
		env,
		stdio: "inherit",
	});
	if (child.error) throw child.error;
	if (child.status !== 0)
		throw new Error("Command failed (" + child.status + "): " + args.join(" "));
}

const npm = (
	args: string[],
	cwd = project,
	env: NodeJS.ProcessEnv = process.env,
) => run([npmCli, ...args], cwd, env);
try {
	writeFileSync(join(temp, "package.json"), '{"private":true,"type":"module"}');
	npm(["pack", "--pack-destination", temp]);
	const metadata: unknown = JSON.parse(
		readFileSync(join(project, "package.json"), "utf8"),
	);
	assert.ok(
		typeof metadata === "object" && metadata !== null && "version" in metadata,
	);
	const version = metadata.version;
	assert.equal(typeof version, "string");
	npm(
		[
			"install",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"@deepseek-ai/dsh@0.2.0-rc.2",
			join(temp, "dsh-yaml-include-" + version + ".tgz"),
		],
		temp,
	);
	const dsh = join(temp, "node_modules/@deepseek-ai/dsh");
	const require = createRequire(join(dsh, "package.json"));
	const targets = [
		"dsh-app-boot",
		"cordis-plugin-include",
		"dsh-config-editor",
	].map((name) => require.resolve("@deepseek-ai/" + name));
	const originals = targets.map(hash);
	const args = [
		"exec",
		"--no",
		"--",
		"dsh-yaml-include",
		"--dsh-dir",
		dsh,
		"--backup-dir",
		join(temp, "backups"),
	];
	npm([...args, "--dry-run"], temp);
	assert.deepEqual(targets.map(hash), originals);
	npm(args, temp);
	const installed = targets.map(hash);
	assert.ok(installed.every((value, index) => value !== originals[index]));
	npm(args, temp);
	assert.deepEqual(targets.map(hash), installed);
	run(["--test", "dist/tests/*.test.js"], project, {
		...process.env,
		DSH_TEST_HOST_ENTRY: join(dsh, "package.json"),
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
			JSON.stringify(join(dsh, "package.json")) +
			'); const app=await import(pathToFileURL(req.resolve("@deepseek-ai/dsh-app-boot")).href); assert.deepEqual(app.loadOverlayPatches("test",' +
			JSON.stringify(join(fixture, "models.patch.yml")) +
			'),[{id:"llm",config:{providers:{example:{models:[{id:"example"}]}}}}]); console.log("PACKED_NATIVE_PARSE_OK")',
	);
	run([probe], temp);
	npm([...args, "--uninstall"], temp);
	assert.deepEqual(targets.map(hash), originals);
	console.log(
		"PACKAGE_SMOKE_OK: clean official DSH, packed CLI, native parse, editor tests, idempotence and byte-exact restoration",
	);
} finally {
	assert.equal(dirname(temp), resolve(tmpdir()));
	rmSync(temp, { recursive: true, force: true });
}
