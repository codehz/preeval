import { createRollupPlugin } from 'unplugin'
import type { Options } from './types'
import { unpluginFactory } from './index'

export type { Options } from './types'

export default createRollupPlugin<Options | undefined>(unpluginFactory)
