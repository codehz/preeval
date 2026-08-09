/**
 * Build options for the preeval plugin.
 */
export interface Options {
  /** Fail the build on eval/serialize failure. Default false → warn + skip. */
  strict?: boolean
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
