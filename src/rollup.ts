import { createRollupPlugin } from 'unplugin'
import type { Options } from './types'
import { unpluginFactory } from './index'

export type { FailurePolicy, ImportedFunctionRef, Options, PreevalRule } from './types'

export default createRollupPlugin<Options | undefined>(unpluginFactory)
