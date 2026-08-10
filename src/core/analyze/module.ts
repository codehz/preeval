import { parseModule, resolveProgramPath } from './ast'
import { buildNameClosure, assertNoInterferingStatements, closureTouchesRanges } from './closure'
import { indexLocalDecls, varKindOf } from './decls'
import { allocateEvalExportNames, buildExtractedCode } from './extract'
import { collectMarkedTargets } from './markers'
import type { EvaluationPlan, MarkedBindingTarget, PreevalTarget, SourceRange } from './types'

/**
 * Parse `code`, find `// @preeval`-marked top-level consts (exported or not),
 * compute the union lexical dependency closure, and build a minimal ESM module
 * that evaluates those targets once via synthetic exports.
 *
 * @returns `null` when there are no marks or the file cannot be parsed.
 * @throws when marks exist but the closure cannot be proven safe.
 */
export function analyzePreevalModule(
  code: string,
  filename?: string,
  options?: {
    skipMarkedNames?: ReadonlySet<string>
    runtimeBoundaries?: readonly SourceRange[]
  },
): EvaluationPlan | null {
  const file = parseModule(code, filename)
  if (file == null) return null

  const candidateTargets = collectMarkedTargets(code, file).filter(
    (target) => !options?.skipMarkedNames?.has(target.name),
  )
  if (candidateTargets.length === 0) return null

  const pPath = resolveProgramPath(file)
  const programScope = pPath.scope
  const localDecls = indexLocalDecls(pPath)

  for (const target of candidateTargets) {
    const decl = localDecls.get(target.name)
    if (decl == null) {
      throw new Error(`preeval: marked const "${target.name}" has no top-level binding`)
    }
    if (varKindOf(decl) !== 'const') {
      throw new Error(`preeval: marked binding "${target.name}" must be a const`)
    }
    if (decl.binding && !decl.binding.constant) {
      throw new Error(`preeval: marked binding "${target.name}" is reassigned`)
    }
  }

  const perTargetClosures = new Map<string, Set<string>>()
  const blockedTargets: MarkedBindingTarget[] = []
  for (const target of candidateTargets) {
    const targetClosure = buildNameClosure([target.name], programScope, localDecls)
    perTargetClosures.set(target.name, targetClosure)
    if (
      options?.runtimeBoundaries?.length &&
      closureTouchesRanges([], targetClosure, localDecls, options.runtimeBoundaries)
    ) {
      blockedTargets.push({
        name: target.name,
        initStart: target.initStart,
        initEnd: target.initEnd,
      })
    }
  }

  const blockedNames = new Set(blockedTargets.map((target) => target.name))
  const rawTargets = candidateTargets.filter((target) => !blockedNames.has(target.name))
  if (rawTargets.length === 0) {
    return { code: '', targets: [], blockedTargets }
  }

  const closure = new Set<string>()
  for (const target of rawTargets) {
    for (const name of perTargetClosures.get(target.name) ?? []) closure.add(name)
  }

  assertNoInterferingStatements(pPath, rawTargets, closure, localDecls, perTargetClosures)

  const evalNames = allocateEvalExportNames(
    rawTargets.map((target) => target.name),
    localDecls,
  )
  const targets: PreevalTarget[] = rawTargets.map((target, index) => ({
    name: target.name,
    initStart: target.initStart,
    initEnd: target.initEnd,
    evalExportName: evalNames[index]!,
  }))

  const extracted = buildExtractedCode(file.program.body, closure, targets)
  return {
    code: extracted,
    targets,
    ...(blockedTargets.length > 0 ? { blockedTargets } : {}),
  }
}
