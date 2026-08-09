/** Behavior when a pre-evaluation target cannot be replaced. */
export type FailurePolicy = 'ignore' | 'warn' | 'error'

/** Build-time-only replacement for an imported function. */
export interface ImportedFunctionSubstitute {
  /** Exact ESM source specifier used by the temporary evaluation module. */
  from: string
  /** ESM export name. Use "default" for the default export. */
  import: string
}

/** Exact statically imported ESM function selected for automatic pre-evaluation. */
export interface ImportedFunctionRule {
  /** Exact source string from the original import declaration. */
  from: string
  /** ESM export name. Use "default" for the default export. */
  import: string
  /** Optional callee used only in the temporary evaluation module. */
  substitute?: ImportedFunctionSubstitute
  /** Override the global failure policy for this rule. */
  onFailure?: FailurePolicy
}

/** Build options for the preeval plugin. */
export interface Options {
  /** Failure policy shared by marks and automatic calls. Default "warn". */
  onFailure?: FailurePolicy
  /** Imported ESM functions whose direct calls should be pre-evaluated. */
  imports?: ImportedFunctionRule[]
  /**
   * When true, evaluation may freely use Node/Bun APIs already in the host.
   * When false (default), we do not inject extra Node helpers; there is NO sandbox.
   */
  allowNode?: boolean
  include?: FilterPattern
  exclude?: FilterPattern
}

/** A glob/RegExp pattern (or list of them) used to filter file ids. */
export type FilterPattern = string | RegExp | Array<string | RegExp>
