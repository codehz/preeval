import {
  createUnplugin,
  type TransformResult,
  type UnpluginFactory,
} from 'unplugin'
import type { Options } from './types'
import { transformPreeval } from './core/transform'

export type { Options } from './types'

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

export const unpluginFactory: UnpluginFactory<Options | undefined> = (options = {}) => {
  return {
    name: '@codehz/preeval',
    enforce: 'pre',
    transform: {
      filter: {
        id: {
          include: options.include ?? DEFAULT_INCLUDE,
          exclude: options.exclude ?? DEFAULT_EXCLUDE,
        },
        code: { include: MARKER },
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
