import defaultYaml from './default.yaml'
import { parseActionPadConfig, resolveActionPadConfig } from './document'

export const DEFAULT_ACTION_PAD_CONFIG = parseActionPadConfig(defaultYaml)
export const ACTION_PAD_MENU = resolveActionPadConfig(DEFAULT_ACTION_PAD_CONFIG)
