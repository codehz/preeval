import type { NodePath, Scope } from '@babel/traverse'
import type { ImportDeclaration, VariableDeclaration } from '@babel/types'
import * as t from '@babel/types'
import { isPureTypeNode, unwrapExport } from './ast'
import type { LocalDecl } from './types'

export function importLocalName(
  spec: t.ImportSpecifier | t.ImportDefaultSpecifier | t.ImportNamespaceSpecifier,
): string {
  return spec.local.name
}

export function isTypeOnlyImportSpec(
  decl: ImportDeclaration,
  spec: t.ImportSpecifier | t.ImportDefaultSpecifier | t.ImportNamespaceSpecifier,
): boolean {
  if (decl.importKind === 'type') return true
  return spec.type === 'ImportSpecifier' && spec.importKind === 'type'
}

/**
 * Collect program-level runtime free identifiers referenced under `root`.
 * Ambient globals (no local binding / no known top-level decl) are ignored.
 *
 * Note: `path.traverse` does not visit the root path itself, so a lone
 * Identifier initializer (e.g. `const x = y`) must be handled explicitly.
 */
export function collectProgramFreeNames(
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

/**
 * Index stable top-level declarations. Used both for closure roots and for
 * resolving free names that Babel scope does not track (TS enums).
 */
export function indexLocalDecls(programPath: NodePath<t.Program>): Map<string, LocalDecl> {
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
      (stmtPath.isExportNamedDeclaration() || stmtPath.isExportDefaultDeclaration()) &&
      stmtPath.node.declaration
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

export function varKindOf(decl: LocalDecl): 'const' | 'let' | 'var' | null {
  if (!decl.path.isVariableDeclarator()) return null
  const parent = decl.path.parent
  if (parent.type !== 'VariableDeclaration') return null
  return parent.kind === 'const' || parent.kind === 'let' || parent.kind === 'var'
    ? parent.kind
    : null
}

export function validateStableDep(decl: LocalDecl): void {
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
export function depsOfDecl(
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
export function assertNoImportMeta(root: NodePath): void {
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

export function writtenProgramNames(
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

export function collectWrittenProgramNames(
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

export function hoistableName(stmt: t.Statement): string | null {
  const inner = unwrapExport(stmt)
  if (inner.type === 'FunctionDeclaration' && inner.id) return inner.id.name
  if (inner.type === 'ClassDeclaration' && inner.id) return inner.id.name
  return null
}

/**
 * Function/class declarations (incl. `export` wrappers) are hoisted, so a body
 * that touches the closure can run via a pre-target call even when the decl
 * text sits after every marked const.
 */
export function isHoistableDeclaration(stmt: t.Statement): boolean {
  return hoistableName(stmt) != null
}
