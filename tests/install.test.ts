import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { install, MARKER, patchBundle, VERSION } from "../src/install.js";
import { array, record } from "./assertions.js";

const include =
	"data = yaml.load(content, { schema: entryListSchema });\nasync _writeFile(config) {}";
const boot =
	include +
	"\n" +
	[
		'data = load(readFileSync(filename, "utf8"), { schema: entryListSchema });',
		'source = extension === ".json" ? JSON.parse(content) : yaml.load(content, { schema: entryListSchema });',
		"parsed = yaml.load(content, { schema: userPatchesSchema });",
		"parsed = yaml.load(content, { schema: entryListSchema });",
	].join("\n");
const editor =
	'tag: "tag:yaml.org,2002:js",\n					resolve: (value) => value\n				}]\n' +
	'if (!isSeq(document.contents)) throw new Error("Profile patch must be a YAML sequence");\n' +
	"yaml.load(String(document), { schema: entryListSchema })";

function fixture(
	t: TestContext,
	{ hoisted = false }: { hoisted?: boolean } = {},
) {
	const temp = resolve(mkdtempSync(join(tmpdir(), "dsh-include-install-")));
	assert.ok(temp.startsWith(resolve(tmpdir())));
	t.after(() => {
		assert.ok(temp.startsWith(resolve(tmpdir())));
		rmSync(temp, { recursive: true, force: true });
		assert.equal(existsSync(temp), false);
	});
	const dshDir = hoisted
		? join(temp, "node_modules", "@deepseek-ai", "dsh")
		: join(temp, "dsh");
	const moduleRoot = hoisted ? temp : dshDir;
	const sourceDir = join(temp, "src");
	const backupDir = join(temp, "backups");
	const originals = new Map<string, string>();
	const put = (path: string, text: string) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
	};
	put(
		join(dshDir, "package.json"),
		JSON.stringify({ name: "@deepseek-ai/dsh", version: VERSION }),
	);
	for (const [name, text] of [
		["dsh-app-boot", boot],
		["cordis-plugin-include", include],
		["dsh-config-editor", editor],
	] as const) {
		const packageDir = join(moduleRoot, "node_modules", "@deepseek-ai", name);
		const path = join(packageDir, "lib", "index.js");
		put(
			join(packageDir, "package.json"),
			JSON.stringify({ name: "@deepseek-ai/" + name, main: "lib/index.js" }),
		);
		put(path, text);
		originals.set(path, text);
	}
	put(join(sourceDir, "native.js"), "export const value = 1\n");
	put(join(sourceDir, "reader.js"), "export const reader = 1\n");
	const options = { dshDir, sourceDir, backupDir };
	const storage = join(
		backupDir,
		createHash("sha256").update(dshDir).digest("hex"),
	);
	return { ...options, options, originals, storage, put };
}

test("all parser sites retain their filename and schema context", () => {
	const result = patchBundle(boot, "dsh-app-boot");
	assert.equal(result.split("parseYamlWithIncludes(").length - 1, 5);
	for (const expected of [
		"content, this.filename, entryListSchema",
		'readFileSync(filename, "utf8"), filename, entryListSchema',
		"content, filename, entryListSchema",
		"content, file, userPatchesSchema",
		"content, absoluteConfigPath, entryListSchema",
	])
		assert.ok(result.includes(expected));
	assert.ok(
		result.includes("containsYamlInclude(this.content, entryListSchema)"),
	);
	const gui = patchBundle(editor, "dsh-config-editor");
	assert.ok(
		gui.includes("assertEditableIncludeRows(document, entry.options.id)"),
	);
	assert.ok(gui.includes('tag: "!include", resolve: (value) => value'));
	assert.ok(
		gui.includes(
			"parseYamlWithIncludes(String(document), path, entryListSchema)",
		),
	);
});

test("dry run makes no target or backup changes", (t) => {
	const f = fixture(t);
	assert.equal(install({ ...f.options, dryRun: true }).changed.length, 9);
	for (const [path, text] of f.originals)
		assert.equal(readFileSync(path, "utf8"), text);
	assert.equal(existsSync(f.backupDir), false);
});

test("install is repeatable and uninstall restores exact originals and removes helpers", (t) => {
	const f = fixture(t);
	assert.equal(install(f.options).status, "installed");
	assert.equal(install(f.options).status, "unchanged");
	for (const path of f.originals.keys())
		assert.ok(readFileSync(path, "utf8").startsWith(MARKER));
	assert.equal(
		install({ ...f.options, uninstall: true }).status,
		"uninstalled",
	);
	for (const [path, text] of f.originals) {
		assert.equal(readFileSync(path, "utf8"), text);
		assert.equal(existsSync(join(dirname(path), "dsh-yaml-include")), false);
	}
	assert.equal(
		install({ ...f.options, uninstall: true }).status,
		"not-installed",
	);
});

test("helper updates preserve original backups and are reversible", (t) => {
	const f = fixture(t);
	install(f.options);
	const before: unknown = JSON.parse(
		readFileSync(join(f.storage, "manifest.json"), "utf8"),
	);
	f.put(join(f.sourceDir, "native.js"), "export const value = 2\n");
	const result = install(f.options);
	assert.equal(result.changed.length, 3);
	const after: unknown = JSON.parse(
		readFileSync(join(f.storage, "manifest.json"), "utf8"),
	);
	assert.deepEqual(
		array(record(after).files).map((file) => record(file).originalHash),
		array(record(before).files).map((file) => record(file).originalHash),
	);
	install({ ...f.options, uninstall: true });
	for (const [path, text] of f.originals)
		assert.equal(readFileSync(path, "utf8"), text);
});

test("unexpected late parser site rejects the complete plan without partial writes", (t) => {
	const f = fixture(t);
	const path = [...f.originals.keys()].at(-1);
	assert.ok(path);
	f.put(
		path,
		editor.replace(
			"yaml.load(String(document)",
			"yaml.changed(String(document)",
		),
	);
	assert.throws(() => install(f.options), /exactly one/);
	assert.equal(existsSync(f.backupDir), false);
	for (const [target, text] of f.originals)
		if (target !== path) assert.equal(readFileSync(target, "utf8"), text);
});

test("duplicate sites and unmanaged markers are never patched", () => {
	assert.throws(
		() => patchBundle(include + include, "cordis-plugin-include"),
		/exactly one/,
	);
	assert.throws(
		() => patchBundle(MARKER + include, "cordis-plugin-include"),
		/Unmanaged/,
	);
});

test("wrong runtime version is refused before backup creation", (t) => {
	const f = fixture(t);
	f.put(
		join(f.dshDir, "package.json"),
		JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.0" }),
	);
	assert.throws(() => install(f.options), /requires/);
	assert.equal(existsSync(f.backupDir), false);
});

test("installed drift rejects updates and uninstall without overwriting user changes", (t) => {
	const f = fixture(t);
	install(f.options);
	const path = [...f.originals.keys()][1];
	assert.ok(path);
	const changed = readFileSync(path, "utf8") + "\n// local change";
	f.put(path, changed);
	assert.throws(() => install(f.options), /drift/);
	assert.throws(() => install({ ...f.options, uninstall: true }), /drift/);
	assert.equal(readFileSync(path, "utf8"), changed);
});

test("tampered originals prevent restoration", (t) => {
	const f = fixture(t);
	install(f.options);
	const blob = readdirSync(f.storage).find((name) => name.endsWith(".bin"));
	assert.ok(blob);
	f.put(join(f.storage, blob), "corrupt");
	assert.throws(() => install({ ...f.options, uninstall: true }), /integrity/);
	for (const path of f.originals.keys())
		assert.ok(readFileSync(path, "utf8").startsWith(MARKER));
});

test("active operation lock refuses another installer", (t) => {
	const f = fixture(t);
	f.put(join(f.storage, "operation.lock"), "other-process");
	assert.throws(() => install(f.options), /EEXIST/);
	for (const [path, text] of f.originals)
		assert.equal(readFileSync(path, "utf8"), text);
});

test("relocated installations use only relative helper imports", (t) => {
	const f = fixture(t);
	install(f.options);
	for (const path of f.originals.keys()) {
		const text = readFileSync(path, "utf8");
		assert.ok(text.includes('from "./dsh-yaml-include/native.js"'));
		assert.equal(text.includes(f.dshDir), false);
		assert.equal(text.includes(f.sourceDir), false);
		assert.equal(text.includes(f.backupDir), false);
	}
});

for (const hoisted of [false, true])
	test(
		"Node resolution supports " +
			(hoisted ? "hoisted sibling" : "nested") +
			" DSH dependencies",
		(t) => {
			const f = fixture(t, { hoisted });
			assert.equal(install({ ...f.options, dryRun: true }).changed.length, 9);
			assert.equal(install(f.options).status, "installed");
			assert.equal(install(f.options).status, "unchanged");
			const manifest: unknown = JSON.parse(
				readFileSync(join(f.storage, "manifest.json"), "utf8"),
			);
			for (const path of f.originals.keys())
				assert.ok(
					array(record(manifest).files).some(
						(file) => record(file).path === path,
					),
				);
			f.put(join(f.sourceDir, "native.js"), "export const value = 3\n");
			assert.equal(install(f.options).changed.length, 3);
			assert.equal(
				install({ ...f.options, uninstall: true }).status,
				"uninstalled",
			);
			for (const [path, text] of f.originals) {
				assert.equal(readFileSync(path, "utf8"), text);
				assert.equal(
					existsSync(join(dirname(path), "dsh-yaml-include")),
					false,
				);
			}
		},
	);
