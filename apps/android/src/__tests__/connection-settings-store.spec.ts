jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn()
  }
}))

import {
  CONNECTION_SETTINGS_STORAGE_KEY,
  DEFAULT_CONNECTION_SETTINGS,
  LEGACY_ENDPOINT_STORAGE_KEY,
  createConnectionSettingsStore,
  selectedConnectionTarget,
  withSelectedConnectionTarget,
  type ConnectionSettingsStorage
} from '../connection-settings-store'

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

describe('connection settings store', () => {
  it('uses Local as the fresh-install default when no settings exist', async () => {
    const test = createStorage()

    await expect(createConnectionSettingsStore(test.storage).load()).resolves.toBe(
      DEFAULT_CONNECTION_SETTINGS
    )
    expect(selectedConnectionTarget(DEFAULT_CONNECTION_SETTINGS)).toEqual({
      kind: 'local',
      workspacePath: '/storage/emulated/0'
    })
    expect(test.getItem).toHaveBeenNthCalledWith(1, CONNECTION_SETTINGS_STORAGE_KEY)
    expect(test.getItem).toHaveBeenNthCalledWith(2, LEGACY_ENDPOINT_STORAGE_KEY)
  })

  it('loads and normalizes v2 settings containing both target details', async () => {
    const test = createStorage({
      [CONNECTION_SETTINGS_STORAGE_KEY]: JSON.stringify({
        version: 2,
        selectedKind: 'remote',
        local: { workspacePath: ' /storage//emulated/0/projects/ ' },
        remote: { host: ' tablet.local ', port: 7777 }
      })
    })

    const loaded = await createConnectionSettingsStore(test.storage).load()

    expect(loaded).toEqual({
      version: 2,
      selectedKind: 'remote',
      local: { workspacePath: '/storage/emulated/0/projects' },
      remote: { host: 'tablet.local', port: 7777 }
    })
    expect(selectedConnectionTarget(loaded)).toEqual({
      kind: 'remote',
      host: 'tablet.local',
      port: 7777
    })
    expect(test.getItem).toHaveBeenCalledTimes(1)
  })

  it('saves normalized v2 JSON and retains the other target when selection changes', async () => {
    const test = createStorage()
    const store = createConnectionSettingsStore(test.storage)
    const settings = withSelectedConnectionTarget(DEFAULT_CONNECTION_SETTINGS, {
      kind: 'remote',
      host: ' remote.test ',
      port: 7777
    })

    await store.save(settings)

    expect(test.setItem).toHaveBeenCalledWith(
      CONNECTION_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        selectedKind: 'remote',
        local: { workspacePath: '/storage/emulated/0' },
        remote: { host: 'remote.test', port: 7777 }
      })
    )
  })

  it('migrates a valid legacy endpoint to Remote and persists v2 best-effort', async () => {
    const test = createStorage({
      [LEGACY_ENDPOINT_STORAGE_KEY]: '{"host":" legacy.test ","port":6000}'
    })

    const loaded = await createConnectionSettingsStore(test.storage).load()

    expect(loaded).toEqual({
      version: 2,
      selectedKind: 'remote',
      local: { workspacePath: '/storage/emulated/0' },
      remote: { host: 'legacy.test', port: 6000 }
    })
    expect(JSON.parse(test.records.get(CONNECTION_SETTINGS_STORAGE_KEY)!)).toEqual(loaded)
  })

  it('still returns a migrated endpoint when persisting the migration fails', async () => {
    const test = createStorage({
      [LEGACY_ENDPOINT_STORAGE_KEY]: '{"host":"legacy.test","port":6000}'
    })
    test.setItem.mockRejectedValueOnce(new Error('Storage full'))

    await expect(createConnectionSettingsStore(test.storage).load()).resolves.toMatchObject({
      selectedKind: 'remote',
      remote: { host: 'legacy.test', port: 6000 }
    })
  })

  it('falls back safely for malformed v2, invalid legacy, or storage failure', async () => {
    const malformedV2 = createStorage({ [CONNECTION_SETTINGS_STORAGE_KEY]: '{broken' })
    await expect(createConnectionSettingsStore(malformedV2.storage).load()).resolves.toBe(
      DEFAULT_CONNECTION_SETTINGS
    )
    expect(malformedV2.getItem).toHaveBeenCalledTimes(1)

    const invalidLegacy = createStorage({
      [LEGACY_ENDPOINT_STORAGE_KEY]: '{"host":"bad host","port":0}'
    })
    await expect(createConnectionSettingsStore(invalidLegacy.storage).load()).resolves.toBe(
      DEFAULT_CONNECTION_SETTINGS
    )

    const failing = createStorage()
    failing.getItem.mockRejectedValueOnce(new Error('Storage unavailable'))
    await expect(createConnectionSettingsStore(failing.storage).load()).resolves.toBe(
      DEFAULT_CONNECTION_SETTINGS
    )
  })
})
