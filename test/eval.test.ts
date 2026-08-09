import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { evalModuleExports } from '../src/core/eval'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'preeval-eval-'))
  dirs.push(dir)
  return dir
}

/** Force the Node prepare path (sucrase) even when the test runner is Bun. */
const nodeRuntime = { isBun: false }

describe('evalModuleExports (Node path)', () => {
  it('transpiles a .ts entry via sucrase and returns marked values', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.ts')
    const code = `// @preeval
export const answer: number = 40 + 2
`
    writeFileSync(entry, code)

    const values = await evalModuleExports(
      entry,
      code,
      [{ name: 'answer', exportName: 'answer', initStart: 0, initEnd: 0 }],
      {},
      nodeRuntime,
    )

    expect(values.get('answer')).toBe(42)
  })

  it('strips type-only imports under Node', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.ts')
    const code = `import type { Unused } from './missing.js'
// @preeval
export const n: number = 1 + 1
`
    writeFileSync(entry, code)

    const values = await evalModuleExports(
      entry,
      code,
      [{ name: 'n', exportName: 'n', initStart: 0, initEnd: 0 }],
      {},
      nodeRuntime,
    )

    expect(values.get('n')).toBe(2)
  })

  it('transpiles enums used by marked bindings', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.ts')
    const code = `enum E { A = 40 }
// @preeval
export const answer = E.A + 2
`
    writeFileSync(entry, code)

    const values = await evalModuleExports(
      entry,
      code,
      [{ name: 'answer', exportName: 'answer', initStart: 0, initEnd: 0 }],
      {},
      nodeRuntime,
    )

    expect(values.get('answer')).toBe(42)
  })

  it('leaves plain .js unchanged under Node (no sucrase load required for syntax)', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `// @preeval
export const answer = 20 * 2
`
    writeFileSync(entry, code)

    const values = await evalModuleExports(
      entry,
      code,
      [{ name: 'answer', exportName: 'answer', initStart: 0, initEnd: 0 }],
      {},
      nodeRuntime,
    )

    expect(values.get('answer')).toBe(40)
  })
})

describe('evalModuleExports (default runtime)', () => {
  it('evaluates TS natively when Bun is present', async () => {
    // This suite is run with Bun; skip if somehow not.
    if (typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') {
      return
    }
    const dir = tmpDir()
    const entry = join(dir, 'entry.ts')
    const code = `// @preeval
export const answer: number = 10 + 1
`
    writeFileSync(entry, code)

    const values = await evalModuleExports(
      entry,
      code,
      [{ name: 'answer', exportName: 'answer', initStart: 0, initEnd: 0 }],
      {},
    )

    expect(values.get('answer')).toBe(11)
  })
})
