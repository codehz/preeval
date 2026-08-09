import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { MarkedBinding } from './detect'

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
 * - Node + plain JS/JSX: write as `.mjs` (JSX-only files still need a host
 *   that can parse JSX — document as host responsibility).
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

  // Optional peer — only loaded when a Node build evaluates TypeScript.
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
      // Match former transpileModule target/module ESNext: keep modern syntax.
      disableESTransforms: true,
      ...(isTsx
        ? {
            // Align with former ts.JsxEmit.ReactJSX (automatic production).
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
 * Evaluate a whole module and return the values of the marked bindings,
 * keyed by their local names.
 *
 * The module is prepared (when needed) and written to a uniquely named
 * temp file *next to* the source file, so relative imports resolve the
 * same way they do for the source. It is then loaded with a dynamic import
 * and the marked exports are read off the module namespace.
 *
 * `allowNode` is trust-only in v1: nothing is injected and nothing is
 * stripped. The module always runs as-is in the host runtime (Bun or Node
 * during build), so it can already use any Node/Bun API the host provides.
 * The flag exists so authors can explicitly acknowledge that the marked
 * module is safe to evaluate — not to enable anything here.
 *
 * Note: only the entry module is rewritten/transpiled. Relative TypeScript
 * dependencies under Node require a host loader (or pure JS deps). ESM module
 * cache for dependencies is process-wide; one-shot publish builds are fine.
 *
 * `runtime.isBun` is for tests: force the Node prepare path even when the
 * process is Bun (default detects `globalThis.Bun`).
 */
export async function evalModuleExports(
  id: string,
  code: string,
  bindings: MarkedBinding[],
  options: { allowNode?: boolean },
  runtime?: EvalRuntime,
): Promise<Map<string, unknown>> {
  void options.allowNode
  if (bindings.length === 0) return new Map()

  // Strip ?query and #hash so the id is usable as a filesystem path; the
  // temp file must live next to the source so relative imports resolve.
  const cut = id.search(/[?#]/)
  const file = cut === -1 ? id : id.slice(0, cut)
  const isBun = runtime?.isBun ?? detectBun()
  const prepared = await prepareEvalSource(code, file, isBun)
  const tmp = join(
    dirname(file),
    `.preeval-${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}${prepared.ext}`,
  )
  try {
    writeFileSync(tmp, prepared.content)
    let ns: Record<string, unknown>
    try {
      // Dynamic import is required: the specifier is a per-eval temp file
      // path that cannot be known at author time.
      ns = (await import(pathToFileURL(tmp).href)) as Record<string, unknown>
    } catch (cause) {
      throw new Error(
        `Failed to evaluate ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      )
    }
    const values = new Map<string, unknown>()
    for (const binding of bindings) {
      values.set(binding.name, ns[binding.exportName])
    }
    return values
  } finally {
    rmSync(tmp, { force: true })
  }
}
