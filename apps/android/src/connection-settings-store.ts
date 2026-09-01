import AsyncStorage from '@react-native-async-storage/async-storage'

import {
  diagnosticLogger,
  type DiagnosticLogger
} from './diagnostics/logger'
import {
  DEFAULT_LOCAL_TARGET,
  DEFAULT_REMOTE_TARGET,
  validateConnectionTarget,
  type ConnectionTarget,
  type ConnectionTargetKind,
  type LocalConnectionTarget,
  type RemoteConnectionTarget
} from './connection-target'

export const CONNECTION_SETTINGS_STORAGE_KEY = 'codey.android.connection-settings.v3'
export const LEGACY_CONNECTION_SETTINGS_STORAGE_KEY = 'codey.android.connection-settings.v2'
export const LEGACY_ENDPOINT_STORAGE_KEY = 'codey.android.endpoint.v1'

export interface ConnectionSettings {
  readonly version: 3
  readonly selectedKind: ConnectionTargetKind
  readonly local: Readonly<Pick<LocalConnectionTarget, 'workspacePath' | 'configDirectory'>>
  readonly remote: Readonly<Pick<RemoteConnectionTarget, 'host' | 'port'>>
}

export const DEFAULT_CONNECTION_SETTINGS: ConnectionSettings = Object.freeze({
  version: 3,
  selectedKind: 'local',
  local: Object.freeze({
    workspacePath: DEFAULT_LOCAL_TARGET.workspacePath,
    configDirectory: null
  }),
  remote: Object.freeze({ host: DEFAULT_REMOTE_TARGET.host, port: DEFAULT_REMOTE_TARGET.port })
})

export interface ConnectionSettingsStore {
  load(): Promise<ConnectionSettings>
  save(settings: ConnectionSettings): Promise<void>
}

export type ConnectionSettingsStorage = Pick<typeof AsyncStorage, 'getItem' | 'setItem'>

interface MigrationResult {
  readonly settings: ConnectionSettings
  readonly outcome:
    | 'no-legacy-settings'
    | 'legacy-storage-failure'
    | 'invalid-legacy-settings'
    | 'migrated'
    | 'migrated-in-memory'
}

export function validateConnectionSettings(value: unknown): ConnectionSettings {
  if (typeof value !== 'object' || value === null) throw new TypeError('Invalid connection settings')

  const record = value as Record<string, unknown>
  if (record.version !== 3) throw new TypeError('Invalid connection settings version')
  if (record.selectedKind !== 'local' && record.selectedKind !== 'remote') {
    throw new TypeError('Invalid selected connection target')
  }

  const localRecord = requireRecord(record.local)
  const remoteRecord = requireRecord(record.remote)
  const local = validateConnectionTarget({
    kind: 'local',
    workspacePath: localRecord.workspacePath,
    configDirectory: localRecord.configDirectory
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
    ? {
        kind: 'local',
        workspacePath: normalized.local.workspacePath,
        configDirectory: normalized.local.configDirectory
      }
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
    workspacePath: current.local.workspacePath,
    configDirectory: current.local.configDirectory
  }, selected)
}

export function createConnectionSettingsStore(
  storage: ConnectionSettingsStorage = AsyncStorage,
  logger: DiagnosticLogger = diagnosticLogger
): ConnectionSettingsStore {
  return {
    async load(): Promise<ConnectionSettings> {
      const operation = logger.operation({
        category: 'settings',
        event: 'connection_settings.load',
        message: 'Loading connection settings',
        details: {
          storageKey: CONNECTION_SETTINGS_STORAGE_KEY,
          legacySettingsStorageKey: LEGACY_CONNECTION_SETTINGS_STORAGE_KEY,
          legacyStorageKey: LEGACY_ENDPOINT_STORAGE_KEY
        }
      })
      let raw: string | null
      try {
        raw = await storage.getItem(CONNECTION_SETTINGS_STORAGE_KEY)
      } catch (reason) {
        operation.failure(reason, {
          event: 'connection_settings.load_storage_failed',
          message: 'Could not read connection settings; using defaults',
          details: {
            storageKey: CONNECTION_SETTINGS_STORAGE_KEY,
            defaultSettings: DEFAULT_CONNECTION_SETTINGS,
            storageFailure: reason
          }
        })
        logDefaultSettings(logger, 'v3-storage-failure', reason, operation.id)
        return DEFAULT_CONNECTION_SETTINGS
      }

      if (raw !== null) {
        try {
          const settings = validateConnectionSettings(JSON.parse(raw))
          operation.success({
            details: {
              source: 'v3',
              rawSettings: raw,
              settings
            }
          })
          return settings
        } catch (reason) {
          logger.warn({
            category: 'settings',
            event: 'connection_settings.invalid',
            message: 'Stored connection settings were invalid',
            operationId: operation.id,
            details: {
              storageKey: CONNECTION_SETTINGS_STORAGE_KEY,
              rawSettings: raw,
              validationFailure: reason
            }
          })
          operation.success({
            event: 'connection_settings.load_defaulted',
            message: 'Loaded default connection settings after invalid stored settings',
            details: {
              source: 'invalid-v3',
              rawSettings: raw,
              defaultSettings: DEFAULT_CONNECTION_SETTINGS
            }
          })
          return DEFAULT_CONNECTION_SETTINGS
        }
      }

      const migration = await migrateLegacySettings(storage, logger, operation.id)
      operation.success({
        event: migration.outcome === 'migrated' || migration.outcome === 'migrated-in-memory'
          ? 'connection_settings.load_migrated'
          : 'connection_settings.load_defaulted',
        message: migration.outcome === 'migrated' || migration.outcome === 'migrated-in-memory'
          ? 'Loaded migrated connection settings'
          : 'Loaded default connection settings',
        details: {
          source: migration.outcome,
          settings: migration.settings
        }
      })
      if (migration.settings === DEFAULT_CONNECTION_SETTINGS) {
        logDefaultSettings(logger, migration.outcome, undefined, operation.id)
      }
      return migration.settings
    },

    async save(settings: ConnectionSettings): Promise<void> {
      const operation = logger.operation({
        category: 'settings',
        event: 'connection_settings.save',
        message: 'Saving connection settings',
        details: { settings }
      })
      try {
        const normalized = validateConnectionSettings(settings)
        const rawSettings = JSON.stringify(normalized)
        await storage.setItem(CONNECTION_SETTINGS_STORAGE_KEY, rawSettings)
        operation.success({
          details: {
            storageKey: CONNECTION_SETTINGS_STORAGE_KEY,
            rawSettings,
            settings: normalized
          }
        })
      } catch (reason) {
        operation.failure(reason, {
          details: {
            storageKey: CONNECTION_SETTINGS_STORAGE_KEY,
            settings,
            storageFailure: reason
          }
        })
        throw reason
      }
    }
  }
}

export const connectionSettingsStore = createConnectionSettingsStore()

async function migrateLegacySettings(
  storage: ConnectionSettingsStorage,
  logger: DiagnosticLogger,
  parentOperationId: string
): Promise<MigrationResult> {
  const operation = logger.operation({
    category: 'settings',
    event: 'connection_settings.migration',
    message: 'Checking for legacy connection settings',
    parentOperationId,
    details: {
      legacySettingsStorageKey: LEGACY_CONNECTION_SETTINGS_STORAGE_KEY,
      legacyStorageKey: LEGACY_ENDPOINT_STORAGE_KEY,
      targetStorageKey: CONNECTION_SETTINGS_STORAGE_KEY
    }
  })
  let legacySettingsRaw: string | null
  try {
    legacySettingsRaw = await storage.getItem(LEGACY_CONNECTION_SETTINGS_STORAGE_KEY)
  } catch (reason) {
    operation.failure(reason, {
      event: 'connection_settings.migration_read_failed',
      message: 'Could not read legacy connection settings',
      details: {
        legacySettingsStorageKey: LEGACY_CONNECTION_SETTINGS_STORAGE_KEY,
        storageFailure: reason
      }
    })
    return {
      settings: DEFAULT_CONNECTION_SETTINGS,
      outcome: 'legacy-storage-failure'
    }
  }

  if (legacySettingsRaw !== null) {
    try {
      const migrated = migrateV2ConnectionSettings(JSON.parse(legacySettingsRaw))
      return await persistMigration(
        storage,
        operation,
        migrated,
        { rawLegacySettings: legacySettingsRaw, source: 'v2' }
      )
    } catch (reason) {
      operation.checkpoint({
        event: 'connection_settings.v2_migration_invalid',
        message: 'Stored v2 connection settings were invalid; checking the legacy endpoint',
        level: 'warn',
        details: { rawLegacySettings: legacySettingsRaw, validationFailure: reason }
      })
    }
  }

  let raw: string | null
  try {
    raw = await storage.getItem(LEGACY_ENDPOINT_STORAGE_KEY)
    if (raw === null) {
      operation.success({
        event: 'connection_settings.migration_not_needed',
        message: 'No legacy connection settings were present',
        details: { defaultSettings: DEFAULT_CONNECTION_SETTINGS }
      })
      return {
        settings: DEFAULT_CONNECTION_SETTINGS,
        outcome: 'no-legacy-settings'
      }
    }
  } catch (reason) {
    operation.failure(reason, {
      event: 'connection_settings.migration_read_failed',
      message: 'Could not read legacy connection settings',
      details: {
        legacyStorageKey: LEGACY_ENDPOINT_STORAGE_KEY,
        storageFailure: reason
      }
    })
    return {
      settings: DEFAULT_CONNECTION_SETTINGS,
      outcome: 'legacy-storage-failure'
    }
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
  } catch (reason) {
    operation.failure(reason, {
      event: 'connection_settings.migration_invalid',
      message: 'Legacy connection settings were invalid',
      details: {
        rawLegacySettings: raw,
        validationFailure: reason
      }
    })
    return {
      settings: DEFAULT_CONNECTION_SETTINGS,
      outcome: 'invalid-legacy-settings'
    }
  }

  return persistMigration(storage, operation, migrated, { rawLegacySettings: raw, source: 'endpoint-v1' })
}

async function persistMigration(
  storage: ConnectionSettingsStorage,
  operation: ReturnType<DiagnosticLogger['operation']>,
  migrated: ConnectionSettings,
  details: Record<string, unknown>
): Promise<MigrationResult> {
  try {
    const rawSettings = JSON.stringify(migrated)
    await storage.setItem(CONNECTION_SETTINGS_STORAGE_KEY, rawSettings)
    operation.success({ details: { ...details, rawSettings, settings: migrated } })
    return { settings: migrated, outcome: 'migrated' }
  } catch (reason) {
    operation.checkpoint({
      event: 'connection_settings.migration_persist_failed',
      message: 'Migrated settings could not be persisted',
      level: 'error',
      details: { ...details, settings: migrated, storageFailure: reason }
    })
    operation.success({
      event: 'connection_settings.migration_succeeded_in_memory',
      message: 'Migrated connection settings for this run only',
      details: { ...details, settings: migrated }
    })
    return { settings: migrated, outcome: 'migrated-in-memory' }
  }
}

function migrateV2ConnectionSettings(value: unknown): ConnectionSettings {
  const record = requireRecord(value)
  if (record.version !== 2) throw new TypeError('Invalid legacy connection settings version')
  if (record.selectedKind !== 'local' && record.selectedKind !== 'remote') {
    throw new TypeError('Invalid legacy selected connection target')
  }
  const localRecord = requireRecord(record.local)
  const remoteRecord = requireRecord(record.remote)
  const local = validateConnectionTarget({
    kind: 'local',
    workspacePath: localRecord.workspacePath,
    configDirectory: null
  })
  const remote = validateConnectionTarget({
    kind: 'remote',
    host: remoteRecord.host,
    port: remoteRecord.port
  })
  if (local.kind !== 'local' || remote.kind !== 'remote') {
    throw new TypeError('Invalid legacy connection settings')
  }
  return createSettings(record.selectedKind, local, remote)
}

function logDefaultSettings(
  logger: DiagnosticLogger,
  reason: string,
  failure: unknown,
  parentOperationId: string
): void {
  logger.info({
    category: 'settings',
    event: 'connection_settings.default_used',
    message: 'Using default connection settings',
    parentOperationId,
    details: {
      reason,
      defaultSettings: DEFAULT_CONNECTION_SETTINGS,
      failure
    }
  })
}

function createSettings(
  selectedKind: ConnectionTargetKind,
  local: LocalConnectionTarget,
  remote: RemoteConnectionTarget
): ConnectionSettings {
  return {
    version: 3,
    selectedKind,
    local: {
      workspacePath: local.workspacePath,
      configDirectory: local.configDirectory
    },
    remote: { host: remote.host, port: remote.port }
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid connection settings')
  }
  return value as Record<string, unknown>
}
