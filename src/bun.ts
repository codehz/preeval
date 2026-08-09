import { createBunPlugin } from 'unplugin'
import type { Options } from './types'
import { unpluginFactory } from './index'

export type {
  FailurePolicy,
  ImportedFunctionRule,
  ImportedFunctionSubstitute,
  Options,
} from './types'

export default createBunPlugin<Options | undefined>(unpluginFactory)
