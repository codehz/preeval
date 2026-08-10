import type { Binding, NodePath } from '@babel/traverse'
import type { Statement } from '@babel/types'
import type { PreevalRule } from '../../types'

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

export interface SourceEdit {
  start: number
  end: number
  replacement: string
}

/** Runtime statement kinds that can define a stable local dependency. */
export type DeclKind = 'const' | 'function' | 'class' | 'enum' | 'import'

export interface LocalDecl {
  name: string
  kind: DeclKind
  /** Top-level statement that owns this declaration (may be an export wrapper). */
  stmt: Statement
  /** Innermost path for the binding (declarator / import spec / function / …). */
  path: NodePath
  binding: Binding | null
}

export interface RawMarkedTarget extends MarkedBindingTarget {
  stmt: Statement
}

export interface MatchedImportedCall {
  rule: PreevalRule
  localName: string
}
