import { DEFAULT_ENDPOINT, validateEndpoint, type Endpoint } from './endpoint'

export type ConnectionTargetKind = 'local' | 'remote'

export interface LocalConnectionTarget {
  readonly kind: 'local'
  readonly workspacePath: string
}

export interface RemoteConnectionTarget extends Endpoint {
  readonly kind: 'remote'
}

export type ConnectionTarget = LocalConnectionTarget | RemoteConnectionTarget

export const DEFAULT_LOCAL_WORKSPACE_PATH = '/storage/emulated/0'

export const DEFAULT_LOCAL_TARGET: LocalConnectionTarget = Object.freeze({
  kind: 'local',
  workspacePath: DEFAULT_LOCAL_WORKSPACE_PATH
})

export const DEFAULT_REMOTE_TARGET: RemoteConnectionTarget = Object.freeze({
  kind: 'remote',
  ...DEFAULT_ENDPOINT
})

export const DEFAULT_CONNECTION_TARGET: ConnectionTarget = DEFAULT_LOCAL_TARGET

export const CONNECTION_TARGET_KIND_LABELS: Readonly<Record<ConnectionTargetKind, string>> =
  Object.freeze({
    local: 'Local',
    remote: 'Remote'
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

export function createLocalConnectionTarget(workspacePath: string): LocalConnectionTarget {
  return { kind: 'local', workspacePath: validateWorkspacePath(workspacePath) }
}

export function createRemoteConnectionTarget(
  host: string,
  port: string | number
): RemoteConnectionTarget {
  return { kind: 'remote', ...validateEndpoint(host, port) }
}

export function validateConnectionTarget(value: unknown): ConnectionTarget {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Enter a valid connection target')
  }

  const target = value as Record<string, unknown>
  if (target.kind === 'local') {
    if (typeof target.workspacePath !== 'string') throw new TypeError('Enter a workspace path')
    return createLocalConnectionTarget(target.workspacePath)
  }

  if (target.kind === 'remote') {
    if (typeof target.host !== 'string') {
      throw new TypeError('Enter a valid hostname or IP address')
    }
    if (typeof target.port !== 'string' && typeof target.port !== 'number') {
      throw new RangeError('Port must be an integer from 1 to 65535')
    }
    return createRemoteConnectionTarget(target.host, target.port)
  }

  throw new TypeError('Enter a valid connection target')
}

export function connectionTargetLabel(target: ConnectionTarget): string {
  if (target.kind === 'local') return `Local (${target.workspacePath})`
  return `Remote (${formatEndpoint(target)})`
}

/**
 * Compatibility identity for the Action Pad path preference. The sentinel host
 * contains a character rejected by remote endpoint validation, so it cannot
 * collide with a user-configured TCP endpoint. The Local path intentionally
 * remains stable when the workspace path changes.
 */
export function actionPadEndpointForTarget(target: ConnectionTarget): Endpoint {
  if (target.kind === 'local') return LOCAL_ACTION_PAD_ENDPOINT
  return { host: target.host, port: target.port }
}

const LOCAL_ACTION_PAD_ENDPOINT: Endpoint = Object.freeze({ host: '@local', port: 1 })

function formatEndpoint(endpoint: Endpoint): string {
  const host = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host
  return `${host}:${endpoint.port}`
}
