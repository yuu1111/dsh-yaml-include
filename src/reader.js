import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import yaml from 'js-yaml'

export class YamlIncludeError extends Error {
  constructor(code, message) { super(message); this.name = 'YamlIncludeError'; this.code = code }
}

function inside(root, path) {
  const part = relative(root, path)
  return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep)
}

export class YamlIncludeReader {
  constructor(directory, { maxDepth = 32, maxBytes = 1024 * 1024, maxFiles = 128, maxNodes = 100000 } = {}) {
    try { this.directory = realpathSync(directory) }
    catch { throw new YamlIncludeError('FILE_UNAVAILABLE', 'Cannot open YAML include root') }
    this.limits = { maxDepth, maxBytes, maxFiles, maxNodes }
    for (const limit of Object.values(this.limits)) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Include limits must be positive integers')
    }
  }

  read(filename) {
    return this.validate(this.load(filename, this.directory, { stack: [], bytes: 0, files: 0 }))
  }

  readText(content, filename, schema = yaml.JSON_SCHEMA) {
    return this.validate(this.load(filename, this.directory, { stack: [], bytes: 0, files: 0, sourceText: content, schema }))
  }

  validate(value) {
    const ancestors = new Set()
    let nodes = 0
    let bytes = 0
    const visit = (node, depth) => {
      if (++nodes > this.limits.maxNodes || depth > this.limits.maxDepth) throw new YamlIncludeError('LIMIT', 'Expanded YAML graph limit exceeded')
      if (typeof node === 'number' && !Number.isFinite(node)) throw new YamlIncludeError('INVALID_YAML', 'YAML numbers must be finite')
      if (typeof node === 'string') bytes += Buffer.byteLength(node)
      if (bytes > this.limits.maxBytes) throw new YamlIncludeError('LIMIT', 'Expanded YAML byte limit exceeded')
      if (!node || typeof node !== 'object') return
      if (ancestors.has(node)) throw new YamlIncludeError('CYCLE', 'Circular YAML alias')
      ancestors.add(node)
      for (const [key, child] of Object.entries(node)) {
        bytes += Buffer.byteLength(key)
        visit(child, depth + 1)
      }
      ancestors.delete(node)
    }
    visit(value, 0)
    return value
  }

  load(filename, base, state) {
    if (typeof filename !== 'string' || !filename || isAbsolute(filename) || /^[a-z][a-z0-9+.-]*:/i.test(filename)) {
      throw new YamlIncludeError('INVALID_PATH', 'Include requires a relative local YAML path')
    }
    const candidate = resolve(base, filename)
    if (!inside(this.directory, candidate)) throw new YamlIncludeError('OUTSIDE_ROOT', 'Include escapes configured root')
    let path
    try { path = realpathSync(candidate) }
    catch {
      if (state.stack.length === 0 && state.sourceText !== undefined) path = candidate
      else throw new YamlIncludeError('FILE_UNAVAILABLE', 'Cannot open YAML file')
    }
    if (!inside(this.directory, path)) throw new YamlIncludeError('OUTSIDE_ROOT', 'Include symlink escapes configured root')
    if (!['.yml', '.yaml'].includes(extname(path).toLowerCase())) throw new YamlIncludeError('INVALID_PATH', 'Include requires a .yml or .yaml file')
    if (state.stack.includes(path)) throw new YamlIncludeError('CYCLE', 'Circular YAML include')
    if (state.stack.length >= this.limits.maxDepth) throw new YamlIncludeError('LIMIT', 'YAML include depth limit exceeded')
    if (++state.files > this.limits.maxFiles) throw new YamlIncludeError('LIMIT', 'YAML include file limit exceeded')
    let text
    try {
      if (state.stack.length === 0 && state.sourceText !== undefined) text = state.sourceText
      else {
        if (!statSync(path).isFile()) throw new Error()
        if (statSync(path).size > this.limits.maxBytes - state.bytes) throw new YamlIncludeError('LIMIT', 'YAML include byte limit exceeded')
        text = readFileSync(path, 'utf8')
      }
    } catch (error) {
      if (error instanceof YamlIncludeError) throw error
      throw new YamlIncludeError('FILE_UNAVAILABLE', 'Cannot read YAML file')
    }
    state.bytes += Buffer.byteLength(text)
    if (state.bytes > this.limits.maxBytes) throw new YamlIncludeError('LIMIT', 'YAML include byte limit exceeded')
    state.stack.push(path)
    try {
      const include = new yaml.Type('!include', {
        kind: 'scalar',
        construct: child => this.load(child, dirname(path), state),
      })
      return yaml.load(text, { schema: (state.schema ?? yaml.JSON_SCHEMA).extend(include) })
    } catch (error) {
      if (error instanceof YamlIncludeError) throw error
      throw new YamlIncludeError('INVALID_YAML', 'Invalid YAML document')
    } finally { state.stack.pop() }
  }
}
