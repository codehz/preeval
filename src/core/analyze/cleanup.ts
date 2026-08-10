import type { NodePath } from '@babel/traverse'
import * as t from '@babel/types'
import { assertNumber, generate, isPureTypeNode, parseModule, resolveProgramPath } from './ast'
import { isTypeOnlyImportSpec } from './decls'
import type { SourceEdit } from './types'

function isTypeOnlyReference(path: NodePath): boolean {
  let current: NodePath | null = path
  while (current != null && !current.isStatement()) {
    if (isPureTypeNode(current.node)) return true
    current = current.parentPath
  }
  return false
}

function isInsideAnyRange(
  path: NodePath,
  ranges: readonly { start: number; end: number }[],
): boolean {
  const start = path.node.start
  const end = path.node.end
  if (typeof start !== 'number' || typeof end !== 'number') return false
  return ranges.some((range) => range.start <= start && end <= range.end)
}

export function planAutomaticImportCleanup(
  code: string,
  successfulBindings: ReadonlySet<string>,
  replacementRanges: readonly { start: number; end: number }[],
  filename?: string,
): SourceEdit[] {
  if (successfulBindings.size === 0) return []
  const file = parseModule(code, filename)
  if (file == null) return []
  const programPath = resolveProgramPath(file)
  const edits: SourceEdit[] = []

  for (const stmtPath of programPath.get('body')) {
    if (!stmtPath.isImportDeclaration()) continue
    const decl = stmtPath.node
    const kept: typeof decl.specifiers = []
    let changed = false

    for (const spec of decl.specifiers) {
      const localName = spec.local.name
      if (!successfulBindings.has(localName) || isTypeOnlyImportSpec(decl, spec)) {
        kept.push(spec)
        continue
      }

      const binding = programPath.scope.getBinding(localName)
      const hasRuntimeReference =
        binding?.referencePaths.some(
          (reference) =>
            !isTypeOnlyReference(reference) && !isInsideAnyRange(reference, replacementRanges),
        ) ?? false
      if (hasRuntimeReference) {
        kept.push(spec)
      } else {
        changed = true
      }
    }

    if (!changed) continue
    const start = assertNumber(decl.start, 'import start')
    const end = assertNumber(decl.end, 'import end')
    if (kept.length === 0) {
      edits.push({ start, end, replacement: '' })
      continue
    }
    const replacement = generate(
      t.importDeclaration(
        kept.map((spec) => t.cloneNode(spec, true)),
        t.cloneNode(decl.source, true),
      ),
      { compact: false, comments: false, jsescOption: { minimal: true } },
    ).code
    edits.push({ start, end, replacement })
  }

  return edits
}
