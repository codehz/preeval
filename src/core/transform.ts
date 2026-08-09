import MagicString from 'magic-string'
import type { FailurePolicy, Options } from '../types'
import {
  analyzeAutomaticPreevalCall,
  analyzePreevalModule,
  findAutomaticPreevalCalls,
  findMarkedPreevalTargets,
  planAutomaticImportCleanup,
  type AutomaticCallTarget,
  type EvaluationPlan,
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

function effectiveReplacements(replacements: readonly Replacement[]): Replacement[] {
  const selected: Replacement[] = []
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

function renderReplacements(code: string, replacements: readonly Replacement[]): string {
  let output = code
  for (const replacement of [...effectiveReplacements(replacements)].reverse()) {
    output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end)
  }
  return output
}

function mapOffset(offset: number, replacements: readonly Replacement[]): number {
  let mapped = offset
  for (const replacement of effectiveReplacements(replacements)) {
    if (replacement.end > offset) break
    mapped += replacement.text.length - (replacement.end - replacement.start)
  }
  return mapped
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
  const rules = options.imports ?? []
  const originalMarked = findMarkedPreevalTargets(code, file)
  const originalMarkedByName = new Map(originalMarked.map((target) => [target.name, target]))
  const automaticTargets = findAutomaticPreevalCalls(code, rules, file)
  const automaticReplacements: Replacement[] = []
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

    const intermediate = renderReplacements(code, automaticReplacements)
    const currentStart = mapOffset(target.start, automaticReplacements)
    const policy = target.rule.onFailure ?? globalPolicy
    let plan: EvaluationPlan
    try {
      plan = analyzeAutomaticPreevalCall(intermediate, currentStart, target.rule, file)
    } catch (cause) {
      const msg = `[preeval] ${file}:${target.line}:${target.column + 1} ${target.rule.from}#${target.rule.import} failed: ${reasonOf(cause)}`
      reportFailure(policy, msg, ctx, cause)
      failedAutomatic.add(target)
      continue
    }

    let values: Map<string, unknown>
    try {
      values = await evaluatePlan(file, plan, options.allowNode)
    } catch (cause) {
      const msg = `[preeval] ${file}:${target.line}:${target.column + 1} ${target.rule.from}#${target.rule.import} failed: ${reasonOf(cause)}`
      reportFailure(policy, msg, ctx, cause)
      failedAutomatic.add(target)
      continue
    }

    const resultTarget = plan.targets[0]!
    if (!values.has(resultTarget.name)) {
      const msg = `[preeval] ${file}:${target.line}:${target.column + 1} ${target.rule.from}#${target.rule.import} failed: result was not found on the evaluated module namespace`
      reportFailure(policy, msg, ctx)
      failedAutomatic.add(target)
      continue
    }

    let text: string
    try {
      text = serializeJson(values.get(resultTarget.name))
    } catch (cause) {
      const msg = `[preeval] ${file}:${target.line}:${target.column + 1} ${target.rule.from}#${target.rule.import} failed: result is not JSON-superset (${reasonOf(cause)})`
      reportFailure(policy, msg, ctx, cause)
      failedAutomatic.add(target)
      continue
    }
    automaticReplacements.push({ start: target.start, end: target.end, text })
    successfulBindings.add(target.bindingName)
  }

  const skippedMarkedNames = new Set<string>()
  for (const target of failedAutomatic) {
    if (target.containingMarkedName) skippedMarkedNames.add(target.containingMarkedName)
  }

  const automaticOutput = renderReplacements(code, automaticReplacements)
  const markedReplacements: Replacement[] = []
  let markedPlan: EvaluationPlan | null = null
  try {
    markedPlan = analyzePreevalModule(automaticOutput, file, { skipMarkedNames: skippedMarkedNames })
  } catch (cause) {
    const msg = `[preeval] ${file}: ${reasonOf(cause)}`
    reportFailure(globalPolicy, msg, ctx, cause)
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

  const replacements = effectiveReplacements([
    ...automaticReplacements,
    ...markedReplacements,
  ])
  if (replacements.length === 0) return null

  const cleanup = planAutomaticImportCleanup(
    code,
    successfulBindings,
    replacements,
    file,
  )
  const s = new MagicString(code)
  for (const replacement of replacements) {
    s.overwrite(replacement.start, replacement.end, replacement.text)
  }
  for (const edit of cleanup) {
    s.overwrite(edit.start, edit.end, edit.replacement)
  }

  return {
    code: s.toString(),
    map: s.generateMap({ source: file, hires: true, includeContent: true }),
  }
}
