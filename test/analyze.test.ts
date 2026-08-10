import { describe, expect, it } from 'vitest'
import { analyzePreevalModule, findAutomaticPreevalCalls } from '../src/core/analyze'

/** Resolve the exact init span of `expr` inside `code`. */
function spanOf(code: string, expr: string): { initStart: number; initEnd: number } {
  const start = code.indexOf(expr)
  expect(start).toBeGreaterThanOrEqual(0)
  return { initStart: start, initEnd: start + expr.length }
}

describe('analyzePreevalModule', () => {
  it('detects name/init spans for export const', () => {
    const code = `// @preeval
export const marked = 1 + 2
`
    const plan = analyzePreevalModule(code)
    expect(plan).not.toBeNull()
    expect(plan!.targets).toHaveLength(1)
    const m = plan!.targets[0]!
    expect(m.name).toBe('marked')
    expect(m.evalExportName).toMatch(/^__preeval_\d+$/)
    expect(m.initStart).toBe(spanOf(code, '1 + 2').initStart)
    expect(m.initEnd).toBe(spanOf(code, '1 + 2').initEnd)
    expect(code.slice(m.initStart, m.initEnd)).toBe('1 + 2')
    expect(plan!.code).toContain('const marked = 1 + 2')
    expect(plan!.code).toContain(`export { marked as ${m.evalExportName}`)
  })

  it('detects const + export { name }', () => {
    const code = `// @preeval
const foo = 'hello'
export { foo }
`
    const plan = analyzePreevalModule(code)
    expect(plan).not.toBeNull()
    expect(plan!.targets[0]).toMatchObject({ name: 'foo' })
  })

  it('accepts non-exported marked consts', () => {
    const code = `// @preeval
const x = 1 + 1
`
    const plan = analyzePreevalModule(code)
    expect(plan).not.toBeNull()
    expect(plan!.targets[0]?.name).toBe('x')
  })

  it('allows blank lines between the marker and the declaration', () => {
    const code = `// @preeval


export const x = 1
`
    const plan = analyzePreevalModule(code)
    expect(plan).not.toBeNull()
    expect(plan!.targets[0]?.name).toBe('x')
  })

  it('rejects a block comment marker', () => {
    const code = `/* @preeval */
export const x = 1
`
    expect(analyzePreevalModule(code)).toBeNull()
  })

  it('skips multi-declarator target declarations', () => {
    const code = `// @preeval
export const a = 1, b = 2
`
    expect(analyzePreevalModule(code)).toBeNull()
  })

  it('finds multiple marks in one file with one joint closure', () => {
    const code = `// @preeval
export const a = 1
// @preeval
export const b = 'two'
`
    const plan = analyzePreevalModule(code)
    expect(plan).not.toBeNull()
    expect(plan!.targets.map((m) => m.name)).toEqual(['a', 'b'])
    // single synthetic export list
    expect(plan!.code.match(/export \{/g)?.length ?? 0).toBe(1)
  })

  it('isolates marked targets whose closure crosses a runtime boundary', () => {
    const code = `const materialized = {"entries":[]}
// @preeval
export const blocked = materialized
// @preeval
export const independent = 40 + 2
`
    const boundary = spanOf(code, '{"entries":[]}')

    const plan = analyzePreevalModule(code, undefined, {
      runtimeBoundaries: [{ start: boundary.initStart, end: boundary.initEnd }],
    })

    expect(plan?.targets.map((target) => target.name)).toEqual(['independent'])
    expect(plan?.blockedTargets?.map((target) => target.name)).toEqual(['blocked'])
    expect(plan?.code).toContain('const independent = 40 + 2')
    expect(plan?.code).not.toContain('const blocked')
  })

  it('rejects a marker with trailing text', () => {
    const code = `// @preeval foo
export const x = 1
`
    expect(analyzePreevalModule(code)).toBeNull()
  })

  it('rejects an intervening non-marker comment', () => {
    const code = `// @preeval
// helper comment
export const x = 1
`
    expect(analyzePreevalModule(code)).toBeNull()
  })

  it('accepts type-only export lists (runtime const is still a target)', () => {
    const code = `// @preeval
const X = 1
export type { X }
`
    const plan = analyzePreevalModule(code, 'mod.ts')
    expect(plan).not.toBeNull()
    expect(plan!.targets[0]?.name).toBe('X')
  })

  it('accepts runtime const with type-only export specifier', () => {
    const code = `// @preeval
const X = 1
export { type X }
`
    const plan = analyzePreevalModule(code, 'mod.ts')
    expect(plan).not.toBeNull()
    expect(plan!.targets[0]?.name).toBe('X')
  })

  it('parses angle-bracket assertions in .ts files', () => {
    const code = `// @preeval
export const x = <number>1
`
    const plan = analyzePreevalModule(code, 'mod.ts')
    expect(plan).not.toBeNull()
    expect(plan!.targets[0]?.name).toBe('x')
  })

  it('extracts const → function → import closures and drops unused imports', () => {
    const code = `import { base, unused } from './helper.js'
function addTwo(n) { return n + 2 }
const mid = addTwo(base)
// @preeval
const answer = mid
export { answer }
`
    const plan = analyzePreevalModule(code)
    expect(plan).not.toBeNull()
    expect(plan!.code).toContain("import { base } from './helper.js'")
    expect(plan!.code).not.toContain('unused')
    expect(plan!.code).toContain('function addTwo')
    expect(plan!.code).toContain('const mid')
    expect(plan!.code).toContain('const answer')
  })

  it('does not pull type-only imports into the extracted module', () => {
    const code = `import type { T } from './types.js'
import { base } from './helper.js'
// @preeval
const answer: T = base + 2
`
    const plan = analyzePreevalModule(code, 'mod.ts')
    expect(plan).not.toBeNull()
    expect(plan!.code).not.toContain('types.js')
    expect(plan!.code).toContain("import { base } from './helper.js'")
  })

  it('includes TS enums referenced by a target', () => {
    const code = `enum E { A = 40 }
// @preeval
export const answer = E.A + 2
`
    const plan = analyzePreevalModule(code, 'mod.ts')
    expect(plan).not.toBeNull()
    expect(plan!.code).toContain('enum E')
    expect(plan!.code).toContain('E.A + 2')
  })

  it('rejects let dependencies', () => {
    const code = `let base = 40
// @preeval
const answer = base + 2
`
    expect(() => analyzePreevalModule(code)).toThrow(/let/)
  })

  it('rejects reassigned const dependencies', () => {
    const code = `const base = 40
base = 41
// @preeval
const answer = base + 2
`
    expect(() => analyzePreevalModule(code)).toThrow(/reassign/)
  })

  it('rejects intervening statements that touch the closure', () => {
    const code = `const base = { n: 40 }
base.n = 41
// @preeval
const answer = base.n
`
    expect(() => analyzePreevalModule(code)).toThrow(/closure binding/)
  })

  it('allows unrelated top-level throws outside the closure', () => {
    const code = `throw new Error('must not execute')
const base = 40
// @preeval
const local = base + 2
export const answer = local
`
    const plan = analyzePreevalModule(code)
    expect(plan).not.toBeNull()
    expect(plan!.code).not.toContain('must not execute')
    expect(plan!.code).toContain('const base = 40')
    expect(plan!.code).toContain('const local = base + 2')
  })

  it('rejects side-effect imports before a marked const when the closure imports values', () => {
    const code = `import { base } from './helper.js'
import './mutate.js'
// @preeval
const answer = base
`
    expect(() => analyzePreevalModule(code)).toThrow(/side-effect import/)
  })

  it('allows side-effect imports after every marked const', () => {
    const code = `import { base } from './helper.js'
// @preeval
const answer = base
import './late-side-effect.js'
`
    const plan = analyzePreevalModule(code)
    expect(plan).not.toBeNull()
    expect(plan!.code).toContain("import { base } from './helper.js'")
    expect(plan!.code).not.toContain('late-side-effect')
  })

  it('allows side-effect imports when the closure has no value imports', () => {
    const code = `import './polyfill.js'
const base = 40
// @preeval
const answer = base + 2
`
    const plan = analyzePreevalModule(code)
    expect(plan).not.toBeNull()
    expect(plan!.code).toContain('const base = 40')
    expect(plan!.code).not.toContain('polyfill')
  })

  it('allows never-called function decls that only read the closure', () => {
    const code = `const obj = { n: 1 }
function debug() { console.log(obj) }
// @preeval
const answer = obj.n
`
    const plan = analyzePreevalModule(code)
    expect(plan).not.toBeNull()
    expect(plan!.code).toContain('const obj')
    expect(plan!.code).not.toContain('debug')
  })

  it('rejects pre-target calls that rely on post-target hoisted mutators', () => {
    const code = `const obj = { n: 1 }
bump()
// @preeval
const answer = obj.n
function bump() { obj.n = 2 }
`
    expect(() => analyzePreevalModule(code)).toThrow(/hoisted declaration|closure binding/)
  })

  it('rejects reachable hoisted mutators via another function', () => {
    const code = `const obj = { n: 1 }
function bump() { obj.n = 2 }
function run() { bump() }
run()
// @preeval
const answer = obj.n
`
    expect(() => analyzePreevalModule(code)).toThrow(/hoisted declaration|closure binding/)
  })

  it('allows multi-mark statements that only touch already-evaluated deps', () => {
    const code = `const obj = { n: 1 }
// @preeval
const a = obj.n
console.log(obj)
// @preeval
const b = 2
export { a, b }
`
    const plan = analyzePreevalModule(code)
    expect(plan).not.toBeNull()
    expect(plan!.targets.map((t) => t.name)).toEqual(['a', 'b'])
    expect(plan!.code).toContain('const obj')
    expect(plan!.code).not.toContain('console.log')
  })

  it('rejects multi-mark statements that touch a later target closure', () => {
    const code = `const obj = { n: 1 }
function bump() { obj.n = 2 }
// @preeval
const a = obj.n
bump()
// @preeval
const b = obj.n
export { a, b }
`
    expect(() => analyzePreevalModule(code)).toThrow(/hoisted declaration|closure binding/)
  })

  it('indexes export default function dependencies', () => {
    const code = `export default function helper() { return 40 }
// @preeval
const answer = helper() + 2
`
    const plan = analyzePreevalModule(code)
    expect(plan).not.toBeNull()
    expect(plan!.code).toContain('function helper')
    expect(plan!.code).toContain('helper() + 2')
  })

  it('indexes export default class dependencies', () => {
    const code = `export default class Box { value = 40 }
// @preeval
const answer = new Box().value + 2
`
    const plan = analyzePreevalModule(code)
    expect(plan).not.toBeNull()
    expect(plan!.code).toContain('class Box')
    expect(plan!.code).toContain('new Box().value + 2')
  })

  it('rejects import.meta in a marked initializer', () => {
    const code = `// @preeval
const answer = import.meta.url
`
    expect(() => analyzePreevalModule(code)).toThrow(/import\.meta/)
  })

  it('rejects import.meta inside a closure function dependency', () => {
    const code = `function where() { return import.meta.url }
// @preeval
const answer = where()
`
    expect(() => analyzePreevalModule(code)).toThrow(/import\.meta/)
  })
})

describe('findAutomaticPreevalCalls', () => {
  it('matches exact static ESM bindings and aliases', () => {
    const code = `import def from 'pkg'
import { fn, fn as alias } from 'pkg'
import * as ns from 'pkg'
def()
fn()
alias()
ns.fn()
ns['fn']()
`
    const calls = findAutomaticPreevalCalls(code, [
      { match: { from: 'pkg', import: 'default' } },
      { match: { from: 'pkg', import: 'fn' } },
    ])
    expect(calls).toHaveLength(5)
    expect(calls.map((call) => call.rule.match.import)).toEqual(['default', 'fn', 'fn', 'fn', 'fn'])
  })

  it('matches tagged templates with the same binding rules', () => {
    const code = `import def from 'pkg'
import { fn, fn as alias } from 'pkg'
import * as ns from 'pkg'
def\`a\`
fn\`b\`
alias\`c\`
ns.fn\`d\`
ns['fn']\`e\`
`
    const calls = findAutomaticPreevalCalls(code, [
      { match: { from: 'pkg', import: 'default' } },
      { match: { from: 'pkg', import: 'fn' } },
    ])
    expect(calls).toHaveLength(5)
    expect(calls.map((call) => call.rule.match.import)).toEqual(['default', 'fn', 'fn', 'fn', 'fn'])
  })

  it('does not treat untagged template literals as automatic sites', () => {
    const code = `import { fn } from 'pkg'
const value = \`fn()\`
fn()
`
    const calls = findAutomaticPreevalCalls(code, [{ match: { from: 'pkg', import: 'fn' } }])
    expect(calls).toHaveLength(1)
  })

  it('does not follow local aliases or unsupported module forms', () => {
    const code = `import { fn } from 'pkg'
const local = fn
local()
const required = require('pkg')
required.fn()
import('pkg').then((mod) => mod.fn())
`
    expect(findAutomaticPreevalCalls(code, [{ match: { from: 'pkg', import: 'fn' } }])).toEqual([])
  })

  it('matches source specifiers exactly and does not follow barrels', () => {
    const code = `import { fn } from './barrel.js'\nfn()\n`
    expect(
      findAutomaticPreevalCalls(code, [{ match: { from: './impl.js', import: 'fn' } }]),
    ).toEqual([])
  })
})
