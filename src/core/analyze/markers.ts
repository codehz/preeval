import type { File } from '@babel/types'
import { asConstDeclaration, assertNumber, isMarked, parseModule, traverse } from './ast'
import type { MarkedBindingTarget, RawMarkedTarget } from './types'

export function collectMarkedTargets(code: string, file: File): RawMarkedTarget[] {
  const targets: RawMarkedTarget[] = []
  for (const stmt of file.program.body) {
    const decl = asConstDeclaration(stmt)
    if (decl == null || decl.declarations.length !== 1) continue
    const d = decl.declarations[0]
    if (d === undefined || d.id.type !== 'Identifier' || d.init == null) continue
    if (!isMarked(code, file, stmt)) continue
    targets.push({
      name: d.id.name,
      initStart: assertNumber(d.init.start, 'initializer start'),
      initEnd: assertNumber(d.init.end, 'initializer end'),
      stmt,
    })
  }
  return targets
}

export function findMarkedPreevalTargets(code: string, filename?: string): MarkedBindingTarget[] {
  const file = parseModule(code, filename)
  if (file == null) return []
  return collectMarkedTargets(code, file).map(({ name, initStart, initEnd }) => ({
    name,
    initStart,
    initEnd,
  }))
}

/** Conservative identifier set used to allocate collision-free synthetic imports. */
export function collectUsedIdentifierNames(code: string, filename?: string): Set<string> {
  const file = parseModule(code, filename)
  const names = new Set<string>()
  if (file == null) return names
  traverse(file, {
    Identifier(path) {
      names.add(path.node.name)
    },
  })
  return names
}
