import { describe, expect, it } from 'vitest'
import { detectMarkedExports } from '../src/core/detect'

/** Resolve the exact init span of `expr` inside `code`. */
function spanOf(code: string, expr: string): { initStart: number; initEnd: number } {
  const start = code.indexOf(expr)
  expect(start).toBeGreaterThanOrEqual(0)
  return { initStart: start, initEnd: start + expr.length }
}

describe('detectMarkedExports', () => {
  it('detects name/exportName/init spans for export const', () => {
    const code = `// @preeval
export const marked = 1 + 2
`
    const marks = detectMarkedExports(code)
    expect(marks).toHaveLength(1)
    const m = marks[0]!
    expect(m).toMatchObject({ name: 'marked', exportName: 'marked' })
    expect(m.initStart).toBe(spanOf(code, '1 + 2').initStart)
    expect(m.initEnd).toBe(spanOf(code, '1 + 2').initEnd)
    expect(code.slice(m.initStart, m.initEnd)).toBe('1 + 2')
  })

  it('detects const + export { name }', () => {
    const code = `// @preeval
const foo = 'hello'
export { foo }
`
    const marks = detectMarkedExports(code)
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ name: 'foo', exportName: 'foo' })
  })

  it('uses the alias as exportName for export { name as alias }', () => {
    const code = `// @preeval
const foo = 42
export { foo as bar }
`
    const marks = detectMarkedExports(code)
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ name: 'foo', exportName: 'bar' })
  })

  it('allows blank lines between the marker and the declaration', () => {
    const code = `// @preeval


export const x = 1
`
    const marks = detectMarkedExports(code)
    expect(marks).toHaveLength(1)
    expect(marks[0]?.name).toBe('x')
  })

  it('rejects a block comment marker', () => {
    const code = `/* @preeval */
export const x = 1
`
    expect(detectMarkedExports(code)).toEqual([])
  })

  it('skips non-exported consts', () => {
    const code = `// @preeval
const x = 1
`
    expect(detectMarkedExports(code)).toEqual([])
  })

  it('skips multi-declarator declarations', () => {
    const code = `// @preeval
export const a = 1, b = 2
`
    expect(detectMarkedExports(code)).toEqual([])
  })

  it('finds multiple marks in one file', () => {
    const code = `// @preeval
export const a = 1
// @preeval
export const b = 'two'
`
    const marks = detectMarkedExports(code)
    expect(marks.map((m) => m.name)).toEqual(['a', 'b'])
    expect(marks.map((m) => m.exportName)).toEqual(['a', 'b'])
  })

  it('rejects a marker with trailing text', () => {
    const code = `// @preeval foo
export const x = 1
`
    expect(detectMarkedExports(code)).toEqual([])
  })

  it('rejects an intervening non-marker comment', () => {
    const code = `// @preeval
// helper comment
export const x = 1
`
    expect(detectMarkedExports(code)).toEqual([])
  })

  it('ignores type-only export lists for runtime export map', () => {
    const code = `// @preeval
const X = 1
export type { X }
`
    expect(detectMarkedExports(code, 'mod.ts')).toEqual([])
  })

  it('ignores type-only export specifiers', () => {
    const code = `// @preeval
const X = 1
export { type X }
`
    expect(detectMarkedExports(code, 'mod.ts')).toEqual([])
  })

  it('parses angle-bracket assertions in .ts files', () => {
    const code = `// @preeval
export const x = <number>1
`
    const marks = detectMarkedExports(code, 'mod.ts')
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ name: 'x', exportName: 'x' })
  })
})
