import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

  it('non-strict: non-JSON value warns and skips the binding', async () => {
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

  it('non-strict: skips the failing binding but keeps replacing others', async () => {
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

  it('strict: non-JSON value errors and throws', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `// @preeval
export const bad = new Date(0)
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    await expect(transformPreeval(code, entry, { strict: true }, ctx)).rejects.toThrow(
      /not JSON-superset/,
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/^ERR:/)
  })

  it('non-strict: module eval failure warns and returns null', async () => {
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

  it('strict: module eval failure errors and throws', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `// @preeval
export const x = (() => { throw new Error('boom') })()
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    await expect(transformPreeval(code, entry, { strict: true }, ctx)).rejects.toThrow(
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

  it('non-strict: analysis failure warns and returns null', async () => {
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

  it('strict: analysis failure errors and throws', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const code = `let base = 40
// @preeval
const answer = base + 2
`
    writeFileSync(entry, code)
    const { ctx, warns } = makeCtx()

    await expect(transformPreeval(code, entry, { strict: true }, ctx)).rejects.toThrow(/let/)
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
})
