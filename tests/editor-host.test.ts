import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type { parseDocument as parseYamlDocument } from "yaml";
import { array, record } from "./assertions.js";

/**
 * Host configuration stays untrusted until assertions narrow each YAML value.
 */
type Config = Record<string, unknown>;

/**
 * Editor changes must distinguish a profile override from inherited bundle configuration.
 */
type Change = (raw: Config, inherited: Config) => Config;

/**
 * The installed loader must expose live entries, not editor-only stand-ins.
 */
interface Entry {
	/**
	 * Entry identity and effective configuration must agree with the running loader.
	 */
	options: { id: string; config: Config };

	/**
	 * Ownership must remain rooted in the native include tree.
	 */
	parent: { tree: { ctx: { fiber: { entry: { id: string } } } } };

	/**
	 * A loaded entry must reach the host’s active fiber state.
	 */
	fiber: { state: number };

	/**
	 * Reconciliation must remain callable so rollback can be tested after a real save.
	 *
	 * @param args - Host reconciliation arguments forwarded unchanged.
	 * @returns The host update result.
	 */
	update(...args: unknown[]): Promise<unknown>;
}

/**
 * Editor rows must separate writable overrides from inherited configuration.
 */
interface Row {
	/**
	 * The row must refer to the live entry rather than a detached configuration copy.
	 */
	entry: Entry;

	/**
	 * Only profile-owned changes belong in the writable override.
	 */
	override: Config;

	/**
	 * Bundle-owned providers remain available when the profile override is reset.
	 */
	inherited: Config;
}

/**
 * The integration boundary uses installed Cordis services instead of mocked editor state.
 */
interface HostContext {
	/**
	 * Module resolution must be anchored to the isolated host root.
	 */
	baseUrl: string;

	/**
	 * Host resources must be disposed before their temporary files are removed.
	 */
	fiber: { dispose(): Promise<void> };

	/**
	 * Plugin readiness must be observable before the loader service is used.
	 *
	 * @param plugin - Installed host plugin.
	 * @returns The host plugin readiness handle.
	 */
	plugin(plugin: unknown): PromiseLike<unknown>;

	/**
	 * The real loader must activate consumers and expose entries for reconciliation.
	 */
	loader: {
		builtins: Record<string, (ctx: unknown, config: Config) => void>;
		await(): Promise<void>;
		entries(): Iterable<Entry>;
	};

	/**
	 * Profile paths and overlays must belong to this fixture, not the user’s installation.
	 */
	profileContext: {
		dir: string;
		home: string;
		patchPath: string;
		installAnchor: string;
		overlays: unknown[];
	};
}

/**
 * Installed editor behavior must preserve external ownership across edits and resets.
 */
interface Editor {
	/**
	 * Editable entries must retain their live loader identity.
	 *
	 * @returns Entries visible to the installed editor.
	 */
	entries(): Entry[];

	/**
	 * Configuration must expose inheritance independently of persisted overrides.
	 *
	 * @returns Current editor rows.
	 */
	configuration(): Row[];

	/**
	 * Edits must reconcile live configuration or reject without corrupting source files.
	 *
	 * @param entry - Live entry targeted by the edit.
	 * @param change - Requested override or reset.
	 * @returns Completion of persistence and reconciliation.
	 */
	edit(entry: Entry, change: Change): Promise<void>;
}

/**
 * Installed boot services must discover and mount native bundle includes without substitutes.
 */
interface Boot {
	/**
	 * Profile discovery must recognize the fixture’s declared bundle.
	 *
	 * @param name - Isolated profile identity.
	 * @param profile - Fixture profile directory.
	 * @param anchor - Fixture installation manifest.
	 * @returns Bundle discovery outcomes and configuration layers.
	 */
	loadProfileDirectory(
		name: string,
		profile: string,
		anchor: string,
	): { skippedBundles: unknown[]; layers: unknown[] };

	/**
	 * Patch loading must use the same profile boundary as the installed editor.
	 *
	 * @param name - Isolated profile identity.
	 * @param profile - Fixture-owned profile paths and overlays.
	 * @returns Host patch data for mounting.
	 */
	readProfilePatches(
		name: string,
		profile: HostContext["profileContext"],
	): unknown;

	/**
	 * Native includes must enter the actual loader tree before editor assertions run.
	 *
	 * @param ctx - Installed host context.
	 * @param base - Fixture root configuration path.
	 * @param patches - Host-resolved profile patches.
	 * @returns Completion of root include mounting.
	 */
	mountRootInclude(
		ctx: HostContext,
		base: string,
		patches: unknown,
	): Promise<void>;
}

/**
 * All integration dependencies must resolve from one installed, native-patched host.
 */
type HostModules = [
	{
		Context: new () => HostContext;
		Service: new (ctx: HostContext, name: string) => object;
	},
	{ Loader: unknown },
	Boot,
	{ ConfigEditor: new (ctx: HostContext) => Editor },
	{ parseDocument: typeof parseYamlDocument },
];

/**
 * Provider assertions require mapping shapes at both ownership boundaries.
 *
 * @param config - Effective, inherited, or overridden configuration.
 * @returns The local provider mapping.
 * @throws An assertion error when either mapping is absent.
 */
function localProviders(config: Config): Config {
	return record(record(config.providers).local);
}

/**
 * An incompatible installed host must fail explicitly rather than fall back to mocks.
 *
 * @param value - Dynamically imported host modules.
 * @returns No runtime value; successful validation narrows the host-module boundary.
 * @throws An assertion error when required host exports are unavailable.
 */
function assertHostModules(value: unknown): asserts value is HostModules {
	const loaded = array(value);
	assert.equal(loaded.length, 5);
	const cordis = record(loaded[0]);
	const loader = record(loaded[1]);
	const boot = record(loaded[2]);
	const editor = record(loaded[3]);
	const yaml = record(loaded[4]);
	for (const exported of [
		cordis.Context,
		cordis.Service,
		loader.Loader,
		boot.loadProfileDirectory,
		boot.readProfilePatches,
		boot.mountRootInclude,
		editor.ConfigEditor,
		yaml.parseDocument,
	]) {
		assert.equal(typeof exported, "function");
	}
}

/**
 * Integration coverage requires an explicit installed host; local dependencies are not a substitute.
 */
const hostEntry = process.env.DSH_TEST_HOST_ENTRY;

/**
 * Host-relative resolution prevents mixing installed Cordis services with repository dependencies.
 */
const host = hostEntry ? createRequire(hostEntry) : null;

/**
 * Imports remain untrusted until the required installed-host exports are verified.
 */
const loadedModules: unknown = host
	? await Promise.all([
			import(pathToFileURL(host.resolve("@deepseek-ai/cordis")).href),
			import(
				pathToFileURL(host.resolve("@deepseek-ai/cordis-plugin-loader")).href
			),
			import(pathToFileURL(host.resolve("@deepseek-ai/dsh-app-boot")).href),
			import(
				pathToFileURL(host.resolve("@deepseek-ai/dsh-config-editor")).href
			),
			import(pathToFileURL(host.resolve("yaml")).href),
		])
	: null;
if (loadedModules !== null) assertHostModules(loadedModules);

/**
 * Fixtures share the validated host boundary while keeping their runtime contexts isolated.
 */
const modules: HostModules | null = loadedModules;

/**
 * Missing host opt-in must be reported as skipped integration coverage, not simulated success.
 */
const options = {
	skip:
		!hostEntry &&
		"Set DSH_TEST_HOST_ENTRY to an installed native-patched DSH package.json",
};

/**
 * Real boot and editor services are required to expose ownership and post-save rollback failures.
 *
 * @param t - Test lifecycle responsible for host disposal and temporary-file cleanup.
 * @param profileText - Exact initial profile text used to test persistence and rollback.
 * @returns An isolated live editor with source-byte preservation assertions.
 */
async function fixture(t: TestContext, profileText = "[]\n") {
	assert.ok(modules);
	const [
		{ Context, Service },
		{ Loader },
		boot,
		{ ConfigEditor },
		{ parseDocument },
	] = modules;
	const root = mkdtempSync(join(tmpdir(), "dsh-editor-host-"));
	let ctx: HostContext | undefined;
	t.after(async () => {
		try {
			await ctx?.fiber.dispose();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	const profile = join(root, "profile");
	const bundle = join(profile, "node_modules", "editor-test-bundle");
	mkdirSync(bundle, { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "editor-test-host", private: true }),
	);
	writeFileSync(
		join(profile, "package.json"),
		JSON.stringify({
			name: "editor-test-profile",
			private: true,
			dependencies: { "editor-test-bundle": "1.0.0" },
			dsh: { profile: { bundles: ["editor-test-bundle"] } },
		}),
	);
	writeFileSync(
		join(bundle, "package.json"),
		JSON.stringify({
			name: "editor-test-bundle",
			version: "1.0.0",
			exports: { "./cordis.patch.yml": "./cordis.patch.yml" },
			dsh: { bundle: { patch: "./cordis.patch.yml" } },
		}),
	);
	const source = join(bundle, "providers.yml");
	writeFileSync(
		source,
		"local:\n  baseURL: https://example.invalid/v1\n  models: [example]\n",
	);
	const bundlePatch = join(bundle, "cordis.patch.yml");
	writeFileSync(
		bundlePatch,
		"- insert:\n    - id: models\n      name: cordis:editor-models\n      config:\n        providers: !include providers.yml\n        selected: example\n    - id: other\n      name: cordis:editor-other\n      config: { enabled: true }\n",
	);
	writeFileSync(join(profile, "providers.yml"), readFileSync(source));
	writeFileSync(
		join(profile, "config.yml"),
		"providers: !include providers.yml\nselected: example\n",
	);
	const patchPath = join(profile, "cordis.patch.yml");
	writeFileSync(patchPath, profileText);
	const base = join(root, "base.yml");
	writeFileSync(base, "[]\n");
	const installAnchor = join(root, "package.json");
	const loaded = boot.loadProfileDirectory(
		"editor-test",
		profile,
		installAnchor,
	);
	assert.deepEqual(loaded.skippedBundles, []);
	assert.equal(loaded.layers.length, 1);
	ctx = new Context();
	ctx.baseUrl = `${pathToFileURL(root).href}/`;
	const loaderFiber = ctx.plugin(Loader);
	await loaderFiber;
	const received: Config[] = [];
	const consumer = (_ctx: unknown, config: Config) => {
		received.push(structuredClone(config));
	};
	ctx.loader.builtins["editor-models"] = consumer;
	ctx.loader.builtins["editor-other"] = consumer;
	Object.assign(new Service(ctx, "profileContext"), {
		dir: profile,
		home: root,
		patchPath,
		installAnchor,
		overlays: [],
	});
	await boot.mountRootInclude(
		ctx,
		base,
		boot.readProfilePatches("editor-test", ctx.profileContext),
	);
	await ctx.loader.await();
	const editor = new ConfigEditor(ctx);
	assert.deepEqual(
		editor
			.entries()
			.map((entry) => entry.options.id)
			.sort(),
		["models", "other"],
	);
	assert.ok(received.length >= 2);
	for (const entry of editor.entries()) {
		assert.equal(entry.parent.tree.ctx.fiber.entry.id, "include");
		assert.equal(entry.fiber.state, 2);
	}
	const bytes = new Map(
		[
			source,
			bundlePatch,
			join(profile, "providers.yml"),
			join(profile, "config.yml"),
		].map((path) => [path, readFileSync(path)]),
	);
	return {
		editor,
		ctx,
		boot,
		parseDocument,
		patchPath,
		bundlePatch,
		source,
		entry: (id: string) => {
			const entry = editor.entries().find((entry) => entry.options.id === id);
			assert.ok(entry);
			return entry;
		},
		row: (id: string) => {
			const row = editor
				.configuration()
				.find((row) => row.entry.options.id === id);
			assert.ok(row);
			return row;
		},
		unchanged() {
			for (const [path, before] of bytes)
				assert.deepEqual(readFileSync(path), before);
		},
	};
}

test(
	"Installed ConfigEditor reads native bundle includes as inherited providers without a profile override",
	options,
	async (t) => {
		const f = await fixture(t);
		const row = f.row("models");
		assert.deepEqual(row.override, {});
		assert.equal(
			localProviders(row.inherited).baseURL,
			"https://example.invalid/v1",
		);
		assert.deepEqual(localProviders(row.inherited).models, ["example"]);
		assert.deepEqual(row.entry.options.config, row.inherited);
		f.unchanged();
	},
);

test(
	"A profile override and reset for bundle-owned providers leave their include sources unchanged",
	options,
	async (t) => {
		const f = await fixture(t);
		await f.editor.edit(f.entry("models"), (raw) => ({
			...raw,
			selected: "changed",
		}));
		assert.equal(f.row("models").override.selected, "changed");
		assert.equal(f.entry("models").options.config.selected, "changed");
		assert.equal(
			record(
				f
					.parseDocument(readFileSync(f.bundlePatch, "utf8"))
					.getIn([0, "insert", 0, "config", "providers"], true),
			).tag,
			"!include",
		);
		f.unchanged();
		await f.editor.edit(f.entry("models"), (_raw, inherited) => inherited);
		assert.deepEqual(f.row("models").override, {});
		assert.equal(f.entry("models").options.config.selected, "example");
		assert.deepEqual(
			f.parseDocument(readFileSync(f.patchPath, "utf8")).toJS(),
			[],
		);
		f.unchanged();
	},
);

for (const [name, text] of [
	["whole config", "- id: models\n  config: !include config.yml\n"],
	[
		"providers value",
		"- id: models\n  config:\n    providers: !include providers.yml\n    selected: example\n",
	],
	[
		"aliased config",
		"- id: models\n  config: &config\n    providers: !include providers.yml\n    selected: example\n- id: models\n  config: *config\n",
	],
] as const) {
	test(
		`Profile-owned ${name} includes reject GUI edit and reset without modifying any source`,
		options,
		async (t) => {
			const f = await fixture(t, text);
			const before = readFileSync(f.patchPath);
			assert.equal(
				array(localProviders(f.entry("models").options.config).models)[0],
				"example",
			);
			for (const change of [
				(raw) => ({ ...raw, selected: "changed" }),
				(_raw, inherited) => inherited,
			] satisfies Change[]) {
				await assert.rejects(
					f.editor.edit(f.entry("models"), change),
					/include|alias|external|read.only/i,
				);
				assert.deepEqual(readFileSync(f.patchPath), before);
				f.unchanged();
			}
		},
	);
}

test(
	"Editing another profile row preserves the native include tag and source bytes",
	options,
	async (t) => {
		const f = await fixture(
			t,
			"# provider ownership stays external\n- id: models\n  config:\n    providers: !include providers.yml # shared providers\n    selected: example\n",
		);
		await f.editor.edit(f.entry("other"), (raw) => ({
			...raw,
			enabled: false,
		}));
		assert.equal(f.entry("other").options.config.enabled, false);
		assert.equal(f.row("other").override.enabled, false);
		const saved = readFileSync(f.patchPath, "utf8");
		const document = f.parseDocument(saved);
		const node = record(document.getIn([0, "config", "providers"], true));
		assert.equal(node.tag, "!include");
		assert.equal(node.value, "providers.yml");
		assert.match(saved, /# provider ownership stays external/);
		assert.match(saved, /# shared providers/);
		assert.equal(
			array(localProviders(f.row("models").override).models)[0],
			"example",
		);
		await f.editor.edit(f.entry("other"), (_raw, inherited) => inherited);
		assert.deepEqual(f.row("other").override, {});
		assert.equal(
			record(
				f
					.parseDocument(readFileSync(f.patchPath, "utf8"))
					.getIn([0, "config", "providers"], true),
			).tag,
			"!include",
		);
		f.unchanged();
	},
);

test(
	"A reconciliation failure after saving restores the exact profile text and running configuration",
	options,
	async (t) => {
		const f = await fixture(t, "# exact rollback fixture\n[]\n");
		const before = readFileSync(f.patchPath);
		const rootInclude = [...f.ctx.loader.entries()].find(
			(entry) => entry.options.id === "include",
		);
		assert.ok(rootInclude);
		const update = rootInclude.update;
		let failed = false;
		rootInclude.update = async function (...args) {
			if (
				!failed &&
				readFileSync(f.patchPath, "utf8").includes("rollback-trigger")
			) {
				failed = true;
				throw new Error("Injected reconciliation failure after profile save");
			}
			return update.apply(this, args);
		};
		try {
			await assert.rejects(
				f.editor.edit(f.entry("models"), (raw) => ({
					...raw,
					selected: "rollback-trigger",
				})),
				/Injected reconciliation failure/,
			);
			assert.equal(failed, true);
			assert.deepEqual(readFileSync(f.patchPath), before);
			assert.equal(f.entry("models").options.config.selected, "example");
			assert.deepEqual(f.row("models").override, {});
			f.unchanged();
		} finally {
			rootInclude.update = update;
		}
	},
);
