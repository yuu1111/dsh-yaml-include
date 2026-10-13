import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import yaml from "js-yaml";
import { YamlIncludeReader } from "./reader.js";

interface IncludeDocument {
	contents: unknown;
	getIn(path: Iterable<string | number>): unknown;
}

export function parseYamlWithIncludes(
	content: string,
	filename: string,
	schema?: yaml.Schema,
): unknown {
	if (!/(^|[\s[,])!include(?:\s|$)/m.test(content))
		return yaml.load(content, schema ? { schema } : {});
	const parent = realpathSync(dirname(resolve(filename)));
	let root = parent;
	while (!existsSync(join(root, "package.json")) && dirname(root) !== root)
		root = dirname(root);
	if (!existsSync(join(root, "package.json"))) root = parent;
	const document = join(
		parent,
		relative(dirname(resolve(filename)), resolve(filename)),
	);
	return new YamlIncludeReader(root).readText(
		content,
		relative(root, document),
		schema,
	);
}

export function containsYamlInclude(
	content: string,
	schema: yaml.Schema = yaml.JSON_SCHEMA,
): boolean {
	let found = false;
	const tag = new yaml.Type("!include", {
		kind: "scalar",
		construct: (value: unknown) => {
			found = true;
			return value;
		},
	});
	yaml.load(content, { schema: schema.extend(tag) });
	return found;
}

export function hasIncludeNode(
	node: unknown,
	document: IncludeDocument,
	ancestors: Set<object> = new Set(),
): boolean {
	if (!node || typeof node !== "object" || ancestors.has(node)) return false;
	if ("tag" in node && node.tag === "!include") return true;
	ancestors.add(node);
	if ("resolve" in node && typeof node.resolve === "function" && document) {
		const found = hasIncludeNode(node.resolve(document), document, ancestors);
		ancestors.delete(node);
		return found;
	}
	const found = ["items", "key", "value"].some((key) => {
		const child: unknown = key in node ? Reflect.get(node, key) : undefined;
		return Array.isArray(child)
			? child.some((item) => hasIncludeNode(item, document, ancestors))
			: hasIncludeNode(child, document, ancestors);
	});
	ancestors.delete(node);
	return found;
}

export function assertEditableIncludeRows(
	document: IncludeDocument,
	id: unknown,
): void {
	const contents = document.contents;
	if (
		!contents ||
		typeof contents !== "object" ||
		!("items" in contents) ||
		!Array.isArray(contents.items)
	)
		return;
	for (const [index, row] of contents.items.entries()) {
		if (document.getIn([index, "id"]) === id && hasIncludeNode(row, document)) {
			throw new Error(
				"Configuration uses !include; edit its source YAML rather than replacing the included value",
			);
		}
	}
}
