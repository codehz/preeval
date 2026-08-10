import { parse, type ParserPlugin } from '@babel/parser'
import generateMod from '@babel/generator'
import traverseMod, { type NodePath } from '@babel/traverse'
import * as t from '@babel/types'
import type { Comment, File, Statement, VariableDeclaration } from '@babel/types'

// CJS interop: Bun/Node may surface either the function or `{ default: fn }`.
export const generate =
  (generateMod as unknown as { default?: typeof generateMod }).default ?? generateMod
export const traverse =
  (traverseMod as unknown as { default?: typeof traverseMod }).default ?? traverseMod

export const MARKER = '@preeval'

export function assertNumber(pos: number | null | undefined, what: string): number {
  if (typeof pos !== 'number') {
    throw new Error(`preeval: missing ${what} position in AST`)
  }
  return pos
}

export function pluginsForFilename(filename?: string): ParserPlugin[] {
  const lower = (filename ?? '').toLowerCase()
  // Enable JSX grammar only for real JSX/TSX files so angle-bracket type
  // assertions remain valid in plain `.ts` / `.mts` / `.cts`.
  if (lower.endsWith('.tsx') || lower.endsWith('.jsx')) {
    return ['typescript', 'jsx']
  }
  if (
    lower.endsWith('.ts') ||
    lower.endsWith('.mts') ||
    lower.endsWith('.cts') ||
    lower.endsWith('.js') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs')
  ) {
    return ['typescript']
  }
  return ['typescript']
}

export function parseModule(code: string, filename?: string): File | null {
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

export function resolveProgramPath(file: File): NodePath<t.Program> {
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
export function isMarked(code: string, file: File, stmt: Statement): boolean {
  const start = assertNumber(stmt.start, 'statement start')
  const comments = file.comments ?? []
  let closest: Comment | null = null
  for (const comment of comments) {
    const end = comment.end
    if (
      typeof end === 'number' &&
      end <= start &&
      (closest === null || end > assertNumber(closest.end, 'comment end'))
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
export function unwrapExport(stmt: Statement): Statement {
  if (
    (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') &&
    stmt.declaration != null &&
    stmt.declaration.type !== 'StringLiteral'
  ) {
    return stmt.declaration as Statement
  }
  return stmt
}

/** Top-level const VariableDeclaration, including `export const`. */
export function asConstDeclaration(stmt: Statement): VariableDeclaration | null {
  const inner = unwrapExport(stmt)
  if (inner.type === 'VariableDeclaration' && inner.kind === 'const') return inner
  return null
}

/** Pure type-system nodes: traverse should skip (no runtime free refs). */
export function isPureTypeNode(node: t.Node): boolean {
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
