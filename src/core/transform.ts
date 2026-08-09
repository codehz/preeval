import MagicString from 'magic-string'
import type { Options } from '../types'
import { detectMarkedExports } from './detect'
import { evalModuleExports } from './eval'
import { serializeJson } from './serialize'

export interface TransformContext {
  warn: (msg: string) => void
  error: (msg: string) => void
}

/**
 * Detect `// @preeval`-marked exported consts, evaluate the module once, and
 * replace each marked initializer with its serialized JSON value.
 *
 * Failure policy:
 * - Module eval failure fails every mark at once: strict → `ctx.error` +
 *   throw; otherwise `ctx.warn` and return null (no transform).
 * - Per-binding serialization failure: strict → `ctx.error` + throw;
 *   otherwise `ctx.warn` and skip that binding.
 */
export async function transformPreeval(
  code: string,
  id: string,
  options: Options,
  ctx: TransformContext,
): Promise<{ code: string; map: object } | null> {
  // Strip ?query and #hash so the id is usable as a filesystem path.
  const cut = id.search(/[?#]/)
  const file = cut === -1 ? id : id.slice(0, cut)
  const bindings = detectMarkedExports(code, file)
  if (bindings.length === 0) return null

  let values: Map<string, unknown>
  try {
    values = await evalModuleExports(file, code, bindings, {
      allowNode: options.allowNode,
    })
  } catch (cause) {
    const msg = `[preeval] ${cause instanceof Error ? cause.message : String(cause)}`
    if (options.strict) {
      ctx.error(msg)
      throw new Error(msg)
    }
    ctx.warn(msg)
    return null
  }

  const s = new MagicString(code)
  let replaced = 0
  for (const binding of bindings) {
    if (!values.has(binding.name)) {
      const msg = `[preeval] ${file}: export "${binding.exportName}" of marked const "${binding.name}" was not found on the evaluated module namespace`
      if (options.strict) {
        ctx.error(msg)
        throw new Error(msg)
      }
      ctx.warn(msg)
      continue
    }
    let json: string
    try {
      json = serializeJson(values.get(binding.name))
    } catch (cause) {
      const msg = `[preeval] ${file}: marked const "${binding.name}" is not JSON-superset (${cause instanceof Error ? cause.message : String(cause)})`
      if (options.strict) {
        ctx.error(msg)
        throw new Error(msg)
      }
      ctx.warn(msg)
      continue
    }
    s.overwrite(binding.initStart, binding.initEnd, json)
    replaced++
  }

  if (replaced === 0) return null

  return {
    code: s.toString(),
    map: s.generateMap({ source: file, hires: true, includeContent: true }),
  }
}
