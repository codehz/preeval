import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bindHostResolve,
  createSpecifierMatcher,
  EXACT_SPECIFIER_MATCHER,
  normalizeResolvedId,
  stripModuleIdQuery,
} from '../src/core/resolve'

describe('normalizeResolvedId', () => {
  it('strips query/hash and normalizes absolute paths', () => {
    expect(stripModuleIdQuery('/a/b.js?v=1#c')).toBe('/a/b.js')
    expect(normalizeResolvedId('/proj/src/../src/x.js?raw')).toBe(join('/proj/src', 'x.js'))
  })
})

describe('createSpecifierMatcher', () => {
  it('falls back to exact equality without resolve', async () => {
    const matcher = await createSpecifierMatcher({
      importSources: ['./a.js'],
      ruleFroms: ['./a.js', './b.js'],
      file: '/proj/src/entry.js',
      root: '/proj',
    })
    expect(matcher.matchesSource('./a.js', './a.js')).toBe(true)
    expect(matcher.matchesSource('./a.js', './b.js')).toBe(false)
    expect(matcher).toBe(EXACT_SPECIFIER_MATCHER)
  })

  it('compares host-resolved identities across different spellings', async () => {
    const file = '/proj/src/nested/entry.js'
    const root = '/proj'
    const matcher = await createSpecifierMatcher({
      importSources: ['../macros/compile.js', '@/macros/compile'],
      ruleFroms: ['./src/macros/compile.ts'],
      file,
      root,
      resolve: async (source, importer) => {
        if (source === './src/macros/compile.ts' && importer.startsWith(root)) {
          return '/proj/src/macros/compile.ts'
        }
        if (source === '../macros/compile.js' && importer === file) {
          return '/proj/src/macros/compile.ts'
        }
        if (source === '@/macros/compile') return '/proj/src/macros/compile.ts'
        if (source === './other.js') return '/proj/src/other.js'
        return null
      },
    })

    expect(matcher.matchesSource('../macros/compile.js', './src/macros/compile.ts')).toBe(true)
    expect(matcher.matchesSource('@/macros/compile', './src/macros/compile.ts')).toBe(true)
    expect(matcher.matchesSource('./other.js', './src/macros/compile.ts')).toBe(false)
  })

  it('keeps exact strings when resolve fails', async () => {
    const matcher = await createSpecifierMatcher({
      importSources: ['pkg'],
      ruleFroms: ['pkg'],
      file: '/proj/a.js',
      root: '/proj',
      resolve: async () => null,
    })
    expect(matcher.matchesSource('pkg', 'pkg')).toBe(true)
    expect(matcher.matchesSource('pkg', 'other')).toBe(false)
  })
})

describe('bindHostResolve', () => {
  it('uses rollup-style this.resolve results', async () => {
    const resolve = bindHostResolve({
      resolve: async (source) => ({ id: `/abs/${source}.js` }),
    })
    expect(resolve).toBeTypeOf('function')
    expect(await resolve!('foo', '/proj/entry.js')).toBe('/abs/foo.js')
  })

  it('uses esbuild build.resolve via native context', async () => {
    const resolve = bindHostResolve({
      getNativeBuildContext: () => ({
        framework: 'esbuild',
        build: {
          resolve: async (path) => ({ path: `/es/${path}`, errors: [] }),
        },
      }),
    })
    expect(await resolve!('./x', '/proj/src/a.js')).toBe('/es/./x')
  })

  it('returns undefined when the host cannot resolve', () => {
    expect(bindHostResolve({})).toBeUndefined()
  })
})
