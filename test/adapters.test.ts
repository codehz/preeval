import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { build as esbuildBuild } from 'esbuild'
import { build as rolldownBuild } from 'rolldown'
import createEsbuildPreeval from '../src/esbuild'
import createRolldownPreeval from '../src/rolldown'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'preeval-adapter-'))
  dirs.push(dir)
  return dir
}

const SOURCE = `// @preeval
export const answer = 40 + 2
`

describe('bundler adapters', () => {
  it('exports callable rolldown and esbuild plugin factories', () => {
    expect(typeof createRolldownPreeval).toBe('function')
    expect(typeof createEsbuildPreeval).toBe('function')

    const rolldownPlugin = createRolldownPreeval()
    const esbuildPlugin = createEsbuildPreeval()

    expect(rolldownPlugin).toEqual(
      expect.objectContaining({
        name: '@codehz/preeval',
      }),
    )
    expect(esbuildPlugin).toEqual(
      expect.objectContaining({
        name: '@codehz/preeval',
        setup: expect.any(Function),
      }),
    )
  })

  it('pre-evaluates marked consts through rolldown', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    writeFileSync(entry, SOURCE)

    const result = await rolldownBuild({
      input: entry,
      plugins: [createRolldownPreeval()],
      write: false,
    })

    const code = result.output.map((chunk) => ('code' in chunk ? chunk.code : '')).join('\n')
    expect(code).toContain('42')
    expect(code).not.toContain('40 + 2')
  })

  it('pre-evaluates marked consts through esbuild', async () => {
    const dir = tmpDir()
    const entry = join(dir, 'entry.js')
    const outfile = join(dir, 'out.js')
    writeFileSync(entry, SOURCE)

    await esbuildBuild({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      outfile,
      plugins: [createEsbuildPreeval()],
      write: true,
      logLevel: 'silent',
    })

    const code = readFileSync(outfile, 'utf8')
    expect(code).toContain('42')
    expect(code).not.toContain('40 + 2')
  })
})
