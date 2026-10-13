import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import yaml from "js-yaml";
import { YamlIncludeReader } from "./reader.js";

/**
 * Keeps editor integration structural so copied runtime helpers do not import YAML nodes.
 */
interface IncludeDocument {
	/**
	 * Preserves syntax nodes rather than flattening include tags into configuration values.
	 */
	contents: unknown;

	/**
	 * Delegates row lookup to the host rather than assuming its scalar representation.
	 *
	 * @param path - Keys and indexes relative to the containing YAML document.
	 * @returns A host-owned value that must be compared without type coercion.
	 */
	getIn(path: Iterable<string | number>): unknown;
}

/**
 * Parses a document without expanding includes outside its package boundary.
 *
 * @param content - Candidate YAML text; the original file is not reread.
 * @param filename - Document path used to anchor relative includes.
 * @param schema - Existing host schema retained for compatibility.
 * @returns The parsed YAML value without evaluating expression tags.
 * @throws A parsing or filesystem error when the document is invalid.
 */
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

/**
 * Detects include tags without reading their referenced files.
 *
 * @param content - YAML text to inspect.
 * @param schema - Host schema used to recognize existing tags.
 * @returns Whether a real include tag occurs, excluding comments and strings.
 * @throws A parsing error when the YAML text is invalid.
 */
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

/**
 * Checks aliases as well as direct tags so editing cannot bypass include protection.
 *
 * @param node - Candidate syntax node.
 * @param document - Containing document used to resolve aliases.
 * @param ancestors - Active traversal nodes used to avoid cyclic aliases.
 * @returns Whether an include tag is reachable from the node.
 */
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

/**
 * Rejects include-owned rows rather than silently flattening their source files.
 *
 * @param document - Profile patch document to inspect.
 * @param id - Target row identifier, including duplicate matching rows.
 * @throws An error when a matching row contains an include.
 */
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
