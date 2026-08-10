import { dirname, isAbsolute, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { File } from '@babel/types'
import { parseModule } from './analyze/ast'

/** Host module resolver: source + importer → resolved module id. */
export type ModuleResolve = (source: string, importer: string) => Promise<string | null | undefined>

/** Sync predicate used by automatic-call matching after async resolve warm-up. */
export interface SpecifierMatcher {
  /** Whether an import source should match a rule `match.from` under host resolve. */
  matchesSource(importSource: string, ruleFrom: string): boolean
}

/** Exact source-string equality (no host resolve). */
export const EXACT_SPECIFIER_MATCHER: SpecifierMatcher = {
  matchesSource: (importSource, ruleFrom) => importSource === ruleFrom,
}

/** Strip Vite/Rollup query/hash suffixes from a module id. */
export function stripModuleIdQuery(id: string): string {
  const cut = id.search(/[?#]/)
  return cut === -1 ? id : id.slice(0, cut)
}

/** Normalize a resolved module id for stable identity comparison. */
export function normalizeResolvedId(id: string): string {
  let out = stripModuleIdQuery(id)
  if (out.startsWith('file:')) {
    try {
      out = fileURLToPath(out)
    } catch {
      // keep original when not a valid file URL
    }
  }
  if (isAbsolute(out)) out = normalize(out)
  return out
}

/**
 * Collect runtime import source strings from a module.
 * Type-only imports are ignored.
 */
export function collectModuleImportSources(code: string, filename?: string): string[] {
  const file = parseModule(code, filename)
  if (file == null) return []
  return collectImportSourcesFromAst(file)
}

export function collectImportSourcesFromAst(file: File): string[] {
  const sources = new Set<string>()
  for (const stmt of file.program.body) {
    if (stmt.type !== 'ImportDeclaration') continue
    if (stmt.importKind === 'type') continue
    sources.add(stmt.source.value)
  }
  return [...sources]
}

/**
 * Build a specifier matcher.
 *
 * - With `resolve`: compare host-resolved identities.
 *   Rule `from` is resolved against `root` (project-root relative paths work).
 *   Import sources are resolved against the current file.
 * - Without `resolve`, or when a side fails to resolve: fall back to exact strings
 *   for that side so package-name rules keep working in unit tests / hosts without resolve.
 */
export async function createSpecifierMatcher(options: {
  importSources: readonly string[]
  ruleFroms: readonly string[]
  file: string
  root: string
  resolve?: ModuleResolve
}): Promise<SpecifierMatcher> {
  const { importSources, ruleFroms, file, root, resolve } = options
  if (resolve == null) return EXACT_SPECIFIER_MATCHER

  const ruleImporter = join(root, '__preeval_resolve_entry.js')
  const cache = new Map<string, string>()

  const resolveKey = async (source: string, importer: string): Promise<string> => {
    const cacheKey = `${importer}\0${source}`
    const hit = cache.get(cacheKey)
    if (hit !== undefined) return hit

    let key = source
    try {
      const resolved = await resolve(source, importer)
      if (typeof resolved === 'string' && resolved.length > 0) {
        key = normalizeResolvedId(resolved)
      }
    } catch {
      // keep exact source string
    }
    cache.set(cacheKey, key)
    return key
  }

  await Promise.all([
    ...ruleFroms.map((from) => resolveKey(from, ruleImporter)),
    ...importSources.map((source) => resolveKey(source, file)),
  ])

  return {
    matchesSource(importSource, ruleFrom) {
      const left = cache.get(`${file}\0${importSource}`) ?? importSource
      const right = cache.get(`${ruleImporter}\0${ruleFrom}`) ?? ruleFrom
      return left === right
    },
  }
}

/** Minimal shape shared by unplugin transform `this` across hosts. */
export interface HostResolveContext {
  resolve?: (
    source: string,
    importer?: string,
  ) => Promise<string | { id: string } | null | undefined>
  getNativeBuildContext?: () =>
    | {
        framework: string
        build: {
          resolve?: (
            path: string,
            options?: {
              resolveDir?: string
              kind?: string
              importer?: string
            },
          ) => Promise<{ path: string; errors: unknown[] }>
        }
      }
    | undefined
}

export function bindHostResolve(ctx: HostResolveContext): ModuleResolve | undefined {
  if (typeof ctx.resolve === 'function') {
    const hostResolve = ctx.resolve.bind(ctx)
    return async (source, importer) => {
      const result = await hostResolve(source, importer)
      if (result == null) return null
      if (typeof result === 'string') return result
      if (typeof result === 'object' && typeof result.id === 'string') return result.id
      return null
    }
  }

  const native = ctx.getNativeBuildContext?.()
  if (native?.framework === 'esbuild' && typeof native.build.resolve === 'function') {
    const buildResolve = native.build.resolve.bind(native.build)
    return async (source, importer) => {
      const result = await buildResolve(source, {
        resolveDir: dirname(stripModuleIdQuery(importer)),
        kind: 'import-statement',
        importer,
      })
      if (result.errors?.length) return null
      return result.path || null
    }
  }

  if (native?.framework === 'bun') {
    const bunGlobal = globalThis
    if (
      bunGlobal &&
      typeof bunGlobal === 'object' &&
      'Bun' in bunGlobal &&
      bunGlobal.Bun &&
      typeof bunGlobal.Bun === 'object' &&
      'resolveSync' in bunGlobal.Bun &&
      typeof bunGlobal.Bun.resolveSync === 'function'
    ) {
      const resolveSync = bunGlobal.Bun.resolveSync as (s: string, d: string) => string
      return async (source, importer) => {
        try {
          return resolveSync(source, dirname(stripModuleIdQuery(importer)))
        } catch {
          return null
        }
      }
    }
  }

  return undefined
}
