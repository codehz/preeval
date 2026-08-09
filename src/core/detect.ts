import { parse, type ParserPlugin } from '@babel/parser'
import type {
  Comment,
  ExportNamedDeclaration,
  ExportSpecifier,
  File,
  Statement,
  VariableDeclaration,
} from '@babel/types'

export interface MarkedBinding {
  /** local binding name */
  name: string
  /** exported name used on module namespace (may equal name) */
  exportName: string
  initStart: number
  initEnd: number
}

const MARKER = '@preeval'

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
  // Unknown extension: prefer TypeScript without JSX (safe for plain JS too).
  return ['typescript']
}

function exportNameOf(spec: ExportSpecifier): string {
  return spec.exported.type === 'Identifier'
    ? spec.exported.name
    : spec.exported.value
}

/**
 * Build the local-name → exported-name map for top-level named exports.
 * Handles `export const x = …` and `export { local as exported }` lists.
 * Re-exports with a source (`export { x } from '…'`) and type-only exports
 * are out of scope / ignored.
 */
function buildExportMap(body: Statement[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const stmt of body) {
    if (stmt.type !== 'ExportNamedDeclaration') continue
    if (stmt.source !== null) continue
    // `export type { … }` — whole declaration is type-only.
    if (stmt.exportKind === 'type') continue

    const decl = (stmt as ExportNamedDeclaration).declaration
    if (decl != null && decl.type === 'VariableDeclaration' && decl.kind === 'const') {
      for (const d of decl.declarations) {
        if (d.id.type === 'Identifier') map.set(d.id.name, d.id.name)
      }
      continue
    }

    if (decl == null) {
      for (const spec of stmt.specifiers) {
        if (spec.type !== 'ExportSpecifier' || spec.local.type !== 'Identifier') continue
        // `export { type X }` / `export { type X as Y }`
        if (spec.exportKind === 'type') continue
        map.set(spec.local.name, exportNameOf(spec))
      }
    }
  }
  return map
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

/**
 * Scan `code` for top-level `const` declarations carrying a `// @preeval`
 * marker that are exported (directly via `export const`, or through an
 * `export { … }` list). Single declarator only. Returns the init spans of
 * every marked+exported binding, keyed by local name and exported name.
 *
 * @param filename Optional source path used to choose TS vs TSX grammar.
 */
export function detectMarkedExports(
  code: string,
  filename?: string,
): MarkedBinding[] {
  let file: File
  try {
    file = parse(code, {
      sourceType: 'module',
      sourceFilename: filename,
      plugins: pluginsForFilename(filename),
    })
  } catch {
    // Unparseable input (e.g. non-TS/JS payloads) means no detectable marks.
    return []
  }

  const body = file.program.body
  const exportMap = buildExportMap(body)
  const result: MarkedBinding[] = []

  for (const stmt of body) {
    let decl: VariableDeclaration | null = null
    if (stmt.type === 'VariableDeclaration') {
      decl = stmt
    } else if (
      stmt.type === 'ExportNamedDeclaration'
      && stmt.declaration != null
      && stmt.declaration.type === 'VariableDeclaration'
    ) {
      decl = stmt.declaration
    }
    if (decl == null || decl.kind !== 'const') continue
    // v1: single declarator only
    if (decl.declarations.length !== 1) continue
    const d = decl.declarations[0]
    if (d === undefined || d.id.type !== 'Identifier' || d.init == null) continue
    const exportName = exportMap.get(d.id.name)
    if (exportName === undefined) continue
    if (!isMarked(code, file, stmt)) continue
    result.push({
      name: d.id.name,
      exportName,
      initStart: assertNumber(d.init.start, 'initializer start'),
      initEnd: assertNumber(d.init.end, 'initializer end'),
    })
  }

  return result
}
