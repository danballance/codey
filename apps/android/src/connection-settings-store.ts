import AsyncStorage from '@react-native-async-storage/async-storage'

import {
  diagnosticLogger,
  type DiagnosticLogger
} from './diagnostics/logger'
import {
  DEFAULT_LOCAL_CONNECTION_SETTINGS,
  validateLocalConnectionSettings,
  type LocalConnectionSettings
} from './local-connection-settings'

export const CONNECTION_SETTINGS_STORAGE_KEY = 'codey.android.local-settings.v1'

export interface ConnectionSettingsStore {
  load(): Promise<LocalConnectionSettings>
  save(settings: LocalConnectionSettings): Promise<void>
}

export type ConnectionSettingsStorage = Pick<typeof AsyncStorage, 'getItem' | 'setItem'>

export function createConnectionSettingsStore(
  storage: ConnectionSettingsStorage = AsyncStorage,
  logger: DiagnosticLogger = diagnosticLogger
): ConnectionSettingsStore {
  return {
    async load(): Promise<LocalConnectionSettings> {
      const operation = logger.operation({
        category: 'settings',
        event: 'connection_settings.load',
        message: 'Loading local connection settings',
        details: { storageKey: CONNECTION_SETTINGS_STORAGE_KEY }
      })

      let raw: string | null
      try {
        raw = await storage.getItem(CONNECTION_SETTINGS_STORAGE_KEY)
      } catch (reason) {
        operation.failure(reason, {
          event: 'connection_settings.load_storage_failed',
          message: 'Could not read local connection settings; using defaults',
          details: {
            storageKey: CONNECTION_SETTINGS_STORAGE_KEY,
            storageFailure: reason
          }
        })
        logDefaultSettings(logger, 'storage-failure', reason, operation.id)
        return DEFAULT_LOCAL_CONNECTION_SETTINGS
      }

      if (raw === null) {
        operation.success({
          event: 'connection_settings.load_defaulted',
          message: 'No local connection settings were stored; using defaults',
          details: {
            source: 'missing-v1'
          }
        })
        logDefaultSettings(logger, 'missing-v1', undefined, operation.id)
        return DEFAULT_LOCAL_CONNECTION_SETTINGS
      }

      try {
        const settings = validateLocalConnectionSettings(JSON.parse(raw))
        operation.success({
          details: {
            source: 'v1',
            version: settings.version,
            configDirectorySelected: settings.configDirectory !== null
          }
        })
        return settings
      } catch (reason) {
        logger.warn({
          category: 'settings',
          event: 'connection_settings.invalid',
          message: 'Stored local connection settings were invalid',
          operationId: operation.id,
          details: {
            storageKey: CONNECTION_SETTINGS_STORAGE_KEY,
            validationFailure: reason
          }
        })
        operation.success({
          event: 'connection_settings.load_defaulted',
          message: 'Loaded default local connection settings after invalid stored settings',
          details: {
            source: 'invalid-v1'
          }
        })
        logDefaultSettings(logger, 'invalid-v1', reason, operation.id)
        return DEFAULT_LOCAL_CONNECTION_SETTINGS
      }
    },

    async save(settings: LocalConnectionSettings): Promise<void> {
      const operation = logger.operation({
        category: 'settings',
        event: 'connection_settings.save',
        message: 'Saving local connection settings',
        details: {
          version: settings.version,
          configDirectorySelected: settings.configDirectory !== null
        }
      })
      try {
        const normalized = validateLocalConnectionSettings(settings)
        const rawSettings = JSON.stringify(normalized)
        await storage.setItem(CONNECTION_SETTINGS_STORAGE_KEY, rawSettings)
        operation.success({
          details: {
            storageKey: CONNECTION_SETTINGS_STORAGE_KEY,
            version: normalized.version,
            configDirectorySelected: normalized.configDirectory !== null
          }
        })
      } catch (reason) {
        operation.failure(reason, {
          details: {
            storageKey: CONNECTION_SETTINGS_STORAGE_KEY,
            version: settings.version,
            configDirectorySelected: settings.configDirectory !== null,
            storageFailure: reason
          }
        })
        throw reason
      }
    }
  }
}

export const connectionSettingsStore = createConnectionSettingsStore()

function logDefaultSettings(
  logger: DiagnosticLogger,
  reason: string,
  failure: unknown,
  parentOperationId: string
): void {
  logger.info({
    category: 'settings',
    event: 'connection_settings.default_used',
    message: 'Using default local connection settings',
    parentOperationId,
    details: {
      reason,
      failure
    }
  })
}
