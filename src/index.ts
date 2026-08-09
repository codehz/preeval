import {
  createUnplugin,
  type TransformResult,
  type UnpluginFactory,
} from 'unplugin'
import type { FailurePolicy, Options } from './types'
import { transformPreeval } from './core/transform'

export type {
  FailurePolicy,
  ImportedFunctionRule,
  ImportedFunctionSubstitute,
  Options,
} from './types'

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
    throw new TypeError(
      `[preeval] ${field} must be one of "ignore", "warn", or "error"`,
    )
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`[preeval] ${field} must be a non-empty string`)
  }
}

function validateOptions(options: Options): void {
  const rawOptions = options as unknown as Record<string, unknown>
  if ('strict' in rawOptions) {
    throw new TypeError(
      '[preeval] strict was removed; use onFailure: "error" instead',
    )
  }
  if (options.onFailure !== undefined) {
    assertFailurePolicy(options.onFailure, 'onFailure')
  }
  if (options.imports === undefined) return
  if (!Array.isArray(options.imports)) {
    throw new TypeError('[preeval] imports must be an array')
  }

  const seen = new Set<string>()
  for (const [index, rule] of options.imports.entries()) {
    if (rule == null || typeof rule !== 'object') {
      throw new TypeError(`[preeval] imports[${index}] must be an object`)
    }
    assertNonEmptyString(rule.from, `imports[${index}].from`)
    assertNonEmptyString(rule.import, `imports[${index}].import`)
    if (rule.onFailure !== undefined) {
      assertFailurePolicy(rule.onFailure, `imports[${index}].onFailure`)
    }
    if (rule.substitute !== undefined) {
      if (rule.substitute == null || typeof rule.substitute !== 'object') {
        throw new TypeError(`[preeval] imports[${index}].substitute must be an object`)
      }
      assertNonEmptyString(rule.substitute.from, `imports[${index}].substitute.from`)
      assertNonEmptyString(rule.substitute.import, `imports[${index}].substitute.import`)
    }

    const key = `${rule.from}\0${rule.import}`
    if (seen.has(key)) {
      throw new TypeError(
        `[preeval] duplicate imported function rule for ${rule.from}#${rule.import}`,
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
        ...(options.imports?.length ? {} : { code: { include: MARKER } }),
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
