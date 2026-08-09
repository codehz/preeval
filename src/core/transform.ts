import MagicString from 'magic-string'
import * as t from '@babel/types'
import type { FailurePolicy, ImportedFunctionRef, Options } from '../types'
import {
  analyzeAutomaticPreevalCall,
  analyzePreevalModule,
  collectUsedIdentifierNames,
  findAutomaticPreevalCalls,
  findMarkedPreevalTargets,
  planAutomaticImportCleanup,
  type AutomaticCallTarget,
  type EvaluationPlan,
  type SourceRange,
} from './analyze'
import { evalExtractedModule } from './eval'
import { serializeJson } from './serialize'

export interface TransformContext {
  warn: (msg: string) => void
  error: (msg: string) => void
}

interface Replacement {
  start: number
  end: number
  text: string
}

interface AutomaticReplacement {
  start: number
  end: number
  staticText: string
  emitText: string
  runtimeBoundary: boolean
  materializer?: ImportedFunctionRef
}

interface FinalReplacement extends Replacement {
  materializer?: ImportedFunctionRef
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function reportFailure(
  policy: FailurePolicy,
  msg: string,
  ctx: TransformContext,
  cause?: unknown,
): void {
  if (policy === 'ignore') return
  if (policy === 'warn') {
    ctx.warn(msg)
    return
  }
  ctx.error(msg)
  throw new Error(msg, cause === undefined ? undefined : { cause })
}

function effectiveReplacements<T extends { start: number; end: number }>(
  replacements: readonly T[],
): T[] {
  const selected: T[] = []
  for (const replacement of [...replacements].sort(
    (a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start,
  )) {
    if (selected.some((outer) => outer.start <= replacement.start && replacement.end <= outer.end)) {
      continue
    }
    selected.push(replacement)
  }
  return selected.sort((a, b) => a.start - b.start)
}

function renderAutomaticStatic(
  code: string,
  replacements: readonly AutomaticReplacement[],
): { code: string; runtimeBoundaries: SourceRange[] } {
  let output = ''
  let cursor = 0
  const runtimeBoundaries: SourceRange[] = []
  for (const replacement of effectiveReplacements(replacements)) {
    output += code.slice(cursor, replacement.start)
    const start = output.length
    output += replacement.staticText
    if (replacement.runtimeBoundary) {
      runtimeBoundaries.push({ start, end: output.length })
    }
    cursor = replacement.end
  }
  output += code.slice(cursor)
  return { code: output, runtimeBoundaries }
}

function mapAutomaticOffset(
  offset: number,
  replacements: readonly AutomaticReplacement[],
): number {
  let mapped = offset
  for (const replacement of effectiveReplacements(replacements)) {
    if (replacement.end > offset) break
    mapped += replacement.staticText.length - (replacement.end - replacement.start)
  }
  return mapped
}

function refKey(ref: ImportedFunctionRef): string {
  return `${ref.from}\0${ref.import}`
}

function allocateMaterializerLocals(
  code: string,
  rules: NonNullable<Options['rules']>,
  filename: string,
): Map<string, string> {
  const used = collectUsedIdentifierNames(code, filename)
  const locals = new Map<string, string>()
  for (const rule of rules) {
    if (!rule.materialize) continue
    const key = refKey(rule.materialize)
    if (locals.has(key)) continue
    let index = 0
    let local = '__preeval_materialize'
    while (used.has(local)) local = `__preeval_materialize_${++index}`
    used.add(local)
    locals.set(key, local)
  }
  return locals
}

function renderMaterializerImport(ref: ImportedFunctionRef, local: string): string {
  const source = JSON.stringify(ref.from)
  if (ref.import === 'default') return `import ${local} from ${source};`
  const imported = t.isValidIdentifier(ref.import) ? ref.import : JSON.stringify(ref.import)
  return `import { ${imported} as ${local} } from ${source};`
}

function runtimeImportInsertionOffset(code: string): number {
  if (!code.startsWith('#!')) return 0
  const newline = code.indexOf('\n')
  return newline === -1 ? code.length : newline + 1
}
function automaticEvaluationOrder(
  targets: readonly AutomaticCallTarget[],
): AutomaticCallTarget[] {
  const children = new Map<AutomaticCallTarget, AutomaticCallTarget[]>()
  const roots: AutomaticCallTarget[] = []
  for (const target of targets) children.set(target, [])

  for (const target of targets) {
    let parent: AutomaticCallTarget | null = null
    for (const candidate of targets) {
      if (candidate === target) continue
      if (candidate.start <= target.start && target.end <= candidate.end) {
        if (parent == null || candidate.end - candidate.start < parent.end - parent.start) {
          parent = candidate
        }
      }
    }
    if (parent) children.get(parent)!.push(target)
    else roots.push(target)
  }

  const ordered: AutomaticCallTarget[] = []
  const visit = (target: AutomaticCallTarget): void => {
    for (const child of children.get(target)!.sort((a, b) => a.start - b.start)) visit(child)
    ordered.push(target)
  }
  for (const root of roots.sort((a, b) => a.start - b.start)) visit(root)
  return ordered
}

async function evaluatePlan(
  file: string,
  plan: EvaluationPlan,
  allowNode: boolean | undefined,
): Promise<Map<string, unknown>> {
  return evalExtractedModule(file, plan, { allowNode })
}

/**
 * Pre-evaluate configured imported calls in macro order, then marked bindings,
 * and apply one non-overlapping rewrite set to the original source.
 */
export async function transformPreeval(
  code: string,
  id: string,
  options: Options,
  ctx: TransformContext,
): Promise<{ code: string; map: object } | null> {
  const cut = id.search(/[?#]/)
  const file = cut === -1 ? id : id.slice(0, cut)
  const globalPolicy = options.onFailure ?? 'warn'
  const rules = options.rules ?? []
  const materializerLocals = allocateMaterializerLocals(code, rules, file)
  const originalMarked = findMarkedPreevalTargets(code, file)
  const originalMarkedByName = new Map(originalMarked.map((target) => [target.name, target]))
  const automaticTargets = findAutomaticPreevalCalls(code, rules, file)
  const automaticReplacements: AutomaticReplacement[] = []
  const failedAutomatic = new Set<AutomaticCallTarget>()
  const successfulBindings = new Set<string>()

  for (const target of automaticEvaluationOrder(automaticTargets)) {
    const hasFailedDescendant = [...failedAutomatic].some(
      (failed) => target.start <= failed.start && failed.end <= target.end,
    )
    if (hasFailedDescendant) {
      failedAutomatic.add(target)
      continue
    }

    const intermediate = renderAutomaticStatic(code, automaticReplacements)
    const currentStart = mapAutomaticOffset(target.start, automaticReplacements)
    const policy = target.rule.onFailure ?? globalPolicy
    const label = `${target.rule.match.from}#${target.rule.match.import}`
    let plan: EvaluationPlan
    try {
      plan = analyzeAutomaticPreevalCall(
        intermediate.code,
        currentStart,
        target.rule,
        file,
        { runtimeBoundaries: intermediate.runtimeBoundaries },
      )
    } catch (cause) {
      const msg = `[preeval] ${file}:${target.line}:${target.column + 1} ${label} failed: ${reasonOf(cause)}`
      reportFailure(policy, msg, ctx, cause)
      failedAutomatic.add(target)
      continue
    }

    let values: Map<string, unknown>
    try {
      values = await evaluatePlan(file, plan, options.allowNode)
    } catch (cause) {
      const msg = `[preeval] ${file}:${target.line}:${target.column + 1} ${label} failed: ${reasonOf(cause)}`
      reportFailure(policy, msg, ctx, cause)
      failedAutomatic.add(target)
      continue
    }

    const resultTarget = plan.targets[0]!
    if (!values.has(resultTarget.name)) {
      const msg = `[preeval] ${file}:${target.line}:${target.column + 1} ${label} failed: result was not found on the evaluated module namespace`
      reportFailure(policy, msg, ctx)
      failedAutomatic.add(target)
      continue
    }

    let staticText: string
    try {
      staticText = serializeJson(values.get(resultTarget.name))
    } catch (cause) {
      const msg = `[preeval] ${file}:${target.line}:${target.column + 1} ${label} failed: result is not JSON-superset (${reasonOf(cause)})`
      reportFailure(policy, msg, ctx, cause)
      failedAutomatic.add(target)
      continue
    }

    const materializer = target.rule.materialize
    const emitText = materializer
      ? `${materializerLocals.get(refKey(materializer))!}(${staticText})`
      : staticText
    automaticReplacements.push({
      start: target.start,
      end: target.end,
      staticText,
      emitText,
      runtimeBoundary: materializer !== undefined,
      ...(materializer ? { materializer } : {}),
    })
    successfulBindings.add(target.bindingName)
  }

  const skippedMarkedNames = new Set<string>()
  for (const target of failedAutomatic) {
    if (target.containingMarkedName) skippedMarkedNames.add(target.containingMarkedName)
  }

  const automaticOutput = renderAutomaticStatic(code, automaticReplacements)
  const markedReplacements: Replacement[] = []
  let markedPlan: EvaluationPlan | null = null
  try {
    markedPlan = analyzePreevalModule(automaticOutput.code, file, {
      skipMarkedNames: skippedMarkedNames,
      runtimeBoundaries: automaticOutput.runtimeBoundaries,
    })
  } catch (cause) {
    const msg = `[preeval] ${file}: ${reasonOf(cause)}`
    reportFailure(globalPolicy, msg, ctx, cause)
  }

  for (const blocked of markedPlan?.blockedTargets ?? []) {
    const msg = `[preeval] ${file}: marked const "${blocked.name}" failed: target depends on a runtime materializer boundary`
    reportFailure(globalPolicy, msg, ctx)
  }

  if (markedPlan && markedPlan.targets.length > 0) {
    let values: Map<string, unknown> | null = null
    try {
      values = await evaluatePlan(file, markedPlan, options.allowNode)
    } catch (cause) {
      const msg = `[preeval] ${reasonOf(cause)}`
      reportFailure(globalPolicy, msg, ctx, cause)
    }

    if (values) {
      for (const target of markedPlan.targets) {
        const original = originalMarkedByName.get(target.name)
        if (!original) continue
        if (!values.has(target.name)) {
          const msg = `[preeval] ${file}: marked const "${target.name}" was not found on the evaluated module namespace`
          reportFailure(globalPolicy, msg, ctx)
          continue
        }
        let text: string
        try {
          text = serializeJson(values.get(target.name))
        } catch (cause) {
          const msg = `[preeval] ${file}: marked const "${target.name}" is not JSON-superset (${reasonOf(cause)})`
          reportFailure(globalPolicy, msg, ctx, cause)
          continue
        }
        markedReplacements.push({
          start: original.initStart,
          end: original.initEnd,
          text,
        })
      }
    }
  }

  const finalAutomatic: FinalReplacement[] = automaticReplacements.map((replacement) => ({
    start: replacement.start,
    end: replacement.end,
    text: replacement.emitText,
    ...(replacement.materializer ? { materializer: replacement.materializer } : {}),
  }))
  const replacements = effectiveReplacements<FinalReplacement>([
    ...finalAutomatic,
    ...markedReplacements,
  ])
  if (replacements.length === 0) return null

  const cleanup = planAutomaticImportCleanup(
    code,
    successfulBindings,
    replacements,
    file,
  )
  const usedMaterializers = new Map<string, ImportedFunctionRef>()
  for (const replacement of replacements) {
    if (replacement.materializer) {
      usedMaterializers.set(refKey(replacement.materializer), replacement.materializer)
    }
  }

  const s = new MagicString(code)
  for (const replacement of replacements) {
    s.overwrite(replacement.start, replacement.end, replacement.text)
  }
  for (const edit of cleanup) {
    s.overwrite(edit.start, edit.end, edit.replacement)
  }

  if (usedMaterializers.size > 0) {
    const importBlock = [...usedMaterializers.entries()]
      .map(([key, ref]) => renderMaterializerImport(ref, materializerLocals.get(key)!))
      .join('\n') + '\n'
    const offset = runtimeImportInsertionOffset(code)
    if (offset === 0) s.prepend(importBlock)
    else s.appendLeft(offset, importBlock)
  }

  return {
    code: s.toString(),
    map: s.generateMap({ source: file, hires: true, includeContent: true }),
  }
}
