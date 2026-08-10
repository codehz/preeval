import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { transformPreeval, type TransformContext } from '../src/core/transform'

interface SourceMap {
  sources: string[]
  sourcesContent: string[]
}

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Create a unique temp dir (removed by afterEach) and return its path. */
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'preeval-test-'))
  dirs.push(dir)
  return dir
}

/** Stub TransformContext that records every warn/error call. */
function makeCtx(): { ctx: TransformContext; warns: string[] } {
  const warns: string[] = []
  const ctx: TransformContext = {
    warn: (m) => warns.push(m),
    error: (m) => warns.push('ERR:' + m),
  }
  return { ctx, warns }
}

describe('transformPreeval', () => {
  it('replaces a simple initializer with its JSON value (export const)', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `// @preeval
export const answer = 40 + 2
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(code, entry, {}, ctx)

    expect(res).not.toBeNull()
    expect(res!.code).toContain('export const answer = 42')
    expect(res!.code).not.toContain('40 + 2')
    expect(warns).toEqual([])
  })

  it('replaces the initializer for const + export list', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `// @preeval
const answer = 40 + 2
export { answer }
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(code, entry, {}, ctx)

    expect(res).not.toBeNull()
    expect(res!.code).toContain('const answer = 42')
    expect(res!.code).toContain('export { answer }')
    expect(warns).toEqual([])
  })

  it('replaces every marked initializer after a single eval', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `// @preeval
export const a = 1 + 1
// @preeval
export const b = 2 * 3
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(code, entry, {}, ctx)

    expect(res).not.toBeNull()
    expect(res!.code).toContain('export const a = 2')
    expect(res!.code).toContain('export const b = 6')
    expect(res!.code).not.toContain('1 + 1')
    expect(res!.code).not.toContain('2 * 3')
    expect(warns).toEqual([])
  })

  it('resolves relative imports from the evaluated file', async () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'helper.js'), 'export const base = 40\n')
    const entry = join(dir, 'entry.js')
    const code = `import { base } from './helper.js'
// @preeval
export const answer = base + 2
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(code, entry, {}, ctx)

    expect(res).not.toBeNull()
    expect(res!.code).toContain('export const answer = 42')
    expect(warns).toEqual([])
  })

  it('warn policy: non-JSON value warns and skips the binding', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `// @preeval
export const bad = new Date(0)
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(code, entry, {}, ctx)

    expect(res).toBeNull()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/not JSON-superset/)
  })

  it('warn policy: skips the failing binding but keeps replacing others', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `// @preeval
export const good = 1 + 1
// @preeval
export const bad = undefined
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(code, entry, {}, ctx)

    expect(res).not.toBeNull()
    expect(res!.code).toContain('export const good = 2')
    expect(res!.code).toContain('export const bad = undefined')
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/not JSON-superset/)
  })

  it('error policy: non-JSON value errors and throws', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `// @preeval
export const bad = new Date(0)
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    await expect(transformPreeval(code, entry, { onFailure: 'error' }, ctx)).rejects.toThrow(
      /not JSON-superset/,
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/^ERR:/)
  })

  it('warn policy: module eval failure warns and returns null', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `// @preeval
export const x = (() => { throw new Error('boom') })()
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(code, entry, {}, ctx)

    expect(res).toBeNull()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/Failed to evaluate/)
    expect(warns[0]).toContain('boom')
  })

  it('error policy: module eval failure errors and throws', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `// @preeval
export const x = (() => { throw new Error('boom') })()
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    await expect(transformPreeval(code, entry, { onFailure: 'error' }, ctx)).rejects.toThrow(
      /Failed to evaluate/,
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/^ERR:/)
  })

  it('returns null when there are no marks', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `export const x = 1 + 1
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(code, entry, {}, ctx)

    expect(res).toBeNull()
    expect(warns).toEqual([])
  })

  it('returns a sourcemap with sourcesContent when transformed', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `// @preeval
export const answer = 1 + 1
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(code, entry, {}, ctx)

    expect(res).not.toBeNull()
    const map = res!.map as SourceMap
    expect(map.sources).toEqual([entry])
    expect(map.sourcesContent).toEqual([code])
    expect(warns).toEqual([])
  })

  it('replaces a non-exported marked const', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `// @preeval
const local = 40 + 2
export const answer = local
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(code, entry, {}, ctx)

    expect(res).not.toBeNull()
    expect(res!.code).toContain('const local = 42')
    expect(res!.code).toContain('export const answer = local')
    expect(warns).toEqual([])
  })

  it('does not execute unrelated top-level throws outside the closure', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `throw new Error('must not execute')

const base = 40

// @preeval
const local = base + 2

export const answer = local
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(code, entry, {}, ctx)

    expect(res).not.toBeNull()
    expect(res!.code).toContain('const local = 42')
    expect(res!.code).toContain("throw new Error('must not execute')")
    expect(warns).toEqual([])
  })

  it('warn policy: analysis failure warns and returns null', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `let base = 40
// @preeval
const answer = base + 2
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(code, entry, {}, ctx)

    expect(res).toBeNull()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/let/)
  })

  it('error policy: analysis failure errors and throws', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `let base = 40
// @preeval
const answer = base + 2
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    await expect(transformPreeval(code, entry, { onFailure: 'error' }, ctx)).rejects.toThrow(/let/)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/^ERR:/)
  })

  it('evaluates through local const and function deps', async () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'helper.js'), 'export const base = 40\n')
    const entry = join(dir, 'entry.js')
    const code = `import { base } from './helper.js'
function addTwo(n) { return n + 2 }
const mid = addTwo(base)
// @preeval
const answer = mid
export { answer }
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(code, entry, {}, ctx)

    expect(res).not.toBeNull()
    expect(res!.code).toContain('const answer = 42')
    expect(warns).toEqual([])
  })

  it('warn policy: side-effect import before target warns and skips module', async () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'helper.js'), 'export const base = 1\n')
    writeFileSync(join(dir, 'mutate.js'), 'import { base as b } from "./helper.js"; void b\n')
    const entry = join(dir, 'entry.js')
    const code = `import { base } from './helper.js'
import './mutate.js'
// @preeval
const answer = base
export { answer }
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(code, entry, {}, ctx)

    expect(res).toBeNull()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/side-effect import/)
  })

  it('error policy: side-effect import before target errors and throws', async () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'helper.js'), 'export const base = 1\n')
    writeFileSync(join(dir, 'mutate.js'), 'export {}\n')
    const entry = join(dir, 'entry.js')
    const code = `import { base } from './helper.js'
import './mutate.js'
// @preeval
const answer = base
export { answer }
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    await expect(transformPreeval(code, entry, { onFailure: 'error' }, ctx)).rejects.toThrow(
      /side-effect import/,
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/^ERR:/)
  })

  it('allows never-called hoisted readers of the closure', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `const obj = { n: 1 }
function debug() { console.log(obj) }
// @preeval
const answer = obj.n
export { answer }
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(code, entry, {}, ctx)

    expect(res).not.toBeNull()
    expect(res!.code).toContain('const answer = 1')
    expect(warns).toEqual([])
  })

  it('warn policy: reachable hoisted post-target mutator warns and skips module', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `const obj = { n: 1 }
bump()
// @preeval
const answer = obj.n
export { answer }
function bump() { obj.n = 2 }
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(code, entry, {}, ctx)

    expect(res).toBeNull()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/hoisted declaration|closure binding/)
  })

  it('error policy: reachable hoisted post-target mutator errors and throws', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `const obj = { n: 1 }
bump()
// @preeval
const answer = obj.n
export { answer }
function bump() { obj.n = 2 }
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    await expect(transformPreeval(code, entry, { onFailure: 'error' }, ctx)).rejects.toThrow(
      /hoisted declaration|closure binding/,
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/^ERR:/)
  })

  it('multi-mark: allows harmless statements that only touch earlier deps', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `const obj = { n: 1 }
// @preeval
const a = obj.n
console.log(obj)
// @preeval
const b = 2
export { a, b }
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(code, entry, {}, ctx)

    expect(res).not.toBeNull()
    expect(res!.code).toContain('const a = 1')
    expect(res!.code).toContain('const b = 2')
    expect(res!.code).toContain('console.log(obj)')
    expect(warns).toEqual([])
  })

  it('evaluates through export default function dependencies', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `export default function helper() { return 40 }
// @preeval
const answer = helper() + 2
export { answer }
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(code, entry, {}, ctx)

    expect(res).not.toBeNull()
    expect(res!.code).toContain('const answer = 42')
    expect(warns).toEqual([])
  })

  it('warn policy: import.meta in target warns and skips module', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `// @preeval
const answer = import.meta.url
export { answer }
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(code, entry, {}, ctx)

    expect(res).toBeNull()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/import\.meta/)
  })

  it('error policy: import.meta in target errors and throws', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `// @preeval
const answer = import.meta.url
export { answer }
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    await expect(transformPreeval(code, entry, { onFailure: 'error' }, ctx)).rejects.toThrow(
      /import\.meta/,
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/^ERR:/)
  })
})

describe('automatic imported calls', () => {
  const rulesFor = (from: string) => [
    { match: { from, import: 'default' } },
    { match: { from, import: 'named' } },
  ]

  it('matches named/default aliases and namespace static properties', async () => {
    const dir = tmpDir()
    writeFileSync(
      join(dir, 'helper.js'),
      `export default (x) => 'd' + x\nexport const named = (x) => 'n' + x\n`,
    )
    const entry = join(dir, 'entry.js')
    const code = `import def from './helper.js'
import { named, named as alias } from './helper.js'
import * as ns from './helper.js'
export const values = [def(1), named(2), alias(3), ns.named(4), ns['named'](5)]
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(code, entry, { rules: rulesFor('./helper.js') }, ctx)

    expect(res).not.toBeNull()
    expect(res!.code).toContain(`export const values = ["d1", "n2", "n3", "n4", "n5"]`)
    expect(res!.code).not.toContain("from './helper.js'")
    expect(warns).toEqual([])
  })

  it('matches relative rule.from via host resolve identity', async () => {
    const dir = tmpDir()
    const nested = join(dir, 'nested')
    writeFileSync(join(dir, 'helper.js'), `export const named = (x) => x * 2\n`)
    mkdirSync(nested)
    const entry = join(nested, 'entry.js')
    const code = `import { named } from '../helper.js'\nexport const value = named(21)\n`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()
    ctx.resolve = async (source) => {
      if (source === './helper.js' || source === '../helper.js') {
        return join(dir, 'helper.js')
      }
      return null
    }

    const res = await transformPreeval(
      code,
      entry,
      { root: dir, rules: [{ match: { from: './helper.js', import: 'named' } }] },
      ctx,
    )

    expect(res).not.toBeNull()
    expect(res!.code).toContain('export const value = 42')
    expect(res!.code).not.toContain('named(21)')
    expect(warns).toEqual([])
  })

  it('does not follow local aliases and preserves their import', async () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'helper.js'), `export const named = (x) => x + 1\n`)
    const entry = join(dir, 'entry.js')
    const code = `import { named } from './helper.js'
export const direct = named(1)
const local = named
export const indirect = local(2)
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      { rules: [{ match: { from: './helper.js', import: 'named' } }] },
      ctx,
    )

    expect(res!.code).toContain('export const direct = 2')
    expect(res!.code).toContain('export const indirect = local(2)')
    expect(res!.code).toContain("import { named } from './helper.js'")
    expect(warns).toEqual([])
  })

  it('evaluates calls in arbitrary scopes but rejects function-local arguments', async () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'helper.js'), `export const named = (x) => x + 2\n`)
    const entry = join(dir, 'entry.js')
    const code = `import { named } from './helper.js'
const base = 40
export function value(input) {
  if (false) return named(base)
  return named(input)
}
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      { rules: [{ match: { from: './helper.js', import: 'named' } }] },
      ctx,
    )

    expect(res!.code).toContain('if (false) return 42')
    expect(res!.code).toContain('return named(input)')
    expect(res!.code).toContain("import { named } from './helper.js'")
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/function-local binding "input"/)
  })

  it('allows bindings declared inside callback arguments', async () => {
    const dir = tmpDir()
    writeFileSync(
      join(dir, 'helper.js'),
      `export const invoke = (callback, input) => callback(input)\n`,
    )
    const entry = join(dir, 'entry.js')
    const code = `import { invoke } from './helper.js'
const moduleStep = 2
export const values = [
  invoke((input) => input + 1, 2),
  invoke((input) => input + moduleStep, 2),
  invoke(function twice(input) {
    const delta = 1
    return input === 0 ? 0 : delta + twice(input - 1)
  }, 2),
  invoke(({ value = 0 }) => value + 1, {}),
  invoke(() => {
    try {
      throw 5
    } catch (error) {
      return error
    }
  }, null),
]
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      { rules: [{ match: { from: './helper.js', import: 'invoke' } }] },
      ctx,
    )

    expect(res).not.toBeNull()
    expect(res!.code).toMatch(/export const values = \[\s*3,\s*4,\s*2,\s*1,\s*5,?\s*\]/)
    expect(res!.code).not.toContain("from './helper.js'")
    expect(warns).toEqual([])
  })

  it('rejects callback captures declared outside the call argument', async () => {
    const dir = tmpDir()
    writeFileSync(
      join(dir, 'helper.js'),
      `export const invoke = (callback, input) => callback(input)\n`,
    )
    const entry = join(dir, 'entry.js')
    const code = `import { invoke } from './helper.js'
export function fromFunction() {
  const step = 1
  return invoke((input) => input + step, 2)
}
if (true) {
  const step = 2
  console.log(invoke((input) => input + step, 2))
}
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      { rules: [{ match: { from: './helper.js', import: 'invoke' } }] },
      ctx,
    )

    expect(res).toBeNull()
    expect(warns).toHaveLength(2)
    expect(warns.every((warning) => /function-local binding "step"/.test(warning))).toBe(true)
  })

  it('rejects special context dependencies inside callback arguments', async () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'helper.js'), `export const invoke = (callback) => callback()\n`)
    const entry = join(dir, 'entry.js')
    const code = `import { invoke } from './helper.js'
export function contexts() {
  invoke(() => this)
  invoke(() => arguments[0])
  invoke(function () { return new.target })
  invoke(() => import.meta.url)
}
class Base { value = 1 }
class Child extends Base {
  read() { return invoke(() => super.value) }
}
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      { rules: [{ match: { from: './helper.js', import: 'invoke' } }] },
      ctx,
    )

    expect(res).toBeNull()
    expect(warns).toHaveLength(5)
    expect(warns.join('\n')).toMatch(/depend on this/)
    expect(warns.join('\n')).toMatch(/depend on arguments/)
    expect(warns.join('\n')).toMatch(/new\.target/)
    expect(warns.join('\n')).toMatch(/import\.meta/)
    expect(warns.join('\n')).toMatch(/depend on super/)
  })

  it('recursively extracts stable module-level dependencies', async () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'helper.js'), `export const named = (x) => x\n`)
    const entry = join(dir, 'entry.js')
    const code = `import { named } from './helper.js'
const base = 40
function addTwo(value) { return value + 2 }
const derived = addTwo(base)
export const value = named(derived)
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      { rules: [{ match: { from: './helper.js', import: 'named' } }] },
      ctx,
    )

    expect(res!.code).toContain('export const value = 42')
    expect(res!.code).not.toContain("from './helper.js'")
    expect(warns).toEqual([])
  })

  it('rejects let, this, arguments, super, and new.target dependencies', async () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'helper.js'), `export const named = (x) => x\n`)
    const entry = join(dir, 'entry.js')
    const code = `import { named } from './helper.js'
let mutable = 1
export const a = named(mutable)
export function fromThis() { return named(this) }
export function fromArguments() { return named(arguments[0]) }
export function fromNewTarget() { return named(new.target) }
class Base { value = 1 }
class Child extends Base { read() { return named(super.value) } }
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      { rules: [{ match: { from: './helper.js', import: 'named' } }] },
      ctx,
    )

    expect(res).toBeNull()
    expect(warns).toHaveLength(5)
    expect(warns.join('\n')).toMatch(/declared with let/)
    expect(warns.join('\n')).toMatch(/depend on this/)
    expect(warns.join('\n')).toMatch(/depend on arguments/)
    expect(warns.join('\n')).toMatch(/depend on super/)
    expect(warns.join('\n')).toMatch(/new\.target/)
  })

  it('uses alternate evaluators only in the temporary evaluation module', async () => {
    const dir = tmpDir()
    writeFileSync(
      join(dir, 'runtime.js'),
      `throw new Error('runtime module initialized')\nexport const compile = () => 0\n`,
    )
    writeFileSync(join(dir, 'pure.js'), `export const compilePure = (x) => ({ value: x })\n`)
    const entry = join(dir, 'entry.js')
    const code = `import { compile } from './runtime.js'
export const output = compile('ok')
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      {
        rules: [
          {
            match: { from: './runtime.js', import: 'compile' },
            evaluate: { from: './pure.js', import: 'compilePure' },
          },
        ],
      },
      ctx,
    )

    expect(res!.code).toContain('export const output = {"value":"ok"}')
    expect(res!.code).not.toContain('runtime.js')
    expect(res!.code).not.toContain('pure.js')
    expect(warns).toEqual([])
  })

  it('rejects Promise results without awaiting them', async () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'helper.js'), `export const named = async () => 42\n`)
    const entry = join(dir, 'entry.js')
    const code = `import { named } from './helper.js'
export const output = named()
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      { rules: [{ match: { from: './helper.js', import: 'named' } }] },
      ctx,
    )

    expect(res).toBeNull()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/Promise\/thenable/)
  })

  it('isolates call and serialization failures', async () => {
    const dir = tmpDir()
    writeFileSync(
      join(dir, 'helper.js'),
      `export const good = () => 42\nexport const boom = () => { throw new Error('boom') }\nexport const bad = () => undefined\n`,
    )
    const entry = join(dir, 'entry.js')
    const code = `import { good, boom, bad } from './helper.js'
export const values = [good(), boom(), bad()]
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      {
        rules: ['good', 'boom', 'bad'].map((name) => ({
          match: { from: './helper.js', import: name },
        })),
      },
      ctx,
    )

    expect(res!.code).toContain('export const values = [42, boom(), bad()]')
    expect(res!.code).toContain('boom')
    expect(res!.code).toContain('bad')
    expect(res!.code).not.toMatch(/import \{[^}]*good/)
    expect(warns).toHaveLength(2)
    expect(warns[0]).toContain('boom')
    expect(warns[1]).toContain('not JSON-superset')
  })

  it('applies global and per-rule failure policies', async () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'helper.js'), `export const boom = () => { throw new Error('boom') }\n`)
    const entry = join(dir, 'entry.js')
    const code = `import { boom } from './helper.js'\nexport const value = boom()\n`
    writeFileSync(entry, code)

    const ignored = makeCtx()
    expect(
      await transformPreeval(
        code,
        entry,
        { onFailure: 'ignore', rules: [{ match: { from: './helper.js', import: 'boom' } }] },
        ignored.ctx,
      ),
    ).toBeNull()
    expect(ignored.warns).toEqual([])

    const overridden = makeCtx()
    expect(
      await transformPreeval(
        code,
        entry,
        {
          onFailure: 'ignore',
          rules: [{ match: { from: './helper.js', import: 'boom' }, onFailure: 'warn' }],
        },
        overridden.ctx,
      ),
    ).toBeNull()
    expect(overridden.warns).toHaveLength(1)

    const errored = makeCtx()
    await expect(
      transformPreeval(
        code,
        entry,
        { onFailure: 'error', rules: [{ match: { from: './helper.js', import: 'boom' } }] },
        errored.ctx,
      ),
    ).rejects.toThrow(/boom/)
    expect(errored.warns[0]).toMatch(/^ERR:/)
  })

  it('preserves failed calls without injecting materializer imports', async () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'runtime-api.js'), `export const boom = () => 'runtime fallback'\n`)
    writeFileSync(join(dir, 'pure.js'), `export const boom = () => { throw new Error('boom') }\n`)
    writeFileSync(
      join(dir, 'materialize.js'),
      `throw new Error('materializer loaded during build')\nexport const revive = (value) => value\n`,
    )
    const entry = join(dir, 'entry.js')
    const code = `import { boom } from './runtime-api.js'
export const failed = boom()
// @preeval
export const independent = 1 + 1
`
    writeFileSync(entry, code)
    const rule = {
      match: { from: './runtime-api.js', import: 'boom' },
      evaluate: { from: './pure.js', import: 'boom' },
      materialize: { from: './materialize.js', import: 'revive' },
    }

    const ignored = makeCtx()
    const ignoredResult = await transformPreeval(
      code,
      entry,
      { onFailure: 'ignore', rules: [rule] },
      ignored.ctx,
    )
    expect(ignoredResult!.code).toContain('export const failed = boom()')
    expect(ignoredResult!.code).toContain('export const independent = 2')
    expect(ignoredResult!.code).not.toContain('materialize.js')
    expect(ignored.warns).toEqual([])

    const warned = makeCtx()
    const warnedResult = await transformPreeval(
      code,
      entry,
      { onFailure: 'warn', rules: [rule] },
      warned.ctx,
    )
    expect(warnedResult!.code).not.toContain('materialize.js')
    expect(warned.warns).toHaveLength(1)

    const errored = makeCtx()
    await expect(
      transformPreeval(code, entry, { onFailure: 'error', rules: [rule] }, errored.ctx),
    ).rejects.toThrow(/boom/)
    expect(errored.warns[0]).toMatch(/^ERR:/)
  })

  it('evaluates nested automatic calls once in JavaScript order', async () => {
    const dir = tmpDir()
    writeFileSync(
      join(dir, 'helper.js'),
      `let count = 0\nexport const inner = () => ++count\nexport const outer = (x) => x * 10 + ++count\n`,
    )
    const entry = join(dir, 'entry.js')
    const code = `import { inner, outer } from './helper.js'\nexport const value = outer(inner())\n`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      {
        rules: [
          { match: { from: './helper.js', import: 'inner' } },
          { match: { from: './helper.js', import: 'outer' } },
        ],
      },
      ctx,
    )

    expect(res!.code).toContain('export const value = 12')
    expect(res!.code).not.toContain('helper.js')
    expect(warns).toEqual([])
  })

  it('treats materialized results as transitive runtime boundaries', async () => {
    const dir = tmpDir()
    writeFileSync(
      join(dir, 'runtime-api.js'),
      `export const inner = (entries) => new Map(entries)\nexport const outer = (value) => ({ size: value.size })\n`,
    )
    writeFileSync(
      join(dir, 'pure.js'),
      `export const evaluateInner = (entries) => ({ entries })\nexport const evaluateOuter = (value) => ({ size: value.entries.length })\n`,
    )
    writeFileSync(
      join(dir, 'materialize.js'),
      `globalThis.__preevalMaterializerLoaded = true\nexport const revive = (payload) => new Map(payload.entries)\n`,
    )
    const entry = join(dir, 'entry.js')
    const code = `import { inner, outer } from './runtime-api.js'
const sizeOf = (value) => value.size
const transitive = inner([['b', 2]])
// @preeval
export const blocked = sizeOf(transitive)
// @preeval
export const unrelated = 40 + 2
export const via = outer(transitive)
export const direct = outer(inner([['a', 1]]))
`
    writeFileSync(entry, code)
    delete (globalThis as Record<string, unknown>).__preevalMaterializerLoaded
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      {
        rules: [
          {
            match: { from: './runtime-api.js', import: 'inner' },
            evaluate: { from: './pure.js', import: 'evaluateInner' },
            materialize: { from: './materialize.js', import: 'revive' },
          },
          {
            match: { from: './runtime-api.js', import: 'outer' },
            evaluate: { from: './pure.js', import: 'evaluateOuter' },
          },
        ],
      },
      ctx,
    )

    expect((globalThis as Record<string, unknown>).__preevalMaterializerLoaded).toBeUndefined()
    expect(res!.code.match(/from "\.\/materialize\.js"/g)).toHaveLength(1)
    expect(res!.code).toContain('const transitive = __preeval_materialize({"entries":[["b",2]]})')
    expect(res!.code).toContain('export const via = outer(transitive)')
    expect(res!.code).toContain(
      'export const direct = outer(__preeval_materialize({"entries":[["a",1]]}))',
    )
    expect(res!.code).toContain('export const blocked = sizeOf(transitive)')
    expect(res!.code).toContain('export const unrelated = 42')
    expect(warns).toHaveLength(3)
    expect(warns.every((warning) => warning.includes('runtime materializer boundary'))).toBe(true)
  })

  it('emits deduplicated hygienic default, named, and string materializers', async () => {
    const dir = tmpDir()
    writeFileSync(
      join(dir, 'runtime-api.js'),
      `export const d = (value) => ['default', value]\nexport const n = (value) => ['named', value]\nexport const s = (value) => ['string', value]\n`,
    )
    writeFileSync(
      join(dir, 'pure.js'),
      `export const d = (value) => value\nexport const n = (value) => value\nexport const s = (value) => value\n`,
    )
    writeFileSync(
      join(dir, 'materialize.js'),
      `globalThis.__preevalMaterializeLoads = (globalThis.__preevalMaterializeLoads ?? 0) + 1
const record = (kind, value) => {
  globalThis.__preevalMaterializeCalls = [...(globalThis.__preevalMaterializeCalls ?? []), kind]
  return [kind, value]
}
export default (value) => record('default', value)
export const named = (value) => record('named', value)
const dashed = (value) => record('string', value)
export { dashed as 'with-dash' }
`,
    )
    const entry = join(dir, 'entry.js')
    const code = `#!/usr/bin/env node
import { d, n, s } from './runtime-api.js'
export function shadow(__preeval_materialize) { return __preeval_materialize }
export const values = [d(1), n(2), n(3), s(4)]
`
    writeFileSync(entry, code)
    delete (globalThis as Record<string, unknown>).__preevalMaterializeLoads
    delete (globalThis as Record<string, unknown>).__preevalMaterializeCalls
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      {
        rules: [
          {
            match: { from: './runtime-api.js', import: 'd' },
            evaluate: { from: './pure.js', import: 'd' },
            materialize: { from: './materialize.js', import: 'default' },
          },
          {
            match: { from: './runtime-api.js', import: 'n' },
            evaluate: { from: './pure.js', import: 'n' },
            materialize: { from: './materialize.js', import: 'named' },
          },
          {
            match: { from: './runtime-api.js', import: 's' },
            evaluate: { from: './pure.js', import: 's' },
            materialize: { from: './materialize.js', import: 'with-dash' },
          },
        ],
      },
      ctx,
    )

    expect((globalThis as Record<string, unknown>).__preevalMaterializeLoads).toBeUndefined()
    expect(res!.code).toMatch(/^#!\/usr\/bin\/env node\nimport/)
    expect(res!.code).toContain('import __preeval_materialize_1 from "./materialize.js";')
    expect(res!.code).toContain(
      'import { named as __preeval_materialize_2 } from "./materialize.js";',
    )
    expect(res!.code).toContain(
      'import { "with-dash" as __preeval_materialize_3 } from "./materialize.js";',
    )
    expect(res!.code.match(/named as __preeval_materialize_2/g)).toHaveLength(1)
    expect(res!.code).not.toContain("from './runtime-api.js'")
    expect(warns).toEqual([])

    const output = join(dir, 'output.mjs')
    writeFileSync(output, res!.code)
    // Dynamic import intentionally executes the generated runtime artifact.
    const evaluated = await import(`${output}?case=materializer-imports`)
    expect(evaluated.values).toEqual([
      ['default', 1],
      ['named', 2],
      ['named', 3],
      ['string', 4],
    ])
    expect((globalThis as Record<string, unknown>).__preevalMaterializeLoads).toBe(1)
    expect((globalThis as Record<string, unknown>).__preevalMaterializeCalls).toEqual([
      'default',
      'named',
      'named',
      'string',
    ])
  })

  it('lets a successful marked initializer override nested call edits', async () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'helper.js'), `export const named = (x) => x + 1\n`)
    const entry = join(dir, 'entry.js')
    const code = `import { named } from './helper.js'
const wrap = (x) => x * 2
// @preeval
export const value = wrap(named(1))
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      { rules: [{ match: { from: './helper.js', import: 'named' } }] },
      ctx,
    )

    expect(res!.code).toContain('export const value = 4')
    expect(res!.code).not.toContain('helper.js')
    expect(warns).toEqual([])
  })

  it('skips a marked initializer when its automatic call fails', async () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'helper.js'), `export const boom = () => { throw new Error('boom') }\n`)
    const entry = join(dir, 'entry.js')
    const code = `import { boom } from './helper.js'
const wrap = (x) => x
// @preeval
export const value = wrap(boom())
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      { rules: [{ match: { from: './helper.js', import: 'boom' } }] },
      ctx,
    )

    expect(res).toBeNull()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('boom')
  })

  it('preserves namespace imports with remaining runtime references', async () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'helper.js'), `export const named = () => 1\nexport const other = 2\n`)
    const entry = join(dir, 'entry.js')
    const code = `import * as ns from './helper.js'
export const value = ns.named()
console.log(ns.other)
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      { rules: [{ match: { from: './helper.js', import: 'named' } }] },
      ctx,
    )

    expect(res!.code).toContain('export const value = 1')
    expect(res!.code).toContain("import * as ns from './helper.js'")
    expect(warns).toEqual([])
  })

  it('ignores type-only references during runtime import cleanup', async () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'helper.js'), `export const named = () => 1\n`)
    const entry = join(dir, 'entry.ts')
    const code = `import { named } from './helper.js'
type Named = typeof named
export const value = named()
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      { rules: [{ match: { from: './helper.js', import: 'named' } }] },
      ctx,
    )

    expect(res!.code).toContain('type Named = typeof named')
    expect(res!.code).not.toContain("from './helper.js'")
    expect(res!.code).toContain('export const value = 1')
    expect(warns).toEqual([])
  })

  it('evaluates tagged templates for imported tags', async () => {
    const dir = tmpDir()
    writeFileSync(
      join(dir, 'helper.js'),
      `export default (strings, ...values) => strings[0] + values.join('') + (strings[1] ?? '')
export const named = (strings, ...values) => ['N', ...values, strings.join('|')].join(':')
`,
    )
    const entry = join(dir, 'entry.js')
    const code = `import def from './helper.js'
import { named, named as alias } from './helper.js'
import * as ns from './helper.js'
const x = 1
export const values = [def\`a\${x}b\`, named\`c\${x}\`, alias\`d\${x}\`, ns.named\`e\${x}\`, ns['named']\`f\${x}\`]
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(code, entry, { rules: rulesFor('./helper.js') }, ctx)

    expect(res).not.toBeNull()
    expect(res!.code).toContain(
      'export const values = ["a1b", "N:1:c|", "N:1:d|", "N:1:e|", "N:1:f|"]',
    )
    expect(res!.code).not.toContain("from './helper.js'")
    expect(warns).toEqual([])
  })

  it('uses alternate evaluators for tagged templates only at eval time', async () => {
    const dir = tmpDir()
    writeFileSync(
      join(dir, 'runtime.js'),
      `throw new Error('runtime module initialized')\nexport const tag = () => 0\n`,
    )
    writeFileSync(
      join(dir, 'pure.js'),
      `export const tagPure = (strings, value) => ({ text: strings[0] + value + strings[1] })\n`,
    )
    const entry = join(dir, 'entry.js')
    const code = `import { tag } from './runtime.js'
export const output = tag\`ok-\${'x'}\`
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      {
        rules: [
          {
            match: { from: './runtime.js', import: 'tag' },
            evaluate: { from: './pure.js', import: 'tagPure' },
          },
        ],
      },
      ctx,
    )

    expect(res!.code).toContain('export const output = {"text":"ok-x"}')
    expect(res!.code).not.toContain('runtime.js')
    expect(res!.code).not.toContain('pure.js')
    expect(warns).toEqual([])
  })

  it('materializes tagged-template payloads at runtime', async () => {
    const dir = tmpDir()
    writeFileSync(
      join(dir, 'runtime.js'),
      `export const tag = (strings, value) => new Map([[strings[0], value]])\n`,
    )
    writeFileSync(
      join(dir, 'pure.js'),
      `export const tag = (strings, value) => ({ entries: [[strings[0], value]] })\n`,
    )
    writeFileSync(
      join(dir, 'materialize.js'),
      `export const revive = (payload) => new Map(payload.entries)\n`,
    )
    const entry = join(dir, 'entry.js')
    const code = `import { tag } from './runtime.js'
export const output = tag\`key-\${2}\`
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      {
        rules: [
          {
            match: { from: './runtime.js', import: 'tag' },
            evaluate: { from: './pure.js', import: 'tag' },
            materialize: { from: './materialize.js', import: 'revive' },
          },
        ],
      },
      ctx,
    )

    expect(res!.code).toContain(
      'import { revive as __preeval_materialize } from "./materialize.js";',
    )
    expect(res!.code).toContain(
      'export const output = __preeval_materialize({"entries":[["key-",2]]})',
    )
    expect(res!.code).not.toContain('runtime.js')
    expect(warns).toEqual([])
  })

  it('rejects function-local interpolations in tagged templates', async () => {
    const dir = tmpDir()
    writeFileSync(
      join(dir, 'helper.js'),
      `export const named = (strings, value) => strings[0] + value + strings[1]\n`,
    )
    const entry = join(dir, 'entry.js')
    const code = `import { named } from './helper.js'
const base = 'ok'
export function value(input) {
  return named\`\${base}-\${input}\`
}
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      { rules: [{ match: { from: './helper.js', import: 'named' } }] },
      ctx,
    )

    expect(res).toBeNull()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/function-local binding "input"/)
  })

  it('allows bindings declared inside tagged-template interpolations', async () => {
    const dir = tmpDir()
    writeFileSync(
      join(dir, 'helper.js'),
      `export const named = (strings, value) => strings[0] + value + strings[1]\n`,
    )
    const entry = join(dir, 'entry.js')
    const code = `import { named } from './helper.js'
export const value = named\`result:\${((input) => input + 1)(2)}\`
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      { rules: [{ match: { from: './helper.js', import: 'named' } }] },
      ctx,
    )

    expect(res).not.toBeNull()
    expect(res!.code).toContain('export const value = "result:3"')
    expect(res!.code).not.toContain("from './helper.js'")
    expect(warns).toEqual([])
  })

  it('evaluates nested tagged templates before outer calls', async () => {
    const dir = tmpDir()
    writeFileSync(
      join(dir, 'helper.js'),
      `let count = 0
export const inner = (strings) => ++count + strings[0]
export const outer = (value) => value + ':' + ++count
`,
    )
    const entry = join(dir, 'entry.js')
    const code = `import { inner, outer } from './helper.js'
export const value = outer(inner\`x\`)
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    const res = await transformPreeval(
      code,
      entry,
      {
        rules: [
          { match: { from: './helper.js', import: 'inner' } },
          { match: { from: './helper.js', import: 'outer' } },
        ],
      },
      ctx,
    )

    expect(res!.code).toContain('export const value = "1x:2"')
    expect(res!.code).not.toContain('helper.js')
    expect(warns).toEqual([])
  })
})
