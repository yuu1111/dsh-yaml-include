import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { parseDocument } from 'yaml'
import { parseYamlWithIncludes, containsYamlInclude, assertEditableIncludeRows } from '../src/native.js'

const js = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: __jsExpr => ({ __jsExpr }) })
const schema = yaml.JSON_SCHEMA.extend(js)
const customTags = [{ tag: '!include', resolve: value => value }]
function fixture(t) {
 const root = mkdtempSync(join(tmpdir(), 'dsh-native-include-'))
 t.after(() => rmSync(root, { recursive: true, force: true }))
 mkdirSync(join(root, 'patches'))
 mkdirSync(join(root, 'providers'))
 writeFileSync(join(root, 'package.json'), '{}')
 writeFileSync(join(root, 'providers/main.yml'), 'providers:\n  example: !include nested.yml')
 writeFileSync(join(root, 'providers/nested.yml'), 'models: [{id: example}]')
 return root
}
test('Ordinary patches include complete config without JavaScript', t => {
 const root = fixture(t)
 const content = '- id: llm\n  config: !include ../providers/main.yml'
 const result = parseYamlWithIncludes(content, join(root, 'patches/models.patch.yml'), schema)
 assert.deepEqual(result, [{ id: 'llm', config: { providers: { example: { models: [{ id: 'example' }] } } } }])
})
test('Candidate text is parsed without rereading the old patch', t => {
 const root = fixture(t)
 const path = join(root, 'patches/models.patch.yml')
 writeFileSync(path, 'INVALID: [')
 assert.equal(parseYamlWithIncludes('- id: llm\n  config: !include ../providers/main.yml', path, schema)[0].id, 'llm')
})
test('The existing expression dialect remains available without evaluation', t => {
 const root = fixture(t)
 const result = parseYamlWithIncludes('- id: llm\n  config: !include ../providers/main.yml\n- id: other\n  config: !!js process.exit(99)', join(root, 'patches/main.yml'), schema)
 assert.deepEqual(result[1].config, { __jsExpr: 'process.exit(99)' })
})
test('Sources are confined to their package and separate parses do not share state', t => {
 const first = fixture(t), second = fixture(t)
 writeFileSync(join(second, 'providers/nested.yml'), 'models: [{id: second}]')
 const content = 'config: !include ../providers/main.yml'
 assert.equal(parseYamlWithIncludes(content, join(first,'patches/main.yml'), schema).config.providers.example.models[0].id, 'example')
 assert.equal(parseYamlWithIncludes(content, join(second,'patches/main.yml'), schema).config.providers.example.models[0].id, 'second')
 assert.throws(() => parseYamlWithIncludes('config: !include ../../outside.yml',join(first,'patches/main.yml'),schema), e => e.code === 'OUTSIDE_ROOT')
})
test('GUI protects include-containing rows and permits unrelated rows', () => {
 const document = parseDocument('- id: included\n  config: !include source.yml\n- id: ordinary\n  config: {value: 1}', { customTags })
 assertEditableIncludeRows(document, 'ordinary')
 assert.throws(() => assertEditableIncludeRows(document, 'included'), /edit its source YAML/)
 document.setIn([1, 'config', 'value'], 2)
 assert.match(String(document), /config: !include source.yml/)
})
test('GUI protection follows aliases and duplicate IDs', () => {
 const document = parseDocument('- id: owner\n  config: &shared {providers: !include source.yml}\n- id: consumer\n  config: *shared\n- id: owner\n  config: {}', { customTags })
 assert.throws(() => assertEditableIncludeRows(document, 'consumer'), /edit its source YAML/)
 assert.throws(() => assertEditableIncludeRows(document, 'owner'), /edit its source YAML/)
})
test('Read-only detection distinguishes real tags from comments and strings', () => {
 assert.equal(containsYamlInclude('a: !include source.yml',schema),true)
 assert.equal(containsYamlInclude('# !include source.yml\na: "!include source.yml"',schema),false)
})
