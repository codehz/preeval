import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EvaluationPlan, PreevalTarget } from './analyze'

/** Source extensions that may contain TypeScript syntax. */
const TS_FILE = /\.(?:[cm]?ts|tsx)$/

/** Source extensions that may contain JSX (but not necessarily TypeScript). */
const JSX_FILE = /\.(?:jsx|tsx)$/

/** Optional overrides for unit tests (force Node path under Bun). */
export type EvalRuntime = {
  /** When set, skips `globalThis.Bun` detection. */
  isBun?: boolean
}

function detectBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
}

function tempExtFor(id: string): string {
  const ext = extname(id).toLowerCase()
  if (ext === '.tsx' || ext === '.jsx' || ext === '.mts' || ext === '.cts' || ext === '.ts') {
    return ext
  }
  return '.mjs'
}

/**
 * Prepare source for evaluation.
 * - Bun: keep original source/extension (native TS/TSX/JSX loaders).
 * - Node + TS/TSX: transpile entry via optional `sucrase` peer → `.mjs`.
 * - Node + plain JS/JSX: write as `.mjs`.
 *
 * Dynamic import of `sucrase` is intentional: it is an optional peer and
 * must not be required when evaluating plain JS.
 */
async function prepareEvalSource(
  code: string,
  id: string,
  isBun: boolean,
): Promise<{ content: string; ext: string }> {
  if (isBun) {
    return { content: code, ext: tempExtFor(id) }
  }

  if (!TS_FILE.test(id)) {
    return { content: code, ext: '.mjs' }
  }

  let transform: typeof import('sucrase').transform
  try {
    ;({ transform } = await import('sucrase'))
  } catch {
    throw new Error(
      `preeval: evaluating TypeScript (${id}) under Node requires the optional "sucrase" peer dependency`,
    )
  }

  const isTsx = JSX_FILE.test(id)
  try {
    const { code: outputText } = transform(code, {
      transforms: isTsx ? ['typescript', 'jsx'] : ['typescript'],
      filePath: id,
      disableESTransforms: true,
      ...(isTsx
        ? {
            jsxRuntime: 'automatic' as const,
            production: true,
          }
        : {}),
    })
    return { content: outputText, ext: '.mjs' }
  } catch (cause) {
    throw new Error(
      `Failed to transpile ${id}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
  }
}

/**
 * Evaluate an extracted plan module and return values keyed by local binding name.
 *
 * The extracted ESM is written to a uniquely named temp file *next to* the
 * source file so relative imports resolve the same way they do for the source.
 * Synthetic exports (`target.evalExportName`) are read off the module namespace.
 *
 * `allowNode` is trust-only: nothing is injected and nothing is stripped.
 *
 * Note: only the extracted entry is rewritten/transpiled. Relative TypeScript
 * dependencies under Node require a host loader (or pure JS deps).
 *
 * `runtime.isBun` is for tests: force the Node prepare path even when the
 * process is Bun (default detects `globalThis.Bun`).
 */
export async function evalExtractedModule(
  id: string,
  plan: EvaluationPlan,
  options: { allowNode?: boolean },
  runtime?: EvalRuntime,
): Promise<Map<string, unknown>> {
  void options.allowNode
  if (plan.targets.length === 0) return new Map()

  const cut = id.search(/[?#]/)
  const file = cut === -1 ? id : id.slice(0, cut)
  const isBun = runtime?.isBun ?? detectBun()
  const prepared = await prepareEvalSource(plan.code, file, isBun)
  const tmp = join(
    dirname(file),
    `.preeval-${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}${prepared.ext}`,
  )
  try {
    writeFileSync(tmp, prepared.content)
    let ns: Record<string, unknown>
    try {
      ns = (await import(pathToFileURL(tmp).href)) as Record<string, unknown>
    } catch (cause) {
      throw new Error(
        `Failed to evaluate ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      )
    }
    return readTargetValues(ns, plan.targets)
  } finally {
    rmSync(tmp, { force: true })
  }
}

function isThenable(value: unknown): boolean {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

export function readTargetValues(
  ns: Record<string, unknown>,
  targets: PreevalTarget[],
): Map<string, unknown> {
  const values = new Map<string, unknown>()
  for (const target of targets) {
    const value = ns[target.evalExportName]
    if (isThenable(value)) {
      throw new Error(
        `preeval: target "${target.name}" returned a Promise/thenable; asynchronous results are not supported`,
      )
    }
    values.set(target.name, value)
  }
  return values
}
