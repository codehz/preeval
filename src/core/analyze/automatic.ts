import { EXACT_SPECIFIER_MATCHER, type SpecifierMatcher } from '../resolve'
import type { Binding, NodePath, Scope } from '@babel/traverse'
import * as t from '@babel/types'
import type { PreevalRule } from '../../types'
import { assertNumber, isPureTypeNode, parseModule, resolveProgramPath, traverse } from './ast'
import { buildNameClosure, assertNoInterferingStatements, closureTouchesRanges } from './closure'
import { collectProgramFreeNames, indexLocalDecls, isTypeOnlyImportSpec } from './decls'
import { buildAutomaticExtractedCode, sameFunctionRef } from './extract'
import { collectMarkedTargets } from './markers'
import type {
  AutomaticCallTarget,
  EvaluationPlan,
  MatchedImportedCall,
  RawMarkedTarget,
  SourceRange,
} from './types'
import { RuntimeBoundaryBlocked } from './types'

function importedExportName(spec: t.ImportSpecifier | t.ImportDefaultSpecifier): string {
  if (spec.type === 'ImportDefaultSpecifier') return 'default'
  return spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value
}

function staticMemberName(member: t.MemberExpression): string | null {
  if (!member.computed && member.property.type === 'Identifier') {
    return member.property.name
  }
  if (member.computed && member.property.type === 'StringLiteral') {
    return member.property.value
  }
  return null
}

function matchImportedCallee(
  callee: t.Node,
  scope: Scope,
  rules: readonly PreevalRule[],
  specifierMatcher: SpecifierMatcher,
): MatchedImportedCall | null {
  let localName: string
  let exportName: string
  let requireNamespace = false

  if (callee.type === 'Identifier') {
    localName = callee.name
  } else if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier') {
    const memberName = staticMemberName(callee)
    if (memberName == null) return null
    localName = callee.object.name
    exportName = memberName
    requireNamespace = true
  } else {
    return null
  }

  const binding = scope.getBinding(localName)
  if (binding == null) return null
  const spec = binding.path.node
  if (
    spec.type !== 'ImportSpecifier' &&
    spec.type !== 'ImportDefaultSpecifier' &&
    spec.type !== 'ImportNamespaceSpecifier'
  ) {
    return null
  }
  const decl = binding.path.parentPath?.node
  if (decl?.type !== 'ImportDeclaration' || isTypeOnlyImportSpec(decl, spec)) return null

  if (requireNamespace) {
    if (spec.type !== 'ImportNamespaceSpecifier') return null
  } else {
    if (spec.type === 'ImportNamespaceSpecifier') return null
    exportName = importedExportName(spec)
  }

  const rule = rules.find(
    (candidate) =>
      specifierMatcher.matchesSource(decl.source.value, candidate.match.from) &&
      candidate.match.import === exportName,
  )
  return rule ? { rule, localName } : null
}

function pushAutomaticTarget(
  path: NodePath,
  matched: MatchedImportedCall,
  marked: RawMarkedTarget[],
  targets: AutomaticCallTarget[],
): void {
  const start = assertNumber(path.node.start, 'call start')
  const end = assertNumber(path.node.end, 'call end')
  const loc = path.node.loc?.start
  const containingMarked = marked.find(
    (target) => target.initStart <= start && end <= target.initEnd,
  )
  targets.push({
    start,
    end,
    line: loc?.line ?? 1,
    column: loc?.column ?? 0,
    rule: matched.rule,
    bindingName: matched.localName,
    ...(containingMarked ? { containingMarkedName: containingMarked.name } : {}),
  })
}

export function findAutomaticPreevalCalls(
  code: string,
  rules: readonly PreevalRule[],
  filename?: string,
  specifierMatcher: SpecifierMatcher = EXACT_SPECIFIER_MATCHER,
): AutomaticCallTarget[] {
  if (rules.length === 0) return []
  const file = parseModule(code, filename)
  if (file == null) return []
  const marked = collectMarkedTargets(code, file)
  const targets: AutomaticCallTarget[] = []

  traverse(file, {
    CallExpression(path) {
      const matched = matchImportedCallee(path.node.callee, path.scope, rules, specifierMatcher)
      if (matched == null) return
      pushAutomaticTarget(path, matched, marked, targets)
    },
    TaggedTemplateExpression(path) {
      const matched = matchImportedCallee(path.node.tag, path.scope, rules, specifierMatcher)
      if (matched == null) return
      pushAutomaticTarget(path, matched, marked, targets)
    },
  })

  return targets.toSorted((a, b) => a.start - b.start || a.end - b.end)
}

function isBindingOwnedByPayload(binding: Binding, payloadPath: NodePath): boolean {
  let path: NodePath | null = binding.path
  while (path != null) {
    if (path === payloadPath) return true
    path = path.parentPath
  }
  return false
}

function assertAutomaticPayloadDependencies(payloadPath: NodePath, programScope: Scope): void {
  const rejectLocal = (path: NodePath<t.Identifier>): void => {
    if (!path.isReferencedIdentifier()) return
    if (path.node.name === 'arguments') {
      throw new Error('preeval: automatic call arguments cannot depend on arguments')
    }
    const binding = path.scope.getBinding(path.node.name)
    if (
      binding != null &&
      binding.scope !== programScope &&
      !isBindingOwnedByPayload(binding, payloadPath)
    ) {
      throw new Error(
        `preeval: automatic call depends on function-local binding "${path.node.name}"`,
      )
    }
  }

  const rejectSpecial = (path: NodePath): void => {
    if (path.isThisExpression()) {
      throw new Error('preeval: automatic call arguments cannot depend on this')
    }
    if (path.isSuper()) {
      throw new Error('preeval: automatic call arguments cannot depend on super')
    }
    if (path.isMetaProperty()) {
      const label = `${path.node.meta.name}.${path.node.property.name}`
      if (label === 'import.meta' || label === 'new.target') {
        throw new Error(`preeval: automatic call arguments cannot depend on ${label}`)
      }
    }
  }

  if (payloadPath.isIdentifier()) rejectLocal(payloadPath as NodePath<t.Identifier>)
  rejectSpecial(payloadPath)

  payloadPath.traverse({
    enter(path) {
      if (isPureTypeNode(path.node)) path.skip()
    },
    ReferencedIdentifier(path) {
      if (path.isIdentifier()) rejectLocal(path)
    },
    ThisExpression(path) {
      rejectSpecial(path)
    },
    Super(path) {
      rejectSpecial(path)
    },
    MetaProperty(path) {
      rejectSpecial(path)
    },
  })
}

function containingTopLevelStatement(path: NodePath): t.Statement {
  let current = path
  while (current.parentPath != null && !current.parentPath.isProgram()) {
    current = current.parentPath
  }
  if (!t.isStatement(current.node)) {
    throw new Error('preeval: automatic call is not contained in a module statement')
  }
  return current.node
}

function automaticExpressionPayloadPaths(
  path: NodePath<t.CallExpression | t.TaggedTemplateExpression>,
): NodePath[] {
  if (path.isCallExpression()) {
    return path.get('arguments') as NodePath[]
  }
  return path.get('quasi').get('expressions') as NodePath[]
}

export function analyzeAutomaticPreevalCall(
  code: string,
  targetStart: number,
  rule: PreevalRule,
  filename?: string,
  options?: {
    runtimeBoundaries?: readonly SourceRange[]
    specifierMatcher?: SpecifierMatcher
  },
): EvaluationPlan {
  const file = parseModule(code, filename)
  if (file == null) throw new Error('preeval: failed to parse module for automatic call')
  const programPath = resolveProgramPath(file)
  const programScope = programPath.scope
  const localDecls = indexLocalDecls(programPath)
  const specifierMatcher = options?.specifierMatcher ?? EXACT_SPECIFIER_MATCHER
  let targetPath: NodePath<t.CallExpression | t.TaggedTemplateExpression> | null = null
  let matched: MatchedImportedCall | null = null

  programPath.traverse({
    CallExpression(path) {
      if (path.node.start !== targetStart) return
      const candidate = matchImportedCallee(path.node.callee, path.scope, [rule], specifierMatcher)
      if (candidate == null) return
      targetPath = path
      matched = candidate
      path.stop()
    },
    TaggedTemplateExpression(path) {
      if (path.node.start !== targetStart) return
      const candidate = matchImportedCallee(path.node.tag, path.scope, [rule], specifierMatcher)
      if (candidate == null) return
      targetPath = path
      matched = candidate
      path.stop()
    },
  })
  if (targetPath == null || matched == null) {
    throw new Error(`preeval: configured imported call was not found at offset ${targetStart}`)
  }

  // Re-bind after traverse so control-flow narrowing survives the mutation above.
  const expressionPath: NodePath<t.CallExpression | t.TaggedTemplateExpression> = targetPath
  const callMatch: MatchedImportedCall = matched
  const roots = new Set<string>()
  for (const payloadPath of automaticExpressionPayloadPaths(expressionPath)) {
    assertAutomaticPayloadDependencies(payloadPath, programScope)
    for (const name of collectProgramFreeNames(payloadPath, programScope, localDecls)) {
      roots.add(name)
    }
  }
  if (sameFunctionRef(rule.evaluate ?? rule.match, rule.match)) roots.add(callMatch.localName)

  const closure = buildNameClosure(roots, programScope, localDecls)
  if (
    options?.runtimeBoundaries?.length &&
    closureTouchesRanges(
      automaticExpressionPayloadPaths(expressionPath),
      closure,
      localDecls,
      options.runtimeBoundaries,
    )
  ) {
    throw new RuntimeBoundaryBlocked()
  }
  const stmt = containingTopLevelStatement(expressionPath)
  const syntheticTarget = '__preeval_automatic_target'
  assertNoInterferingStatements(
    programPath,
    [{ name: syntheticTarget, stmt }],
    closure,
    localDecls,
    new Map([[syntheticTarget, closure]]),
  )

  const expression = t.cloneNode(expressionPath.node, true)
  const built = buildAutomaticExtractedCode(
    file.program.body,
    closure,
    expression,
    rule,
    localDecls,
  )
  return {
    code: built.code,
    targets: [
      {
        name: built.name,
        initStart: assertNumber(expressionPath.node.start, 'call start'),
        initEnd: assertNumber(expressionPath.node.end, 'call end'),
        evalExportName: built.evalExportName,
      },
    ],
  }
}
