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

// CJS interop: Bun/Node may surface either the function or `{ default: fn }`.
const generate = (generateMod as unknown as { default?: typeof generateMod }).default ?? generateMod
const traverse = (traverseMod as unknown as { default?: typeof traverseMod }).default ?? traverseMod

/** One marked top-level const to pre-evaluate. */
export interface PreevalTarget {
  /** Local binding name in the original module. */
  name: string
  /** Original initializer span in the source string. */
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
      consider(path)
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
      for (const specPath of stmtPath.get('specifiers')) {
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
  return parent.kind
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
  const inner = unwrapExport(stmt)
  return (
    (inner.type === 'FunctionDeclaration' && inner.id != null)
    || (inner.type === 'ClassDeclaration' && inner.id != null)
  )
}

/**
 * Reject non-closure top-level statements that run before a target and touch
 * the closure (reads or writes). Skipping them would change evaluation order.
 * Hoisted function/class declarations are scanned file-wide for the same reason.
 */
function assertNoInterferingStatements(
  programPath: NodePath<t.Program>,
  targets: { name: string; stmt: Statement }[],
  closure: Set<string>,
  localDecls: Map<string, LocalDecl>,
): void {
  const programScope = programPath.scope
  const targetStarts = targets.map((t) => assertNumber(t.stmt.start, 'target start'))
  const closureHasImports = [...closure].some((n) => localDecls.get(n)?.kind === 'import')

  for (const stmtPath of programPath.get('body')) {
    const stmt = stmtPath.node
    const stmtStart = assertNumber(stmt.start, 'statement start')
    const beforeAnyTarget = targetStarts.some((ts) => stmtStart < ts)
    const hoistable = isHoistableDeclaration(stmt)

    // Post-target non-hoisted statements cannot affect target initializers.
    if (!beforeAnyTarget && !hoistable) continue

    // Statements fully covered by the closure are emitted and run in order.
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

    const free = collectProgramFreeNames(stmtPath, programScope, localDecls)
    for (const name of free) {
      if (closure.has(name)) {
        throw new Error(
          hoistable && !beforeAnyTarget
            ? `preeval: hoisted declaration references closure binding "${name}"; refusing to extract (call sites before a marked const could observe mutations)`
            : `preeval: statement before marked const references closure binding "${name}"; refusing to extract (would skip intervening effects)`,
        )
      }
    }

    // Assignment targets are not always "referenced"; only matters for code that
    // actually runs before a target (hoisted decl bodies already covered above).
    if (!beforeAnyTarget) continue

    stmtPath.traverse({
      enter(path) {
        if (isPureTypeNode(path.node)) path.skip()
      },
      AssignmentExpression(path) {
        const left = path.node.left
        const written = writtenProgramNames(left, programScope, localDecls)
        for (const name of written) {
          if (closure.has(name)) {
            throw new Error(
              `preeval: assignment to closure binding "${name}" before a marked const; refusing to extract`,
            )
          }
        }
      },
      UpdateExpression(path) {
        const written = writtenProgramNames(path.node.argument, programScope, localDecls)
        for (const name of written) {
          if (closure.has(name)) {
            throw new Error(
              `preeval: update of closure binding "${name}" before a marked const; refusing to extract`,
            )
          }
        }
      },
    })
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
    if (stmt.declaration && (stmt.declaration as Statement).type) {
      const decl = stmt.declaration
      if (
        decl.type === 'FunctionDeclaration'
        || decl.type === 'ClassDeclaration'
        || decl.type === 'TSEnumDeclaration'
        || decl.type === 'VariableDeclaration'
      ) {
        return extractStatement(decl as Statement, closure)
      }
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
): EvaluationPlan | null {
  let file: File
  try {
    file = parse(code, {
      sourceType: 'module',
      sourceFilename: filename,
      plugins: pluginsForFilename(filename),
      // Needed so comment ranges are attached for marker detection.
      attachComment: true,
    })
  } catch {
    return null
  }

  const rawTargets: { name: string; initStart: number; initEnd: number; stmt: Statement }[] = []

  for (const stmt of file.program.body) {
    const decl = asConstDeclaration(stmt)
    if (decl == null) continue
    // Targets: single declarator, Identifier, has initializer.
    if (decl.declarations.length !== 1) continue
    const d = decl.declarations[0]
    if (d === undefined || d.id.type !== 'Identifier' || d.init == null) continue
    if (!isMarked(code, file, stmt)) continue
    rawTargets.push({
      name: d.id.name,
      initStart: assertNumber(d.init.start, 'initializer start'),
      initEnd: assertNumber(d.init.end, 'initializer end'),
      stmt,
    })
  }

  if (rawTargets.length === 0) return null

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
  // TS does not narrow outer lets assigned in closures.
  const pPath: NodePath<t.Program> = programPath
  const programScope = pPath.scope
  const localDecls = indexLocalDecls(pPath)

  // Validate each target binding itself.
  for (const target of rawTargets) {
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

  const closure = new Set<string>()
  const queue = rawTargets.map((t) => t.name)

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

  assertNoInterferingStatements(
    pPath,
    rawTargets,
    closure,
    localDecls,
  )

  const evalNames = allocateEvalExportNames(
    rawTargets.map((t) => t.name),
    localDecls,
  )
  const targets: PreevalTarget[] = rawTargets.map((t, i) => ({
    name: t.name,
    initStart: t.initStart,
    initEnd: t.initEnd,
    evalExportName: evalNames[i]!,
  }))

  const extracted = buildExtractedCode(file.program.body, closure, targets)
  return { code: extracted, targets }
}
