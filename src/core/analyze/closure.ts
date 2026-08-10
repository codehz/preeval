import type { NodePath, Scope } from '@babel/traverse'
import type { Statement } from '@babel/types'
import * as t from '@babel/types'
import { assertNumber, unwrapExport } from './ast'
import {
  collectProgramFreeNames,
  collectWrittenProgramNames,
  depsOfDecl,
  hoistableName,
  importLocalName,
  isHoistableDeclaration,
  isTypeOnlyImportSpec,
  validateStableDep,
} from './decls'
import type { LocalDecl, SourceRange } from './types'

/**
 * Names of sibling declarators in the same VariableDeclaration as `name`
 * that are not yet in the closure (must be pulled for left-to-right init order).
 */
function unselectedSiblingDeclarators(
  name: string,
  localDecls: Map<string, LocalDecl>,
  closure: Set<string>,
): string[] {
  const decl = localDecls.get(name)
  if (decl == null || !decl.path.isVariableDeclarator()) return []
  const parent = decl.path.parent
  if (parent.type !== 'VariableDeclaration') return []
  const out: string[] = []
  for (const d of parent.declarations) {
    if (d.id.type !== 'Identifier') continue
    if (d.id.name === name) continue
    if (closure.has(d.id.name)) continue
    out.push(d.id.name)
  }
  return out
}

/** Lexical dependency closure for one or more root binding names. */
export function buildNameClosure(
  roots: Iterable<string>,
  programScope: Scope,
  localDecls: Map<string, LocalDecl>,
): Set<string> {
  const closure = new Set<string>()
  const queue = [...roots]

  while (queue.length > 0) {
    const name = queue.pop()!
    if (closure.has(name)) continue
    closure.add(name)

    const decl = localDecls.get(name)
    if (decl == null) {
      throw new Error(
        `preeval: unresolved dependency "${name}" (only top-level const/function/class/enum/import are supported)`,
      )
    }
    validateStableDep(decl)

    for (const dep of depsOfDecl(decl, programScope, localDecls)) {
      if (!closure.has(dep)) queue.push(dep)
    }
    for (const sibling of unselectedSiblingDeclarators(name, localDecls, closure)) {
      queue.push(sibling)
    }
  }

  return closure
}

export function nodeTouchesRanges(node: t.Node, ranges: readonly SourceRange[]): boolean {
  const start = node.start
  const end = node.end
  if (typeof start !== 'number' || typeof end !== 'number') return false
  return ranges.some((range) => start < range.end && range.start < end)
}

export function closureTouchesRanges(
  roots: readonly NodePath[],
  closure: ReadonlySet<string>,
  localDecls: Map<string, LocalDecl>,
  ranges: readonly SourceRange[],
): boolean {
  if (roots.some((root) => nodeTouchesRanges(root.node, ranges))) return true
  for (const name of closure) {
    const decl = localDecls.get(name)
    if (decl && nodeTouchesRanges(decl.path.node, ranges)) return true
  }
  return false
}

/** Union of per-target closures for targets whose statement starts after `stmtStart`. */
function remainingClosureNames(
  stmtStart: number,
  targets: { name: string; stmt: Statement }[],
  perTargetClosures: Map<string, Set<string>>,
): Set<string> {
  const names = new Set<string>()
  for (const target of targets) {
    const targetStart = assertNumber(target.stmt.start, 'target start')
    if (stmtStart >= targetStart) continue
    const sub = perTargetClosures.get(target.name)
    if (sub == null) continue
    for (const n of sub) names.add(n)
  }
  return names
}

function statementCoveredByClosure(stmt: Statement, closure: Set<string>): boolean {
  if (stmt.type === 'ImportDeclaration') {
    if (stmt.importKind === 'type') return true // irrelevant
    if (stmt.specifiers.length === 0) return false
    return stmt.specifiers.every((s) => {
      if (isTypeOnlyImportSpec(stmt, s)) return true
      return closure.has(importLocalName(s))
    })
  }

  const inner = unwrapExport(stmt)

  if (inner.type === 'VariableDeclaration') {
    const ids = inner.declarations
      .filter((d): d is typeof d & { id: t.Identifier } => d.id.type === 'Identifier')
      .map((d) => d.id.name)

    if (ids.length === 0) return false
    return ids.every((n) => closure.has(n))
  }
  if (inner.type === 'FunctionDeclaration' && inner.id) return closure.has(inner.id.name)
  if (inner.type === 'ClassDeclaration' && inner.id) return closure.has(inner.id.name)
  if (inner.type === 'TSEnumDeclaration') return closure.has(inner.id.name)

  // bare export lists / types / etc. are not executable value producers in the closure
  if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration == null) return true
  if (stmt.type === 'TSTypeAliasDeclaration' || stmt.type === 'TSInterfaceDeclaration') return true

  return false
}

/**
 * Reject non-closure top-level effects that can change a not-yet-evaluated
 * target's value when skipped by extraction.
 *
 * - Statements are checked only against the **remaining** targets (source
 *   position after the statement) — multi-mark reads of already-evaluated
 *   deps are allowed (D7).
 * - Non-closure function/class declarations are not rejected merely for
 *   referencing the closure; they are rejected only when a pre-remaining-target
 *   call site can reach them (D6).
 */
export function assertNoInterferingStatements(
  programPath: NodePath<t.Program>,
  targets: { name: string; stmt: Statement }[],
  closure: Set<string>,
  localDecls: Map<string, LocalDecl>,
  perTargetClosures: Map<string, Set<string>>,
): void {
  const programScope = programPath.scope
  const targetStarts = targets.map((target) => assertNumber(target.stmt.start, 'target start'))
  const closureHasImports = [...closure].some((n) => localDecls.get(n)?.kind === 'import')

  // Non-closure hoistables: body effects matter only if a call site reaches them.
  const hoistables = new Map<string, { path: NodePath; free: Set<string>; written: Set<string> }>()
  for (const stmtPath of programPath.get('body')) {
    const name = hoistableName(stmtPath.node)
    if (name == null || closure.has(name)) continue
    hoistables.set(name, {
      path: stmtPath,
      free: collectProgramFreeNames(stmtPath, programScope, localDecls),
      written: collectWrittenProgramNames(stmtPath, programScope, localDecls),
    })
  }
  const hoistableNames = new Set(hoistables.keys())

  const callEdges = new Map<string, Set<string>>()
  for (const [name, info] of hoistables) {
    const callees = new Set<string>()
    for (const free of info.free) {
      if (hoistableNames.has(free) && free !== name) callees.add(free)
    }
    callEdges.set(name, callees)
  }

  const reachableHoistables = (roots: Iterable<string>): Set<string> => {
    const seen = new Set<string>()
    const queue = [...roots]
    while (queue.length > 0) {
      const name = queue.pop()!
      if (seen.has(name) || !hoistables.has(name)) continue
      seen.add(name)
      for (const callee of callEdges.get(name) ?? []) {
        if (!seen.has(callee)) queue.push(callee)
      }
    }
    return seen
  }

  const throwIfTouches = (
    names: Iterable<string>,
    remaining: Set<string>,
    kind: 'read' | 'write' | 'hoisted',
  ): void => {
    for (const name of names) {
      if (!remaining.has(name)) continue
      if (kind === 'write') {
        throw new Error(
          `preeval: assignment to closure binding "${name}" before a marked const; refusing to extract`,
        )
      }
      if (kind === 'hoisted') {
        throw new Error(
          `preeval: hoisted declaration references closure binding "${name}"; refusing to extract (call sites before a marked const could observe mutations)`,
        )
      }
      throw new Error(
        `preeval: statement before marked const references closure binding "${name}"; refusing to extract (would skip intervening effects)`,
      )
    }
  }

  for (const stmtPath of programPath.get('body')) {
    const stmt = stmtPath.node
    const stmtStart = assertNumber(stmt.start, 'statement start')
    const beforeAnyTarget = targetStarts.some((ts) => stmtStart < ts)
    const remaining = remainingClosureNames(stmtStart, targets, perTargetClosures)

    // Statements fully covered by the joint closure are emitted and run in order.
    if (statementCoveredByClosure(stmt, closure)) continue

    // Side-effect imports (`import './x'` or only type specs) are dropped from
    // the extract. If the closure still pulls value imports, those modules may
    // have been mutated by the skipped side-effect import — refuse.
    if (
      beforeAnyTarget &&
      stmt.type === 'ImportDeclaration' &&
      stmt.importKind !== 'type' &&
      closureHasImports
    ) {
      const runtimeSpecs = stmt.specifiers.filter((s) => !isTypeOnlyImportSpec(stmt, s))
      if (runtimeSpecs.length === 0) {
        throw new Error(
          'preeval: side-effect import before marked const may mutate closure bindings; refusing to extract',
        )
      }
    }

    // Decl bodies are checked via call-site reachability (D6), not declaration text.
    if (isHoistableDeclaration(stmt)) continue

    // Nothing left to evaluate after this statement → cannot affect any target init.
    if (remaining.size === 0) continue

    const free = collectProgramFreeNames(stmtPath, programScope, localDecls)
    throwIfTouches(free, remaining, 'read')

    const written = collectWrittenProgramNames(stmtPath, programScope, localDecls)
    throwIfTouches(written, remaining, 'write')

    // Potential invokes of non-closure hoistables (free ref is a conservative proxy).
    const roots: string[] = []
    for (const name of free) {
      if (hoistableNames.has(name)) roots.push(name)
    }
    if (roots.length === 0) continue

    for (const fn of reachableHoistables(roots)) {
      const info = hoistables.get(fn)
      if (info == null) continue
      throwIfTouches(info.free, remaining, 'hoisted')
      throwIfTouches(info.written, remaining, 'write')
    }
  }
}
