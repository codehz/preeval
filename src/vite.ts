import { createVitePlugin } from 'unplugin'
import type { Options } from './types'
import { unpluginFactory } from './index'

export type {
  FailurePolicy,
  ImportedFunctionRef,
  Options,
  PreevalRule,
} from './types'

export default createVitePlugin<Options | undefined>(unpluginFactory)
