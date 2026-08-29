import defaultYaml from './default.yaml'
import { parseActionPadConfig } from './document'

export const DEFAULT_ACTION_PAD_CONFIG = parseActionPadConfig(defaultYaml)
