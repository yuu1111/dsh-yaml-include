import { existsSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve, join } from 'node:path'
import yaml from 'js-yaml'
import { YamlIncludeReader } from './reader.js'

export function parseYamlWithIncludes(content, filename, schema) {
  if (!/(^|[\s\[,])!include(?:\s|$)/m.test(content)) return yaml.load(content, { schema })
  const parent = realpathSync(dirname(resolve(filename)))
  let root = parent
  while (!existsSync(join(root, 'package.json')) && dirname(root) !== root) root = dirname(root)
  if (!existsSync(join(root, 'package.json'))) root = parent
  const document = join(parent, relative(dirname(resolve(filename)), resolve(filename)))
  return new YamlIncludeReader(root).readText(content, relative(root, document), schema)
}

export function containsYamlInclude(content, schema = yaml.JSON_SCHEMA) {
  let found = false
  const tag = new yaml.Type('!include', { kind: 'scalar', construct: value => { found = true; return value } })
  yaml.load(content, { schema: schema.extend(tag) })
  return found
}

export function hasIncludeNode(node, document, ancestors = new Set()) {
  if (!node || typeof node !== 'object' || ancestors.has(node)) return false
  if (node.tag === '!include') return true
  ancestors.add(node)
  if (typeof node.resolve === 'function' && document) {
    const found = hasIncludeNode(node.resolve(document), document, ancestors)
    ancestors.delete(node)
    return found
  }
  const found = ['items', 'key', 'value'].some(key => {
    const child = node[key]
    return Array.isArray(child) ? child.some(item => hasIncludeNode(item, document, ancestors)) : hasIncludeNode(child, document, ancestors)
  })
  ancestors.delete(node)
  return found
}

export function assertEditableIncludeRows(document, id) {
  for (const [index, row] of (document.contents?.items ?? []).entries()) {
    if (document.getIn([index, 'id']) === id && hasIncludeNode(row, document)) {
      throw new Error('Configuration uses !include; edit its source YAML rather than replacing the included value')
    }
  }
}
