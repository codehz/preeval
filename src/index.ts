import { createUnplugin, type TransformResult, type UnpluginFactory } from 'unplugin'
import type { FailurePolicy, ImportedFunctionRef, Options } from './types'
import { transformPreeval } from './core/transform'

export type { FailurePolicy, ImportedFunctionRef, Options, PreevalRule } from './types'

/**
 * Structural stand-in for rollup's SourceMapInput. `transformPreeval` produces
 * magic-string's sourcemap (version/sources/names/mappings/…), which is
 * runtime-compatible with rollup's RawSourceMap — no need for a rollup dep.
 */
interface PreevalSourceMap {
  version: number
  sources: string[]
  sourcesContent?: (string | null)[]
  names: string[]
  mappings: string
  file?: string
  sourceRoot?: string
}

const DEFAULT_INCLUDE = /\.[cm]?[jt]sx?$/
const DEFAULT_EXCLUDE = /node_modules/
const MARKER = '@preeval'

const FAILURE_POLICIES = new Set<FailurePolicy>(['ignore', 'warn', 'error'])

function assertFailurePolicy(value: unknown, field: string): asserts value is FailurePolicy {
  if (typeof value !== 'string' || !FAILURE_POLICIES.has(value as FailurePolicy)) {
    throw new TypeError(`[preeval] ${field} must be one of "ignore", "warn", or "error"`)
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`[preeval] ${field} must be a non-empty string`)
  }
}

function assertFunctionRef(value: unknown, field: string): asserts value is ImportedFunctionRef {
  if (value == null || typeof value !== 'object') {
    throw new TypeError(`[preeval] ${field} must be an object`)
  }
  const ref = value as Record<string, unknown>
  assertNonEmptyString(ref.from, `${field}.from`)
  assertNonEmptyString(ref.import, `${field}.import`)
}

function validateOptions(options: Options): void {
  const rawOptions = options as unknown as Record<string, unknown>
  if ('strict' in rawOptions) {
    throw new TypeError('[preeval] strict was removed; use onFailure: "error" instead')
  }
  if ('imports' in rawOptions) {
    throw new TypeError('[preeval] imports was removed; use rules instead')
  }
  if (options.onFailure !== undefined) {
    assertFailurePolicy(options.onFailure, 'onFailure')
  }
  if (options.rules === undefined) return
  if (!Array.isArray(options.rules)) {
    throw new TypeError('[preeval] rules must be an array')
  }

  const seen = new Set<string>()
  for (const [index, rule] of options.rules.entries()) {
    if (rule == null || typeof rule !== 'object') {
      throw new TypeError(`[preeval] rules[${index}] must be an object`)
    }
    const rawRule = rule as unknown as Record<string, unknown>
    if ('substitute' in rawRule) {
      throw new TypeError(
        `[preeval] rules[${index}].substitute was removed; use evaluate and materialize`,
      )
    }
    assertFunctionRef(rawRule.match, `rules[${index}].match`)
    if (rawRule.evaluate !== undefined) {
      assertFunctionRef(rawRule.evaluate, `rules[${index}].evaluate`)
    }
    if (rawRule.materialize !== undefined) {
      assertFunctionRef(rawRule.materialize, `rules[${index}].materialize`)
    }
    if (rawRule.onFailure !== undefined) {
      assertFailurePolicy(rawRule.onFailure, `rules[${index}].onFailure`)
    }

    const key = `${rawRule.match.from}\0${rawRule.match.import}`
    if (seen.has(key)) {
      throw new TypeError(
        `[preeval] duplicate imported function rule for ${rawRule.match.from}#${rawRule.match.import}`,
      )
    }
    seen.add(key)
  }
}

export const unpluginFactory: UnpluginFactory<Options | undefined> = (options = {}) => {
  validateOptions(options)
  return {
    name: '@codehz/preeval',
    enforce: 'pre',
    transform: {
      filter: {
        id: {
          include: options.include ?? DEFAULT_INCLUDE,
          exclude: options.exclude ?? DEFAULT_EXCLUDE,
        },
        ...(options.rules?.length ? {} : { code: { include: MARKER } }),
      },
      async handler(code, id): Promise<TransformResult> {
        const result = await transformPreeval(code, id, options, this)
        if (!result) return null
        return { code: result.code, map: result.map as PreevalSourceMap }
      },
    },
  }
}

export const preeval = createUnplugin<Options | undefined>(unpluginFactory)

export default preeval
