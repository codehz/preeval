import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EvaluationPlan, PreevalTarget } from './analyze'

/** Source extensions that require a host TypeScript/JSX loader. */
const HOST_LOADER_FILE = /\.(?:[cm]?ts|tsx|jsx)$/

function tempExtFor(id: string): string {
  const ext = extname(id).toLowerCase()
  return HOST_LOADER_FILE.test(ext) ? ext : '.mjs'
}

/**
 * Prepare source for evaluation.
 *
 * The extracted module keeps its TypeScript/JSX extension so a host loader can
 * transform it and any relative TypeScript dependencies. Node intentionally
 * does not transpile source; run the publish build with a loader such as tsx
 * (for example, `NODE_OPTIONS='--import tsx/esm' ...`) or use plain JS.
 */
function prepareEvalSource(code: string, id: string): { content: string; ext: string } {
  return { content: code, ext: tempExtFor(id) }
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
 * TypeScript and JSX are delegated to the host runtime. Bun handles them
 * natively; Node needs an externally configured loader such as tsx.
 */
export async function evalExtractedModule(
  id: string,
  plan: EvaluationPlan,
  options: { allowNode?: boolean },
): Promise<Map<string, unknown>> {
  void options.allowNode
  if (plan.targets.length === 0) return new Map()

  const cut = id.search(/[?#]/)
  const file = cut === -1 ? id : id.slice(0, cut)
  const prepared = prepareEvalSource(plan.code, file)
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
