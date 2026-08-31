import AsyncStorage from '@react-native-async-storage/async-storage'

import {
  DEFAULT_LOCAL_TARGET,
  DEFAULT_REMOTE_TARGET,
  validateConnectionTarget,
  type ConnectionTarget,
  type ConnectionTargetKind,
  type LocalConnectionTarget,
  type RemoteConnectionTarget
} from './connection-target'

export const CONNECTION_SETTINGS_STORAGE_KEY = 'codey.android.connection-settings.v2'
export const LEGACY_ENDPOINT_STORAGE_KEY = 'codey.android.endpoint.v1'

export interface ConnectionSettings {
  readonly version: 2
  readonly selectedKind: ConnectionTargetKind
  readonly local: Readonly<Pick<LocalConnectionTarget, 'workspacePath'>>
  readonly remote: Readonly<Pick<RemoteConnectionTarget, 'host' | 'port'>>
}

export const DEFAULT_CONNECTION_SETTINGS: ConnectionSettings = Object.freeze({
  version: 2,
  selectedKind: 'local',
  local: Object.freeze({ workspacePath: DEFAULT_LOCAL_TARGET.workspacePath }),
  remote: Object.freeze({ host: DEFAULT_REMOTE_TARGET.host, port: DEFAULT_REMOTE_TARGET.port })
})

export interface ConnectionSettingsStore {
  load(): Promise<ConnectionSettings>
  save(settings: ConnectionSettings): Promise<void>
}

export type ConnectionSettingsStorage = Pick<typeof AsyncStorage, 'getItem' | 'setItem'>

export function validateConnectionSettings(value: unknown): ConnectionSettings {
  if (typeof value !== 'object' || value === null) throw new TypeError('Invalid connection settings')

  const record = value as Record<string, unknown>
  if (record.version !== 2) throw new TypeError('Invalid connection settings version')
  if (record.selectedKind !== 'local' && record.selectedKind !== 'remote') {
    throw new TypeError('Invalid selected connection target')
  }

  const localRecord = requireRecord(record.local)
  const remoteRecord = requireRecord(record.remote)
  const local = validateConnectionTarget({
    kind: 'local',
    workspacePath: localRecord.workspacePath
  })
  const remote = validateConnectionTarget({
    kind: 'remote',
    host: remoteRecord.host,
    port: remoteRecord.port
  })

  if (local.kind !== 'local' || remote.kind !== 'remote') {
    throw new TypeError('Invalid connection settings')
  }

  return createSettings(record.selectedKind, local, remote)
}

export function selectedConnectionTarget(settings: ConnectionSettings): ConnectionTarget {
  const normalized = validateConnectionSettings(settings)
  return normalized.selectedKind === 'local'
    ? { kind: 'local', workspacePath: normalized.local.workspacePath }
    : { kind: 'remote', host: normalized.remote.host, port: normalized.remote.port }
}

/** Selects a target while retaining the most recently entered details for the other mode. */
export function withSelectedConnectionTarget(
  settings: ConnectionSettings,
  target: ConnectionTarget
): ConnectionSettings {
  const current = validateConnectionSettings(settings)
  const selected = validateConnectionTarget(target)

  if (selected.kind === 'local') {
    return createSettings('local', selected, {
      kind: 'remote',
      host: current.remote.host,
      port: current.remote.port
    })
  }

  return createSettings('remote', {
    kind: 'local',
    workspacePath: current.local.workspacePath
  }, selected)
}

export function createConnectionSettingsStore(
  storage: ConnectionSettingsStorage = AsyncStorage
): ConnectionSettingsStore {
  return {
    async load(): Promise<ConnectionSettings> {
      let raw: string | null
      try {
        raw = await storage.getItem(CONNECTION_SETTINGS_STORAGE_KEY)
      } catch {
        return DEFAULT_CONNECTION_SETTINGS
      }

      if (raw !== null) {
        try {
          return validateConnectionSettings(JSON.parse(raw))
        } catch {
          return DEFAULT_CONNECTION_SETTINGS
        }
      }

      return migrateLegacySettings(storage)
    },

    async save(settings: ConnectionSettings): Promise<void> {
      const normalized = validateConnectionSettings(settings)
      await storage.setItem(CONNECTION_SETTINGS_STORAGE_KEY, JSON.stringify(normalized))
    }
  }
}

export const connectionSettingsStore = createConnectionSettingsStore()

async function migrateLegacySettings(
  storage: ConnectionSettingsStorage
): Promise<ConnectionSettings> {
  let raw: string | null
  try {
    raw = await storage.getItem(LEGACY_ENDPOINT_STORAGE_KEY)
    if (raw === null) return DEFAULT_CONNECTION_SETTINGS
  } catch {
    return DEFAULT_CONNECTION_SETTINGS
  }

  let migrated: ConnectionSettings
  try {
    const parsed: unknown = JSON.parse(raw)
    const record = requireRecord(parsed)
    const remote = validateConnectionTarget({
      kind: 'remote',
      host: record.host,
      port: record.port
    })
    if (remote.kind !== 'remote') throw new TypeError('Invalid legacy endpoint')
    migrated = createSettings('remote', DEFAULT_LOCAL_TARGET, remote)
  } catch {
    return DEFAULT_CONNECTION_SETTINGS
  }

  try {
    await storage.setItem(CONNECTION_SETTINGS_STORAGE_KEY, JSON.stringify(migrated))
  } catch {
    // Migration still succeeds for this session; persistence can be retried later.
  }
  return migrated
}

function createSettings(
  selectedKind: ConnectionTargetKind,
  local: LocalConnectionTarget,
  remote: RemoteConnectionTarget
): ConnectionSettings {
  return {
    version: 2,
    selectedKind,
    local: { workspacePath: local.workspacePath },
    remote: { host: remote.host, port: remote.port }
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid connection settings')
  }
  return value as Record<string, unknown>
}
