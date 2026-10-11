import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const hostEntry = process.env.DSH_TEST_HOST_ENTRY
const host = hostEntry ? createRequire(hostEntry) : null
const modules = host ? await Promise.all([
  import(pathToFileURL(host.resolve('@deepseek-ai/cordis')).href),
  import(pathToFileURL(host.resolve('@deepseek-ai/cordis-plugin-loader')).href),
  import(pathToFileURL(host.resolve('@deepseek-ai/dsh-app-boot')).href),
  import(pathToFileURL(host.resolve('@deepseek-ai/dsh-config-editor')).href),
  import(pathToFileURL(host.resolve('yaml')).href),
]) : null
const options = { skip: !hostEntry && 'Set DSH_TEST_HOST_ENTRY to an installed native-patched DSH package.json' }

async function fixture(t, profileText = '[]\n') {
  const [{ Context, Service }, { Loader }, boot, { ConfigEditor }, { parseDocument }] = modules
  const root = mkdtempSync(join(tmpdir(), 'dsh-editor-host-'))
  let ctx
  t.after(async () => {
    try { await ctx?.fiber.dispose() }
    finally { rmSync(root, { recursive: true, force: true }) }
  })
  const profile = join(root, 'profile')
  const bundle = join(profile, 'node_modules', 'editor-test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'editor-test-host', private: true }))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'editor-test-profile', private: true,
    dependencies: { 'editor-test-bundle': '1.0.0' },
    dsh: { profile: { bundles: ['editor-test-bundle'] } },
  }))
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    name: 'editor-test-bundle', version: '1.0.0',
    exports: { './cordis.patch.yml': './cordis.patch.yml' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  const source = join(bundle, 'providers.yml')
  writeFileSync(source, 'local:\n  baseURL: https://example.invalid/v1\n  models: [example]\n')
  const bundlePatch = join(bundle, 'cordis.patch.yml')
  writeFileSync(bundlePatch, '- insert:\n    - id: models\n      name: cordis:editor-models\n      config:\n        providers: !include providers.yml\n        selected: example\n    - id: other\n      name: cordis:editor-other\n      config: { enabled: true }\n')
  writeFileSync(join(profile, 'providers.yml'), readFileSync(source))
  writeFileSync(join(profile, 'config.yml'), 'providers: !include providers.yml\nselected: example\n')
  const patchPath = join(profile, 'cordis.patch.yml')
  writeFileSync(patchPath, profileText)
  const base = join(root, 'base.yml')
  writeFileSync(base, '[]\n')
  const installAnchor = join(root, 'package.json')
  const loaded = boot.loadProfileDirectory('editor-test', profile, installAnchor)
  assert.deepEqual(loaded.skippedBundles, [])
  assert.equal(loaded.layers.length, 1)
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  const loaderFiber = ctx.plugin(Loader)
  await loaderFiber
  const received = []
  const consumer = (_ctx, config) => { received.push(structuredClone(config)) }
  ctx.loader.builtins['editor-models'] = consumer
  ctx.loader.builtins['editor-other'] = consumer
  Object.assign(new Service(ctx, 'profileContext'), {
    dir: profile, home: root, patchPath, installAnchor, overlays: [],
  })
  await boot.mountRootInclude(ctx, base, boot.readProfilePatches('editor-test', ctx.profileContext))
  await ctx.loader.await()
  const editor = new ConfigEditor(ctx)
  assert.deepEqual(editor.entries().map(entry => entry.options.id).sort(), ['models', 'other'])
  assert.ok(received.length >= 2)
  for (const entry of editor.entries()) {
    assert.equal(entry.parent.tree.ctx.fiber.entry.id, 'include')
    assert.equal(entry.fiber.state, 2)
  }
  const bytes = new Map([source, bundlePatch, join(profile, 'providers.yml'), join(profile, 'config.yml')].map(path => [path, readFileSync(path)]))
  return {
    editor, ctx, boot, parseDocument, patchPath, bundlePatch, source,
    entry: id => editor.entries().find(entry => entry.options.id === id),
    row: id => editor.configuration().find(row => row.entry.options.id === id),
    unchanged() { for (const [path, before] of bytes) assert.deepEqual(readFileSync(path), before) },
  }
}

test('Installed ConfigEditor reads native bundle includes as inherited providers without a profile override', options, async t => {
  const f = await fixture(t)
  const row = f.row('models')
  assert.deepEqual(row.override, {})
  assert.equal(row.inherited.providers.local.baseURL, 'https://example.invalid/v1')
  assert.deepEqual(row.inherited.providers.local.models, ['example'])
  assert.deepEqual(row.entry.options.config, row.inherited)
  f.unchanged()
})

test('A profile override and reset for bundle-owned providers leave their include sources unchanged', options, async t => {
  const f = await fixture(t)
  await f.editor.edit(f.entry('models'), raw => ({ ...raw, selected: 'changed' }))
  assert.equal(f.row('models').override.selected, 'changed')
  assert.equal(f.entry('models').options.config.selected, 'changed')
  assert.equal(f.parseDocument(readFileSync(f.bundlePatch, 'utf8')).getIn([0, 'insert', 0, 'config', 'providers'], true).tag, '!include')
  f.unchanged()
  await f.editor.edit(f.entry('models'), (_raw, inherited) => inherited)
  assert.deepEqual(f.row('models').override, {})
  assert.equal(f.entry('models').options.config.selected, 'example')
  assert.deepEqual(f.parseDocument(readFileSync(f.patchPath, 'utf8')).toJS(), [])
  f.unchanged()
})

for (const [name, text] of [
  ['whole config', '- id: models\n  config: !include config.yml\n'],
  ['providers value', '- id: models\n  config:\n    providers: !include providers.yml\n    selected: example\n'],
  ['aliased config', '- id: models\n  config: &config\n    providers: !include providers.yml\n    selected: example\n- id: models\n  config: *config\n'],
]) {
  test(`Profile-owned ${name} includes reject GUI edit and reset without modifying any source`, options, async t => {
    const f = await fixture(t, text)
    const before = readFileSync(f.patchPath)
    assert.equal(f.entry('models').options.config.providers.local.models[0], 'example')
    for (const change of [raw => ({ ...raw, selected: 'changed' }), (_raw, inherited) => inherited]) {
      await assert.rejects(f.editor.edit(f.entry('models'), change), /include|alias|external|read.only/i)
      assert.deepEqual(readFileSync(f.patchPath), before)
      f.unchanged()
    }
  })
}

test('Editing another profile row preserves the native include tag and source bytes', options, async t => {
  const f = await fixture(t, '# provider ownership stays external\n- id: models\n  config:\n    providers: !include providers.yml # shared providers\n    selected: example\n')
  await f.editor.edit(f.entry('other'), raw => ({ ...raw, enabled: false }))
  assert.equal(f.entry('other').options.config.enabled, false)
  assert.equal(f.row('other').override.enabled, false)
  const saved = readFileSync(f.patchPath, 'utf8')
  const document = f.parseDocument(saved)
  const node = document.getIn([0, 'config', 'providers'], true)
  assert.equal(node.tag, '!include')
  assert.equal(node.value, 'providers.yml')
  assert.match(saved, /# provider ownership stays external/)
  assert.match(saved, /# shared providers/)
  assert.equal(f.row('models').override.providers.local.models[0], 'example')
  await f.editor.edit(f.entry('other'), (_raw, inherited) => inherited)
  assert.deepEqual(f.row('other').override, {})
  assert.equal(f.parseDocument(readFileSync(f.patchPath, 'utf8')).getIn([0, 'config', 'providers'], true).tag, '!include')
  f.unchanged()
})

test('A reconciliation failure after saving restores the exact profile text and running configuration', options, async t => {
  const f = await fixture(t, '# exact rollback fixture\n[]\n')
  const before = readFileSync(f.patchPath)
  const rootInclude = [...f.ctx.loader.entries()].find(entry => entry.options.id === 'include')
  assert.ok(rootInclude)
  const update = rootInclude.update
  let failed = false
  rootInclude.update = async function (...args) {
    if (!failed && readFileSync(f.patchPath, 'utf8').includes('rollback-trigger')) {
      failed = true
      throw new Error('Injected reconciliation failure after profile save')
    }
    return update.apply(this, args)
  }
  try {
    await assert.rejects(f.editor.edit(f.entry('models'), raw => ({ ...raw, selected: 'rollback-trigger' })), /Injected reconciliation failure/)
    assert.equal(failed, true)
    assert.deepEqual(readFileSync(f.patchPath), before)
    assert.equal(f.entry('models').options.config.selected, 'example')
    assert.deepEqual(f.row('models').override, {})
    f.unchanged()
  } finally {
    rootInclude.update = update
  }
})
