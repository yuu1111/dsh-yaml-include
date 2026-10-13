import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { YamlIncludeReader } from "../src/reader.js";
import { errorCode, record } from "./assertions.js";

function fixture(
	t: TestContext,
	files: Record<string, string>,
	options?: ConstructorParameters<typeof YamlIncludeReader>[1],
) {
	const root = mkdtempSync(join(tmpdir(), "dsh-yaml-include-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [name, value] of Object.entries(files)) {
		mkdirSync(join(root, name, ".."), { recursive: true });
		writeFileSync(join(root, name), value);
	}
	return { root, reader: new YamlIncludeReader(root, options) };
}

const rejects = (reader: YamlIncludeReader, file: string, code: string) =>
	assert.throws(
		() => reader.read(file),
		(error: unknown) => errorCode(error, code),
	);

test("Includes resolve relative to each including document", (t) => {
	const { reader } = fixture(t, {
		"main.yml": "provider: !include nested/provider.yml",
		"nested/provider.yml": "models: !include ../models.yml",
		"models.yml": "- id: example",
	});
	assert.deepEqual(reader.read("main.yml"), {
		provider: { models: [{ id: "example" }] },
	});
});
test("Mapping, scalar and sequence include values preserve JSON YAML semantics", (t) => {
	const { reader } = fixture(t, {
		"main.yml": "off: null\na: !include scalar.yml\nb: !include list.yml",
		"scalar.yml": "42",
		"list.yml": "[true, off]",
	});
	assert.deepEqual(reader.read("main.yml"), {
		off: null,
		a: 42,
		b: [true, "off"],
	});
});
test("Anchors work inside a provider document", (t) => {
	const { reader } = fixture(t, {
		"main.yml": "x: &x {thinking: true}\ny: *x",
	});
	assert.deepEqual(record(reader.read("main.yml")).y, { thinking: true });
});
test("Circular aliases and expanded alias graphs are bounded", (t) => {
	const { reader, root } = fixture(t, {
		"cycle.yml": "a: &a [*a]",
		"large.yml": "a: &a [1, 2]\nb: &b [*a, *a]\nc: [*b, *b]",
	});
	rejects(reader, "cycle.yml", "CYCLE");
	rejects(new YamlIncludeReader(root, { maxNodes: 10 }), "large.yml", "LIMIT");
});
test("Missing roots have safe stable errors", () => {
	assert.throws(
		() => new YamlIncludeReader("missing-root-38c53726"),
		(error: unknown) =>
			errorCode(error, "FILE_UNAVAILABLE") &&
			error instanceof Error &&
			!error.message.includes(process.cwd()),
	);
});
test("Non-finite numbers and secret include filenames are not exposed", (t) => {
	const { reader } = fixture(t, {
		"number.yml": "a: .nan",
		"secret.yml": "!include sk-PRIVATE-VALUE.yml",
	});
	rejects(reader, "number.yml", "INVALID_YAML");
	assert.throws(
		() => reader.read("secret.yml"),
		(error: unknown) =>
			errorCode(error, "FILE_UNAVAILABLE") &&
			error instanceof Error &&
			!error.message.includes("PRIVATE-VALUE"),
	);
});
test("Cycles are rejected with a stable error code", (t) => {
	const { reader } = fixture(t, {
		"a.yml": "!include b.yml",
		"b.yml": "!include a.yml",
	});
	rejects(reader, "a.yml", "CYCLE");
});
test("Missing files and malformed YAML do not expose document contents", (t) => {
	const { reader } = fixture(t, { "bad.yml": "secret: [PRIVATE-VALUE" });
	rejects(reader, "missing.yml", "FILE_UNAVAILABLE");
	assert.throws(
		() => reader.read("bad.yml"),
		(error: unknown) =>
			errorCode(error, "INVALID_YAML") &&
			error instanceof Error &&
			!error.message.includes("PRIVATE-VALUE"),
	);
});
test("Duplicate keys and executable tags are rejected", (t) => {
	const { reader } = fixture(t, {
		"dup.yml": "a: 1\na: 2",
		"js.yml": "a: !!js process.exit()",
		"tag.yml": "a: !unknown test",
	});
	for (const file of ["dup.yml", "js.yml", "tag.yml"])
		rejects(reader, file, "INVALID_YAML");
});
test("Absolute paths, URLs and root escapes are rejected", (t) => {
	const { reader, root } = fixture(t, {});
	rejects(reader, "../outside.yml", "OUTSIDE_ROOT");
	rejects(reader, join(root, "x.yml"), "INVALID_PATH");
	rejects(reader, "https://example.com/x.yml", "INVALID_PATH");
});
test("Symlink escapes are rejected before reading the target", (t) => {
	const { reader, root } = fixture(t, {
		"nested/main.yml": "!include outside/secret.yml",
		"secret.yml": "secret: hidden",
	});
	symlinkSync(root, join(root, "nested/outside"), "junction");
	const confined = new YamlIncludeReader(join(root, "nested"));
	rejects(confined, "main.yml", "OUTSIDE_ROOT");
});
test("Depth, total bytes and number of file reads are bounded", (t) => {
	const files = {
		"a.yml": "x: !include b.yml\ny: !include b.yml",
		"b.yml": "value: 1",
	};
	for (const options of [{ maxDepth: 1 }, { maxBytes: 10 }, { maxFiles: 2 }]) {
		const { reader } = fixture(t, files, options);
		rejects(reader, "a.yml", "LIMIT");
	}
});
test("A failed load does not contaminate later reads and edits are reread", (t) => {
	const { reader, root } = fixture(t, { "main.yml": "!include child.yml" });
	rejects(reader, "main.yml", "FILE_UNAVAILABLE");
	writeFileSync(join(root, "child.yml"), "value: 1");
	const first = record(reader.read("main.yml"));
	first.value = 99;
	assert.deepEqual(reader.read("main.yml"), { value: 1 });
	writeFileSync(join(root, "child.yml"), "value: 2");
	assert.deepEqual(reader.read("main.yml"), { value: 2 });
});
