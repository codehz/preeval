import * as t from '@babel/types'
import type { Statement } from '@babel/types'
import type { PreevalRule } from '../../types'
import { generate } from './ast'
import { importLocalName, isTypeOnlyImportSpec } from './decls'
import type { LocalDecl, PreevalTarget } from './types'

export function allocateEvalExportNames(
  targetNames: string[],
  localDecls: Map<string, LocalDecl>,
): string[] {
  const used = new Set<string>(localDecls.keys())
  for (const n of targetNames) used.add(n)
  const out: string[] = []
  let i = 0
  for (const _ of targetNames) {
    let candidate = `__preeval_${i}`
    while (used.has(candidate)) {
      i++
      candidate = `__preeval_${i}`
    }
    used.add(candidate)
    out.push(candidate)
    i++
  }
  return out
}

export function allocateSyntheticName(base: string, used: Set<string>): string {
  let i = 0
  let candidate = base
  while (used.has(candidate)) {
    i++
    candidate = `${base}_${i}`
  }
  used.add(candidate)
  return candidate
}

export function sameFunctionRef(
  left: { from: string; import: string },
  right: { from: string; import: string },
): boolean {
  return left.from === right.from && left.import === right.import
}

export function extractStatement(stmt: Statement, closure: Set<string>): Statement | null {
  if (stmt.type === 'ImportDeclaration') {
    if (stmt.importKind === 'type') return null
    const specs = stmt.specifiers.filter((s) => {
      if (isTypeOnlyImportSpec(stmt, s)) return false
      return closure.has(importLocalName(s))
    })
    if (specs.length === 0) return null
    return t.importDeclaration(
      specs.map((s) => t.cloneNode(s, true)),
      t.cloneNode(stmt.source, true),
    )
  }

  if (stmt.type === 'ExportNamedDeclaration') {
    if (stmt.declaration) return extractStatement(stmt.declaration, closure)
    return null
  }
  if (stmt.type === 'ExportDefaultDeclaration') {
    const decl = stmt.declaration
    if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
      return extractStatement(decl, closure)
    }
    return null
  }

  if (stmt.type === 'VariableDeclaration') {
    const decls = stmt.declarations.filter(
      (d) => d.id.type === 'Identifier' && closure.has(d.id.name),
    )
    if (decls.length === 0) return null
    return t.variableDeclaration(
      stmt.kind,
      decls.map((d) => t.cloneNode(d, true)),
    )
  }

  if (stmt.type === 'FunctionDeclaration' && stmt.id && closure.has(stmt.id.name)) {
    return t.cloneNode(stmt, true)
  }
  if (stmt.type === 'ClassDeclaration' && stmt.id && closure.has(stmt.id.name)) {
    return t.cloneNode(stmt, true)
  }
  if (stmt.type === 'TSEnumDeclaration' && closure.has(stmt.id.name)) {
    return t.cloneNode(stmt, true)
  }

  return null
}

export function buildExtractedCode(
  body: Statement[],
  closure: Set<string>,
  targets: PreevalTarget[],
): string {
  const out: Statement[] = []
  for (const stmt of body) {
    const extracted = extractStatement(stmt, closure)
    if (extracted) out.push(extracted)
  }

  out.push(
    t.exportNamedDeclaration(
      null,
      targets.map((target) =>
        t.exportSpecifier(t.identifier(target.name), t.identifier(target.evalExportName)),
      ),
    ),
  )

  const file = t.file(t.program(out, [], 'module'))
  return generate(file, {
    // Compact enough for a temp module; preserve enough newlines for readable errors.
    compact: false,
    comments: false,
    jsescOption: { minimal: true },
  }).code
}

export function buildAutomaticExtractedCode(
  body: Statement[],
  closure: Set<string>,
  expression: t.CallExpression | t.TaggedTemplateExpression,
  rule: PreevalRule,
  localDecls: Map<string, LocalDecl>,
): { code: string; name: string; evalExportName: string } {
  const used = new Set(localDecls.keys())
  const resultName = allocateSyntheticName('__preeval_call', used)
  const evalExportName = allocateSyntheticName('__preeval_0', used)
  const out: Statement[] = []
  const evaluator = rule.evaluate ?? rule.match

  if (!sameFunctionRef(evaluator, rule.match)) {
    const evaluatorName = allocateSyntheticName('__preeval_evaluate', used)
    const specifier =
      evaluator.import === 'default'
        ? t.importDefaultSpecifier(t.identifier(evaluatorName))
        : t.importSpecifier(
            t.identifier(evaluatorName),
            t.isValidIdentifier(evaluator.import)
              ? t.identifier(evaluator.import)
              : t.stringLiteral(evaluator.import),
          )
    out.push(t.importDeclaration([specifier], t.stringLiteral(evaluator.from)))
    if (expression.type === 'CallExpression') expression.callee = t.identifier(evaluatorName)
    else expression.tag = t.identifier(evaluatorName)
  }

  for (const stmt of body) {
    const extracted = extractStatement(stmt, closure)
    if (extracted) out.push(extracted)
  }
  out.push(
    t.variableDeclaration('const', [t.variableDeclarator(t.identifier(resultName), expression)]),
    t.exportNamedDeclaration(null, [
      t.exportSpecifier(t.identifier(resultName), t.identifier(evalExportName)),
    ]),
  )

  const generated = generate(t.file(t.program(out, [], 'module')), {
    compact: false,
    comments: false,
    jsescOption: { minimal: true },
  }).code
  return { code: generated, name: resultName, evalExportName }
}
