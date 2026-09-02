export interface LocalConnectionSettings {
  readonly version: 1
  readonly workspacePath: string
  readonly configDirectory: string | null
}

export const DEFAULT_WORKSPACE_PATH = '/storage/emulated/0'
export const ACTION_PAD_FILE_NAME = 'action-pad.yaml'

export const DEFAULT_LOCAL_CONNECTION_SETTINGS: LocalConnectionSettings = Object.freeze({
  version: 1,
  workspacePath: DEFAULT_WORKSPACE_PATH,
  configDirectory: null
})

/**
 * Applies the path checks available without touching Android's filesystem.
 * Native startup remains responsible for resolving the path and checking that
 * it names a readable, writable directory.
 */
export function validateWorkspacePath(value: string): string {
  if (typeof value !== 'string') throw new TypeError('Enter a workspace path')

  const path = value.trim()
  if (path.length === 0) throw new TypeError('Enter a workspace path')
  if (!path.startsWith('/')) throw new TypeError('Workspace path must be absolute')
  if (path.includes('\0')) throw new TypeError('Workspace path contains an invalid character')

  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment.length === 0 || segment === '.') continue
    if (segment === '..') {
      throw new TypeError('Workspace path must not contain parent-directory segments')
    }
    segments.push(segment)
  }

  return segments.length === 0 ? '/' : `/${segments.join('/')}`
}

export function validateConfigDirectory(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim().length === 0) return null
  return validateAbsoluteAndroidPath(value, 'Config folder')
}

export function requireConfigDirectory(value: string | null | undefined): string {
  const directory = validateConfigDirectory(value)
  if (directory === null) throw new TypeError('Choose a Neovim config folder')
  return directory
}

export function createLocalConnectionSettings(
  workspacePath: string,
  configDirectory: string | null = null
): LocalConnectionSettings {
  return {
    version: 1,
    workspacePath: validateWorkspacePath(workspacePath),
    configDirectory: validateConfigDirectory(configDirectory)
  }
}

export function validateLocalConnectionSettings(value: unknown): LocalConnectionSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid local connection settings')
  }

  const record = value as Record<string, unknown>
  if (record.version !== 1) throw new TypeError('Invalid local connection settings version')
  if (typeof record.workspacePath !== 'string') throw new TypeError('Enter a workspace path')
  if (
    !Object.prototype.hasOwnProperty.call(record, 'configDirectory') ||
    (record.configDirectory !== null && typeof record.configDirectory !== 'string')
  ) {
    throw new TypeError('Invalid local config folder setting')
  }

  return createLocalConnectionSettings(
    record.workspacePath,
    record.configDirectory as string | null
  )
}

export function actionPadPathForSettings(settings: LocalConnectionSettings): string {
  const directory = requireConfigDirectory(settings.configDirectory)
  return directory === '/'
    ? `/${ACTION_PAD_FILE_NAME}`
    : `${directory}/${ACTION_PAD_FILE_NAME}`
}

function validateAbsoluteAndroidPath(value: string, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`Enter a ${label.toLowerCase()}`)

  const path = value.trim()
  if (path.length === 0) throw new TypeError(`Enter a ${label.toLowerCase()}`)
  if (!path.startsWith('/')) throw new TypeError(`${label} must be absolute`)
  if (path.includes('\0')) throw new TypeError(`${label} contains an invalid character`)

  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment.length === 0 || segment === '.') continue
    if (segment === '..') {
      throw new TypeError(`${label} must not contain parent-directory segments`)
    }
    segments.push(segment)
  }

  return segments.length === 0 ? '/' : `/${segments.join('/')}`
}
