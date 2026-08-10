/** Behavior when a pre-evaluation target cannot be replaced. */
export type FailurePolicy = 'ignore' | 'warn' | 'error'

/** ESM function reference used by one pre-evaluation phase. */
export interface ImportedFunctionRef {
  /**
   * Module specifier for this reference.
   *
   * For `match.from`, comparison uses the host resolver when available:
   * rule paths resolve against `Options.root`, import sources against the
   * current file. Without a host resolver, matching is exact string equality.
   * `evaluate` / `materialize` emit this specifier as written.
   */
  from: string
  /** ESM export name. Use "default" for the default export. */
  import: string
}

/** Explicit match → evaluate → optional runtime materialize rule. */
export interface PreevalRule {
  /** Original imported call or tagged template selected in author source. */
  match: ImportedFunctionRef
  /** Build-time evaluator. Defaults to `match`. */
  evaluate?: ImportedFunctionRef
  /** Runtime-only single-argument materializer for the serialized result. */
  materialize?: ImportedFunctionRef
  /** Override the global failure policy for this rule. */
  onFailure?: FailurePolicy
}

/** Build options for the preeval plugin. */
export interface Options {
  /** Failure policy shared by marks and automatic calls. Default "warn". */
  onFailure?: FailurePolicy
  /** Imported ESM functions selected for automatic pre-evaluation. */
  rules?: PreevalRule[]
  /**
   * Project root used when resolving relative `rules[].match.from` values.
   * Default `process.cwd()`.
   */
  root?: string
  include?: FilterPattern
  exclude?: FilterPattern
}

/** A glob/RegExp pattern (or list of them) used to filter file ids. */
export type FilterPattern = string | RegExp | Array<string | RegExp>
