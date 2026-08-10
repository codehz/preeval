import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { analyzePreevalModule } from '../src/core/analyze'
import { evalExtractedModule } from '../src/core/eval'

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

describe('evalExtractedModule (host runtime)', () => {
  it('evaluates plain JS under Node without an internal transpiler', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `// @preeval
export const answer = 20 * 2
`
    writeFileSync(entry, code)
    const plan = analyzePreevalModule(code, entry)!

    const values = await evalExtractedModule(entry, plan)

    expect(values.get('answer')).toBe(40)
  })
})

describe('evalExtractedModule (default runtime)', () => {
  it('evaluates TS natively when Bun is present', async () => {
    if (typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') {
      return
    }
    const dir = tmpDir()
    const entry = join(dir, 'entry.ts')
    const code = `// @preeval
export const answer: number = 10 + 1
`
    writeFileSync(entry, code)
    const plan = analyzePreevalModule(code, entry)!

    const values = await evalExtractedModule(entry, plan)

    expect(values.get('answer')).toBe(11)
  })

  it('does not execute unrelated top-level side effects', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `throw new Error('must not execute')
const base = 40
// @preeval
const local = base + 2
export const answer = local
`
    writeFileSync(entry, code)
    const plan = analyzePreevalModule(code, entry)!

    const values = await evalExtractedModule(entry, plan)

    expect(values.get('local')).toBe(42)
  })
})
