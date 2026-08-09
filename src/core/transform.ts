import MagicString from 'magic-string'
import type { Options } from '../types'
import { analyzePreevalModule, type EvaluationPlan } from './analyze'
import { evalExtractedModule } from './eval'
import { serializeJson } from './serialize'

export interface TransformContext {
  warn: (msg: string) => void
  error: (msg: string) => void
}

/**
 * Detect `// @preeval`-marked top-level consts, extract and evaluate their
 * lexical dependency closure once, and replace each marked initializer with
 * its serialized JSON value.
 *
 * Failure policy:
 * - Analysis or module eval failure fails every mark at once: strict →
 *   `ctx.error` + throw; otherwise `ctx.warn` and return null (no transform).
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

  let plan: EvaluationPlan | null
  try {
    plan = analyzePreevalModule(code, file)
  } catch (cause) {
    const msg = `[preeval] ${file}: ${cause instanceof Error ? cause.message : String(cause)}`
    if (options.strict) {
      ctx.error(msg)
      throw new Error(msg, { cause })
    }
    ctx.warn(msg)
    return null
  }
  if (plan == null || plan.targets.length === 0) return null

  let values: Map<string, unknown>
  try {
    values = await evalExtractedModule(file, plan, {
      allowNode: options.allowNode,
    })
  } catch (cause) {
    const msg = `[preeval] ${cause instanceof Error ? cause.message : String(cause)}`
    if (options.strict) {
      ctx.error(msg)
      throw new Error(msg, { cause })
    }
    ctx.warn(msg)
    return null
  }

  const s = new MagicString(code)
  let replaced = 0
  for (const target of plan.targets) {
    if (!values.has(target.name)) {
      const msg = `[preeval] ${file}: marked const "${target.name}" was not found on the evaluated module namespace`
      if (options.strict) {
        ctx.error(msg)
        throw new Error(msg)
      }
      ctx.warn(msg)
      continue
    }
    let json: string
    try {
      json = serializeJson(values.get(target.name))
    } catch (cause) {
      const msg = `[preeval] ${file}: marked const "${target.name}" is not JSON-superset (${cause instanceof Error ? cause.message : String(cause)})`
      if (options.strict) {
        ctx.error(msg)
        throw new Error(msg, { cause })
      }
      ctx.warn(msg)
      continue
    }
    s.overwrite(target.initStart, target.initEnd, json)
    replaced++
  }

  if (replaced === 0) return null

  return {
    code: s.toString(),
    map: s.generateMap({ source: file, hires: true, includeContent: true }),
  }
}
