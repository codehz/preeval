import { parse, type ParserPlugin } from '@babel/parser'
import generateMod from '@babel/generator'
import traverseMod, { type Binding, type NodePath, type Scope } from '@babel/traverse'
import * as t from '@babel/types'
import type {
  Comment,
  File,
  ImportDeclaration,
  Statement,
  VariableDeclaration,
} from '@babel/types'
import type { PreevalRule } from '../types'

// CJS interop: Bun/Node may surface either the function or `{ default: fn }`.
const generate = (generateMod as unknown as { default?: typeof generateMod }).default ?? generateMod
const traverse = (traverseMod as unknown as { default?: typeof traverseMod }).default ?? traverseMod

/** One value exported from a temporary evaluation module. */
export interface PreevalTarget {
  /** Local binding name in the extracted module. */
  name: string
  /** Original initializer/expression span in the analyzed source string. */
  initStart: number
  initEnd: number
  /** Synthetic export name used in the extracted eval module. */
  evalExportName: string
}

/** Extracted ESM plus the targets it exports. */
export interface EvaluationPlan {
  /** Minimal ESM source that evaluates the union lexical closure. */
  code: string
  targets: PreevalTarget[]
  /** Marked targets excluded because their closure crosses runtime materialization. */
  blockedTargets?: MarkedBindingTarget[]
}

/** Lightweight marked-binding metadata, before dependency validation. */
export interface MarkedBindingTarget {
  name: string
  initStart: number
  initEnd: number
}

export interface SourceRange {
  start: number
  end: number
}

export class RuntimeBoundaryBlocked extends Error {
  constructor() {
    super('preeval: target depends on a runtime materializer boundary')
    this.name = 'RuntimeBoundaryBlocked'
  }
}

/** One direct call or tagged template matched to a configured static ESM import. */
export interface AutomaticCallTarget {
  start: number
  end: number
  line: number
  column: number
  rule: PreevalRule
  bindingName: string
  containingMarkedName?: string
}

const MARKER = '@preeval'

/** Runtime statement kinds that can define a stable local dependency. */
type DeclKind = 'const' | 'function' | 'class' | 'enum' | 'import'

interface LocalDecl {
  name: string
  kind: DeclKind
  /** Top-level statement that owns this declaration (may be an export wrapper). */
  stmt: Statement
  /** Innermost path for the binding (declarator / import spec / function / …). */
  path: NodePath
  binding: Binding | null
}

function assertNumber(pos: number | null | undefined, what: string): number {
  if (typeof pos !== 'number') {
    throw new Error(`preeval: missing ${what} position in AST`)
  }
  return pos
}

function pluginsForFilename(filename?: string): ParserPlugin[] {
  const lower = (filename ?? '').toLowerCase()
  // Enable JSX grammar only for real JSX/TSX files so angle-bracket type
  // assertions remain valid in plain `.ts` / `.mts` / `.cts`.
  if (lower.endsWith('.tsx') || lower.endsWith('.jsx')) {
    return ['typescript', 'jsx']
  }
  if (
    lower.endsWith('.ts')
    || lower.endsWith('.mts')
    || lower.endsWith('.cts')
    || lower.endsWith('.js')
    || lower.endsWith('.mjs')
    || lower.endsWith('.cjs')
  ) {
    return ['typescript']
  }
  return ['typescript']
}

function parseModule(code: string, filename?: string): File | null {
  try {
    return parse(code, {
      sourceType: 'module',
      sourceFilename: filename,
      plugins: pluginsForFilename(filename),
      attachComment: true,
    })
  } catch {
    return null
  }
}

function resolveProgramPath(file: File): NodePath<t.Program> {
  let programPath: NodePath<t.Program> | null = null
  traverse(file, {
    Program(path) {
      programPath = path
      path.stop()
    },
  })
  if (programPath == null) {
    throw new Error('preeval: failed to resolve program scope')
  }
  return programPath
}

/**
 * Find the comment immediately above `stmt` (only whitespace in between,
 * blank lines allowed, no intervening comments) and test whether it is a
 * `// @preeval` line comment.
 */
function isMarked(code: string, file: File, stmt: Statement): boolean {
  const start = assertNumber(stmt.start, 'statement start')
  const comments = file.comments ?? []
  let closest: Comment | null = null
  for (const comment of comments) {
    const end = comment.end
    if (
      typeof end === 'number'
      && end <= start
      && (closest === null || end > assertNumber(closest.end, 'comment end'))
    ) {
      closest = comment
    }
  }
  if (closest === null) return false
  if (closest.type !== 'CommentLine') return false
  if (closest.value.trim() !== MARKER) return false
  const between = code.slice(assertNumber(closest.end, 'comment end'), start)
  return /^\s*$/.test(between)
}

/** Unwrap `export …` to the inner declaration statement when present. */
function unwrapExport(stmt: Statement): Statement {
  if (
    (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration')
    && stmt.declaration != null
    && stmt.declaration.type !== 'StringLiteral'
  ) {
    return stmt.declaration as Statement
  }
  return stmt
}

/** Top-level const VariableDeclaration, including `export const`. */
function asConstDeclaration(stmt: Statement): VariableDeclaration | null {
  const inner = unwrapExport(stmt)
  if (inner.type === 'VariableDeclaration' && inner.kind === 'const') return inner
  return null
}

interface RawMarkedTarget extends MarkedBindingTarget {
  stmt: Statement
}

function collectMarkedTargets(code: string, file: File): RawMarkedTarget[] {
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

export function findMarkedPreevalTargets(
  code: string,
  filename?: string,
): MarkedBindingTarget[] {
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

/** Pure type-system nodes: traverse should skip (no runtime free refs). */
function isPureTypeNode(node: t.Node): boolean {
  switch (node.type) {
    case 'TSTypeAnnotation':
    case 'TSTypeAliasDeclaration':
    case 'TSInterfaceDeclaration':
    case 'TSTypeParameterDeclaration':
    case 'TSTypeParameterInstantiation':
    case 'TSTypeParameter':
    case 'TSDeclareFunction':
    case 'TSDeclareMethod':
    case 'TSIndexSignature':
    case 'TSPropertySignature':
    case 'TSMethodSignature':
    case 'TSCallSignatureDeclaration':
    case 'TSConstructSignatureDeclaration':
    case 'TSTypeReference':
    case 'TSImportType':
    case 'TSTypeLiteral':
    case 'TSMappedType':
    case 'TSConditionalType':
    case 'TSUnionType':
    case 'TSIntersectionType':
    case 'TSFunctionType':
    case 'TSConstructorType':
    case 'TSTupleType':
    case 'TSNamedTupleMember':
    case 'TSLiteralType':
    case 'TSIndexedAccessType':
    case 'TSOptionalType':
    case 'TSRestType':
    case 'TSThisType':
    case 'TSTypeOperator':
    case 'TSTypePredicate':
    case 'TSTypeQuery':
    case 'TSExpressionWithTypeArguments':
      return true
    default:
      return false
  }
}

/**
 * Collect program-level runtime free identifiers referenced under `root`.
 * Ambient globals (no local binding / no known top-level decl) are ignored.
 *
 * Note: `path.traverse` does not visit the root path itself, so a lone
 * Identifier initializer (e.g. `const x = y`) must be handled explicitly.
 */
function collectProgramFreeNames(
  root: NodePath,
  programScope: Scope,
  localDecls: Map<string, LocalDecl>,
): Set<string> {
  const names = new Set<string>()

  const consider = (path: NodePath<t.Identifier>): void => {
    if (!path.isReferencedIdentifier()) return
    const name = path.node.name
    const binding = path.scope.getBinding(name)
    if (binding) {
      if (binding.scope === programScope) names.add(name)
      return
    }
    // Babel does not register `enum` bindings; fall back to our decl map.
    if (localDecls.has(name)) names.add(name)
  }

  if (root.isIdentifier()) {
    consider(root as NodePath<t.Identifier>)
  }

  root.traverse({
    enter(path) {
      if (isPureTypeNode(path.node)) path.skip()
    },
    ReferencedIdentifier(path) {
      if (path.isIdentifier()) consider(path)
    },
  })
  return names
}

function importLocalName(spec: t.ImportSpecifier | t.ImportDefaultSpecifier | t.ImportNamespaceSpecifier): string {
  return spec.local.name
}

function isTypeOnlyImportSpec(
  decl: ImportDeclaration,
  spec: t.ImportSpecifier | t.ImportDefaultSpecifier | t.ImportNamespaceSpecifier,
): boolean {
  if (decl.importKind === 'type') return true
  return spec.type === 'ImportSpecifier' && spec.importKind === 'type'
}

interface MatchedImportedCall {
  rule: PreevalRule
  localName: string
}

function importedExportName(
  spec: t.ImportSpecifier | t.ImportDefaultSpecifier,
): string {
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
    spec.type !== 'ImportSpecifier'
    && spec.type !== 'ImportDefaultSpecifier'
    && spec.type !== 'ImportNamespaceSpecifier'
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
    (candidate) => candidate.match.from === decl.source.value && candidate.match.import === exportName,
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
): AutomaticCallTarget[] {
  if (rules.length === 0) return []
  const file = parseModule(code, filename)
  if (file == null) return []
  const marked = collectMarkedTargets(code, file)
  const targets: AutomaticCallTarget[] = []

  traverse(file, {
    CallExpression(path) {
      const matched = matchImportedCallee(path.node.callee, path.scope, rules)
      if (matched == null) return
      pushAutomaticTarget(path, matched, marked, targets)
    },
    TaggedTemplateExpression(path) {
      const matched = matchImportedCallee(path.node.tag, path.scope, rules)
      if (matched == null) return
      pushAutomaticTarget(path, matched, marked, targets)
    },
  })

  targets.sort((a, b) => a.start - b.start || a.end - b.end)
  return targets
}

/**
 * Index stable top-level declarations. Used both for closure roots and for
 * resolving free names that Babel scope does not track (TS enums).
 */
function indexLocalDecls(programPath: NodePath<t.Program>): Map<string, LocalDecl> {
  const map = new Map<string, LocalDecl>()
  const bodyPaths = programPath.get('body')

  for (const stmtPath of bodyPaths) {
    const stmt = stmtPath.node

    if (stmt.type === 'ImportDeclaration') {
      if (stmt.importKind === 'type') continue
      const importPath = stmtPath as NodePath<t.ImportDeclaration>
      for (const specPath of importPath.get('specifiers')) {
        const spec = specPath.node
        if (isTypeOnlyImportSpec(stmt, spec)) continue
        const name = importLocalName(spec)
        const binding = programPath.scope.getBinding(name) ?? null
        map.set(name, {
          name,
          kind: 'import',
          stmt,
          path: specPath as NodePath,
          binding,
        })
      }
      continue
    }

    // Named and default exports can wrap a local declaration with a stable id.
    const innerPath =
      (stmtPath.isExportNamedDeclaration() || stmtPath.isExportDefaultDeclaration())
      && stmtPath.node.declaration
        ? (stmtPath.get('declaration') as NodePath)
        : stmtPath
    const inner = innerPath.node

    if (inner.type === 'VariableDeclaration') {
      const declPath = innerPath as NodePath<VariableDeclaration>
      for (const dPath of declPath.get('declarations')) {
        if (dPath.node.id.type !== 'Identifier') continue
        const name = dPath.node.id.name
        const binding = programPath.scope.getBinding(name) ?? null
        map.set(name, {
          name,
          // All variable declarators share this bucket; `varKindOf` distinguishes let/var.
          kind: 'const',
          stmt,
          path: dPath,
          binding,
        })
      }
      continue
    }

    if (inner.type === 'FunctionDeclaration' && inner.id) {
      const name = inner.id.name
      map.set(name, {
        name,
        kind: 'function',
        stmt,
        path: innerPath,
        binding: programPath.scope.getBinding(name) ?? null,
      })
      continue
    }

    if (inner.type === 'ClassDeclaration' && inner.id) {
      const name = inner.id.name
      map.set(name, {
        name,
        kind: 'class',
        stmt,
        path: innerPath,
        binding: programPath.scope.getBinding(name) ?? null,
      })
      continue
    }

    if (inner.type === 'TSEnumDeclaration') {
      const name = inner.id.name
      map.set(name, {
        name,
        kind: 'enum',
        stmt,
        path: innerPath,
        binding: programPath.scope.getBinding(name) ?? null,
      })
    }
  }

  return map
}

function varKindOf(decl: LocalDecl): 'const' | 'let' | 'var' | null {
  if (!decl.path.isVariableDeclarator()) return null
  const parent = decl.path.parent
  if (parent.type !== 'VariableDeclaration') return null
  return parent.kind === 'const' || parent.kind === 'let' || parent.kind === 'var'
    ? parent.kind
    : null
}

function validateStableDep(decl: LocalDecl): void {
  const { name, kind, binding, path } = decl

  if (kind === 'import') {
    return
  }

  if (kind === 'function' || kind === 'class' || kind === 'enum') {
    if (binding && !binding.constant) {
      throw new Error(
        `preeval: binding "${name}" is reassigned; only stable bindings are supported as dependencies`,
      )
    }
    return
  }

  // const / let / var declarator
  const varKind = varKindOf(decl)
  if (varKind === 'let' || varKind === 'var') {
    throw new Error(
      `preeval: dependency "${name}" is declared with ${varKind}; only const/function/class/enum/import are supported`,
    )
  }
  if (varKind !== 'const') {
    throw new Error(`preeval: unsupported dependency binding "${name}"`)
  }
  if (!path.isVariableDeclarator()) {
    throw new Error(`preeval: unsupported dependency binding "${name}"`)
  }
  if (path.node.id.type !== 'Identifier') {
    throw new Error(`preeval: destructuring dependency "${name}" is not supported`)
  }
  if (path.node.init == null) {
    throw new Error(`preeval: dependency "${name}" has no initializer`)
  }
  if (binding && !binding.constant) {
    throw new Error(
      `preeval: binding "${name}" is reassigned; only stable bindings are supported as dependencies`,
    )
  }
}

/** Free program names required to evaluate a local declaration. */
function depsOfDecl(
  decl: LocalDecl,
  programScope: Scope,
  localDecls: Map<string, LocalDecl>,
): Set<string> {
  if (decl.kind === 'import') return new Set()

  if (decl.path.isVariableDeclarator()) {
    const init = decl.path.get('init')
    if (!init.node) return new Set()
    assertNoImportMeta(init as NodePath)
    return collectProgramFreeNames(init as NodePath, programScope, localDecls)
  }

  // function / class / enum — whole declaration body
  assertNoImportMeta(decl.path)
  return collectProgramFreeNames(decl.path, programScope, localDecls)
}

/** Reject `import.meta` anywhere under a closure root (eval temp path would leak). */
function assertNoImportMeta(root: NodePath): void {
  const reject = (node: t.MetaProperty): void => {
    if (node.meta.name === 'import' && node.property.name === 'meta') {
      throw new Error(
        'preeval: import.meta is not supported in pre-eval closures; refusing to extract',
      )
    }
  }

  if (root.isMetaProperty()) {
    reject(root.node)
    return
  }

  root.traverse({
    enter(path) {
      if (isPureTypeNode(path.node)) path.skip()
    },
    MetaProperty(path) {
      reject(path.node)
    },
  })
}


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

/**
 * Function/class declarations (incl. `export` wrappers) are hoisted, so a body
 * that touches the closure can run via a pre-target call even when the decl
 * text sits after every marked const.
 */
function isHoistableDeclaration(stmt: Statement): boolean {
  return hoistableName(stmt) != null
}

function hoistableName(stmt: Statement): string | null {
  const inner = unwrapExport(stmt)
  if (inner.type === 'FunctionDeclaration' && inner.id) return inner.id.name
  if (inner.type === 'ClassDeclaration' && inner.id) return inner.id.name
  return null
}

/** Lexical dependency closure for one or more root binding names. */
function buildNameClosure(
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

function nodeTouchesRanges(node: t.Node, ranges: readonly SourceRange[]): boolean {
  const start = node.start
  const end = node.end
  if (typeof start !== 'number' || typeof end !== 'number') return false
  return ranges.some((range) => start < range.end && range.start < end)
}

function closureTouchesRanges(
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

function collectWrittenProgramNames(
  root: NodePath,
  programScope: Scope,
  localDecls: Map<string, LocalDecl>,
): Set<string> {
  const names = new Set<string>()
  root.traverse({
    enter(path) {
      if (isPureTypeNode(path.node)) path.skip()
    },
    AssignmentExpression(path) {
      for (const n of writtenProgramNames(path.node.left, programScope, localDecls)) {
        names.add(n)
      }
    },
    UpdateExpression(path) {
      for (const n of writtenProgramNames(path.node.argument, programScope, localDecls)) {
        names.add(n)
      }
    },
  })
  return names
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
function assertNoInterferingStatements(
  programPath: NodePath<t.Program>,
  targets: { name: string; stmt: Statement }[],
  closure: Set<string>,
  localDecls: Map<string, LocalDecl>,
  perTargetClosures: Map<string, Set<string>>,
): void {
  const programScope = programPath.scope
  const targetStarts = targets.map((t) => assertNumber(t.stmt.start, 'target start'))
  const closureHasImports = [...closure].some((n) => localDecls.get(n)?.kind === 'import')

  // Non-closure hoistables: body effects matter only if a call site reaches them.
  const hoistables = new Map<
    string,
    { path: NodePath; free: Set<string>; written: Set<string> }
  >()
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
      beforeAnyTarget
      && stmt.type === 'ImportDeclaration'
      && stmt.importKind !== 'type'
      && closureHasImports
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


function writtenProgramNames(
  node: t.LVal | t.Expression | t.OptionalMemberExpression,
  programScope: Scope,
  localDecls: Map<string, LocalDecl>,
): string[] {
  if (t.isIdentifier(node)) {
    const binding = programScope.getBinding(node.name)
    if (binding && binding.scope === programScope) return [node.name]
    if (localDecls.has(node.name)) return [node.name]
    return []
  }
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    let obj: t.Expression | t.Super = node.object
    while (t.isMemberExpression(obj) || t.isOptionalMemberExpression(obj)) {
      obj = obj.object
    }
    if (t.isIdentifier(obj)) {
      const binding = programScope.getBinding(obj.name)
      if (binding && binding.scope === programScope) return [obj.name]
      if (localDecls.has(obj.name)) return [obj.name]
    }
  }
  if (t.isRestElement(node) && t.isIdentifier(node.argument)) {
    return writtenProgramNames(node.argument, programScope, localDecls)
  }
  if (t.isAssignmentPattern(node)) {
    return writtenProgramNames(node.left, programScope, localDecls)
  }
  return []
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
function isBindingOwnedByPayload(binding: Binding, payloadPath: NodePath): boolean {
  let path: NodePath | null = binding.path
  while (path != null) {
    if (path === payloadPath) return true
    path = path.parentPath
  }
  return false
}

function assertAutomaticPayloadDependencies(
  payloadPath: NodePath,
  programScope: Scope,
): void {
  const rejectLocal = (path: NodePath<t.Identifier>): void => {
    if (!path.isReferencedIdentifier()) return
    if (path.node.name === 'arguments') {
      throw new Error('preeval: automatic call arguments cannot depend on arguments')
    }
    const binding = path.scope.getBinding(path.node.name)
    if (
      binding != null
      && binding.scope !== programScope
      && !isBindingOwnedByPayload(binding, payloadPath)
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

function containingTopLevelStatement(path: NodePath): Statement {
  let current = path
  while (current.parentPath != null && !current.parentPath.isProgram()) {
    current = current.parentPath
  }
  if (!t.isStatement(current.node)) {
    throw new Error('preeval: automatic call is not contained in a module statement')
  }
  return current.node
}

function allocateEvalExportNames(
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

function extractStatement(stmt: Statement, closure: Set<string>): Statement | null {
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

function buildExtractedCode(
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
        t.exportSpecifier(
          t.identifier(target.name),
          t.identifier(target.evalExportName),
        ),
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

function allocateSyntheticName(base: string, used: Set<string>): string {
  let i = 0
  let candidate = base
  while (used.has(candidate)) {
    i++
    candidate = `${base}_${i}`
  }
  used.add(candidate)
  return candidate
}

function sameFunctionRef(
  left: { from: string; import: string },
  right: { from: string; import: string },
): boolean {
  return left.from === right.from && left.import === right.import
}

function buildAutomaticExtractedCode(
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
    const specifier = evaluator.import === 'default'
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
    t.variableDeclaration('const', [
      t.variableDeclarator(t.identifier(resultName), expression),
    ]),
    t.exportNamedDeclaration(
      null,
      [t.exportSpecifier(t.identifier(resultName), t.identifier(evalExportName))],
    ),
  )

  const generated = generate(t.file(t.program(out, [], 'module')), {
    compact: false,
    comments: false,
    jsescOption: { minimal: true },
  }).code
  return { code: generated, name: resultName, evalExportName }
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
  options?: { runtimeBoundaries?: readonly SourceRange[] },
): EvaluationPlan {
  const file = parseModule(code, filename)
  if (file == null) throw new Error('preeval: failed to parse module for automatic call')
  const programPath = resolveProgramPath(file)
  const programScope = programPath.scope
  const localDecls = indexLocalDecls(programPath)
  let targetPath: NodePath<t.CallExpression | t.TaggedTemplateExpression> | null = null
  let matched: MatchedImportedCall | null = null

  programPath.traverse({
    CallExpression(path) {
      if (path.node.start !== targetStart) return
      const candidate = matchImportedCallee(path.node.callee, path.scope, [rule])
      if (candidate == null) return
      targetPath = path
      matched = candidate
      path.stop()
    },
    TaggedTemplateExpression(path) {
      if (path.node.start !== targetStart) return
      const candidate = matchImportedCallee(path.node.tag, path.scope, [rule])
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
    options?.runtimeBoundaries?.length
    && closureTouchesRanges(
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
    targets: [{
      name: built.name,
      initStart: assertNumber(expressionPath.node.start, 'call start'),
      initEnd: assertNumber(expressionPath.node.end, 'call end'),
      evalExportName: built.evalExportName,
    }],
  }
}

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
      options?.runtimeBoundaries?.length
      && closureTouchesRanges([], targetClosure, localDecls, options.runtimeBoundaries)
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

  assertNoInterferingStatements(
    pPath,
    rawTargets,
    closure,
    localDecls,
    perTargetClosures,
  )

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

export interface SourceEdit {
  start: number
  end: number
  replacement: string
}

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
      const hasRuntimeReference = binding?.referencePaths.some(
        (reference) =>
          !isTypeOnlyReference(reference)
          && !isInsideAnyRange(reference, replacementRanges),
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
