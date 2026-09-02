jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn()
  }
}))

import {
  CONNECTION_SETTINGS_STORAGE_KEY,
  createConnectionSettingsStore,
  type ConnectionSettingsStorage
} from '../connection-settings-store'
import {
  createDiagnosticLogger,
  type DiagnosticLogger
} from '../diagnostics/logger'
import {
  DEFAULT_LOCAL_CONNECTION_SETTINGS,
  createLocalConnectionSettings
} from '../local-connection-settings'

function createTestLogger(): DiagnosticLogger {
  const sink = jest.fn()
  return createDiagnosticLogger({
    console: { debug: sink, error: sink, info: sink, warn: sink }
  })
}

function createTestStore(storage: ConnectionSettingsStorage) {
  const logger = createTestLogger()
  return { logger, store: createConnectionSettingsStore(storage, logger) }
}

function createStorage(initial: Readonly<Record<string, string>> = {}): {
  readonly storage: ConnectionSettingsStorage
  readonly records: Map<string, string>
  readonly getItem: jest.Mock<Promise<string | null>, [string]>
  readonly setItem: jest.Mock<Promise<void>, [string, string]>
} {
  const records = new Map(Object.entries(initial))
  const getItem = jest.fn(async (key: string) => records.get(key) ?? null)
  const setItem = jest.fn(async (key: string, value: string) => {
    records.set(key, value)
  })
  return { storage: { getItem, setItem }, records, getItem, setItem }
}

describe('local connection settings store', () => {
  it('uses the local fresh-install default and reads only the v1 key', async () => {
    const test = createStorage({
      'codey.android.endpoint.v1': JSON.stringify({ host: 'old-v1.test', port: 7777 }),
      'codey.android.connection-settings.v2': JSON.stringify({
        version: 2,
        selectedKind: 'remote'
      }),
      'codey.android.connection-settings.v3': JSON.stringify({
        version: 3,
        selectedKind: 'remote'
      })
    })

    await expect(createTestStore(test.storage).store.load()).resolves.toBe(
      DEFAULT_LOCAL_CONNECTION_SETTINGS
    )
    expect(DEFAULT_LOCAL_CONNECTION_SETTINGS).toEqual({
      version: 1,
      workspacePath: '/storage/emulated/0',
      configDirectory: null
    })
    expect(test.getItem).toHaveBeenCalledTimes(1)
    expect(test.getItem).toHaveBeenCalledWith('codey.android.local-settings.v1')
    expect(CONNECTION_SETTINGS_STORAGE_KEY).toBe('codey.android.local-settings.v1')
  })

  it('loads and normalizes flat v1 paths', async () => {
    const test = createStorage({
      [CONNECTION_SETTINGS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        workspacePath: ' /storage//emulated/0/projects/ ',
        configDirectory: ' /storage/emulated/0/config/nvim/ '
      })
    })

    const { logger, store } = createTestStore(test.storage)
    const loaded = await store.load()

    expect(loaded).toEqual({
      version: 1,
      workspacePath: '/storage/emulated/0/projects',
      configDirectory: '/storage/emulated/0/config/nvim'
    })
    expect(test.getItem).toHaveBeenCalledTimes(1)
    expect(logger.getSnapshot().entries.map(({ event }) => event)).toEqual([
      'connection_settings.load.started',
      'connection_settings.load.succeeded'
    ])
    expect(logger.getSnapshot().entries[1]?.details).toMatchObject({
      source: 'v1',
      version: 1,
      configDirectorySelected: true
    })
    expect(JSON.stringify(logger.getSnapshot())).not.toContain('/storage/emulated/0/projects')
  })

  it('saves normalized flat v1 JSON', async () => {
    const test = createStorage()
    const store = createTestStore(test.storage).store
    const settings = createLocalConnectionSettings(
      ' /storage/emulated/0/work/ ',
      ' /storage/emulated/0/config/ '
    )

    await store.save(settings)

    expect(test.setItem).toHaveBeenCalledWith(
      CONNECTION_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        workspacePath: '/storage/emulated/0/work',
        configDirectory: '/storage/emulated/0/config'
      })
    )
  })

  it('does not interpret the old v3 schema as local v1 settings', async () => {
    const test = createStorage({
      [CONNECTION_SETTINGS_STORAGE_KEY]: JSON.stringify({
        version: 3,
        selectedKind: 'local',
        local: {
          workspacePath: '/storage/emulated/0/old',
          configDirectory: '/storage/emulated/0/old-config'
        }
      })
    })

    await expect(createTestStore(test.storage).store.load()).resolves.toBe(
      DEFAULT_LOCAL_CONNECTION_SETTINGS
    )
    expect(test.getItem).toHaveBeenCalledTimes(1)
    expect(test.setItem).not.toHaveBeenCalled()
  })

  it('falls back safely for malformed v1 or storage failure', async () => {
    const malformed = createStorage({ [CONNECTION_SETTINGS_STORAGE_KEY]: '{broken' })
    await expect(createTestStore(malformed.storage).store.load()).resolves.toBe(
      DEFAULT_LOCAL_CONNECTION_SETTINGS
    )
    expect(malformed.getItem).toHaveBeenCalledTimes(1)

    const failing = createStorage()
    failing.getItem.mockRejectedValueOnce(new Error('Storage unavailable'))
    await expect(createTestStore(failing.storage).store.load()).resolves.toBe(
      DEFAULT_LOCAL_CONNECTION_SETTINGS
    )

    const missingConfig = createStorage({
      [CONNECTION_SETTINGS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        workspacePath: '/storage/emulated/0/private-workspace'
      })
    })
    await expect(createTestStore(missingConfig.storage).store.load()).resolves.toBe(
      DEFAULT_LOCAL_CONNECTION_SETTINGS
    )
  })

  it('logs save failures without path contents and still rejects', async () => {
    const test = createStorage()
    const failure = new Error('Storage full')
    test.setItem.mockRejectedValueOnce(failure)
    const { logger, store } = createTestStore(test.storage)

    await expect(store.save(DEFAULT_LOCAL_CONNECTION_SETTINGS)).rejects.toBe(failure)

    expect(logger.getSnapshot().entries.map(({ event }) => event)).toEqual([
      'connection_settings.save.started',
      'connection_settings.save.failed'
    ])
    expect(logger.getSnapshot().entries[1]?.details).toMatchObject({
      error: expect.objectContaining({ message: 'Storage full' }),
      context: expect.objectContaining({
        version: 1,
        configDirectorySelected: false,
        storageFailure: expect.objectContaining({ message: 'Storage full' })
      })
    })
    expect(JSON.stringify(logger.getSnapshot())).not.toContain('/storage/emulated/0')
  })
})
