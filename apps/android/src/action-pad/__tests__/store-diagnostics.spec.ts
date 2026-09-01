import type { HostDocument, HostDocumentWrite } from '@codey/nvim-session'

import {
  createDiagnosticLogger,
  type DiagnosticEntry,
  type DiagnosticLogger
} from '../../diagnostics/logger'
import { serializeActionPadConfig, type ActionPadConfig } from '../document'
import {
  ActionPadConfigStore,
  actionPadPathStorageKey,
  legacyActionPadStorageKey,
  type ActionPadHostDocuments
} from '../store'

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() }
}))

const endpoint = { host: 'diagnostics.nvim.test', port: 7777 }
const sourcePath = '/home/test/action-pad.yaml'
const alternatePath = '/home/test/alternate.yaml'
const fixture: ActionPadConfig = {
  version: 1,
  rootMenuId: 'home',
  menus: [{
    id: 'home', label: 'Home', groups: [{
      id: 'main', buttons: [{
        id: 'escape', label: 'Esc', styles: { size: '1/2' },
        tap: { type: 'input', nvimInput: '<Esc>', after: 'stay' }
      }]
    }]
  }]
}

function edited(label: string): ActionPadConfig {
  return {
    ...fixture,
    menus: fixture.menus.map((menu, index) => index === 0 ? { ...menu, label } : menu)
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function createTestLogger(): DiagnosticLogger {
  const sink = jest.fn()
  return createDiagnosticLogger({ console: { debug: sink, error: sink, info: sink, warn: sink } })
}

function setup() {
  const files = new Map<string, string>([[sourcePath, serializeActionPadConfig(fixture)]])
  const storageRecords = new Map<string, string>()
  const documents = {
    defaultActionPadPath: jest.fn(async () => sourcePath),
    readHostDocument: jest.fn(async (
      _endpoint: typeof endpoint,
      path: string
    ): Promise<HostDocument> => ({ path, text: files.get(path) ?? null })),
    writeHostDocument: jest.fn(async (
      _endpoint: typeof endpoint,
      request: HostDocumentWrite
    ): Promise<void> => { files.set(request.path, request.text) })
  } satisfies ActionPadHostDocuments
  const storage = {
    getItem: jest.fn(async (key: string): Promise<string | null> => storageRecords.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string): Promise<void> => { storageRecords.set(key, value) }),
    removeItem: jest.fn(async (key: string): Promise<void> => { storageRecords.delete(key) })
  }
  const logger = createTestLogger()
  const store = new ActionPadConfigStore(documents, storage, undefined, logger)
  const connect = async () => {
    await store.selectEndpoint(endpoint)
    await store.setConnected(true)
  }
  return { connect, documents, files, logger, storage, storageRecords, store }
}

function entriesFor(logger: DiagnosticLogger, prefix: string): readonly DiagnosticEntry[] {
  return logger.getSnapshot().entries.filter(({ event }) => event.startsWith(prefix))
}

describe('ActionPadConfigStore diagnostics', () => {
  it('records path-only restoration and legacy migration without restoring cached configuration', async () => {
    const restored = setup()
    restored.storageRecords.set(actionPadPathStorageKey(endpoint), alternatePath)

    await restored.store.selectEndpoint(endpoint)

    expect(entriesFor(restored.logger, 'action_pad.path_restore').map(({ event }) => event)).toEqual([
      'action_pad.path_restore.started',
      'action_pad.path_restore.succeeded'
    ])
    expect(entriesFor(restored.logger, 'action_pad.path_restore').at(-1)?.details).toMatchObject({
      source: 'path-preference',
      sourcePath: alternatePath
    })

    const migrated = setup()
    migrated.storageRecords.set(legacyActionPadStorageKey(endpoint), JSON.stringify({
      version: 1,
      sourcePath,
      activeConfig: edited('Ignored cache'),
      draft: edited('Ignored draft')
    }))

    await migrated.store.selectEndpoint(endpoint)

    expect(entriesFor(migrated.logger, 'action_pad.path_restore').at(-1)?.details).toMatchObject({
      source: 'legacy-recovery',
      sourcePath
    })
    expect(migrated.storage.setItem).toHaveBeenCalledWith(actionPadPathStorageKey(endpoint), sourcePath)
    expect(migrated.storage.removeItem).toHaveBeenCalledWith(legacyActionPadStorageKey(endpoint))
  })

  it('records direct load and save spans with the simplified phases and raw lifecycle', async () => {
    const test = setup()
    await test.connect()

    test.logger.clear()
    await test.store.load(sourcePath)
    expect(entriesFor(test.logger, 'action_pad.load').map(({ event }) => event)).toEqual([
      'action_pad.load.started',
      'action_pad.load.phase',
      'action_pad.load.succeeded'
    ])
    expect(entriesFor(test.logger, 'action_pad.load')[0]?.details).toMatchObject({
      path: sourcePath,
      endpoint,
      dirty: false
    })
    expect(entriesFor(test.logger, 'action_pad.load').at(-1)?.details).toMatchObject({
      rawLifecycle: {
        readDocument: { path: sourcePath, text: serializeActionPadConfig(fixture) }
      }
    })

    const workingConfig = edited('Saved diagnostics')
    test.store.setWorkingConfig(workingConfig)
    test.logger.clear()
    test.documents.readHostDocument.mockClear()
    await test.store.save(sourcePath)

    expect(entriesFor(test.logger, 'action_pad.save').map(({ event }) => event)).toEqual([
      'action_pad.save.started',
      'action_pad.save.phase',
      'action_pad.save.succeeded'
    ])
    expect(test.documents.readHostDocument).not.toHaveBeenCalled()
    expect(entriesFor(test.logger, 'action_pad.save')[0]?.details).toMatchObject({
      sourcePath,
      dirty: true
    })
    expect(entriesFor(test.logger, 'action_pad.save').at(-1)?.details).toMatchObject({
      sourcePath,
      dirty: false,
      rawLifecycle: {
        writeRequest: { path: sourcePath, text: serializeActionPadConfig(workingConfig) },
        writeCompleted: true
      }
    })
  })

  it('logs a slow direct write and its eventual success', async () => {
    const test = setup()
    await test.connect()
    const workingConfig = edited('Slow save')
    test.store.setWorkingConfig(workingConfig)
    const write = deferred<void>()
    test.documents.writeHostDocument.mockImplementationOnce(() => write.promise)
    test.logger.clear()
    jest.useFakeTimers()

    try {
      const saving = test.store.save(sourcePath)
      while (test.documents.writeHostDocument.mock.calls.length === 0) await Promise.resolve()
      await jest.advanceTimersByTimeAsync(15_000)

      expect(test.logger.getSnapshot().entries.find(({ event }) => event === 'action_pad.save.slow')).toMatchObject({
        level: 'warn',
        details: expect.objectContaining({
          operation: expect.objectContaining({ kind: 'save', phase: 'writing', slow: true })
        })
      })

      write.resolve()
      await saving
      expect(entriesFor(test.logger, 'action_pad.save').at(-1)?.event).toBe('action_pad.save.succeeded')
    } finally {
      jest.useRealTimers()
    }
  })

  it('records cancellation during a direct write without reconciliation state', async () => {
    const test = setup()
    await test.connect()
    const workingConfig = edited('Possibly partial')
    test.store.setWorkingConfig(workingConfig)
    const write = deferred<void>()
    test.documents.writeHostDocument.mockImplementationOnce(() => write.promise)
    test.logger.clear()

    const saving = test.store.save(sourcePath)
    while (test.documents.writeHostDocument.mock.calls.length === 0) await Promise.resolve()
    test.store.stopWaiting()
    await saving

    expect(entriesFor(test.logger, 'action_pad.save').at(-1)).toMatchObject({
      event: 'action_pad.save.cancelled',
      level: 'warn',
      details: expect.objectContaining({
        operation: expect.objectContaining({ phase: 'writing', writeStarted: true }),
        recommendedAction: expect.stringContaining('incomplete'),
        rawLifecycle: {
          writeRequest: { path: sourcePath, text: serializeActionPadConfig(workingConfig) }
        }
      })
    })
    expect(test.store.getState()).not.toHaveProperty('pendingSavePath')
    write.resolve()
    await Promise.resolve()
  })

  it('logs path persistence failure with the path only and keeps a successful save active', async () => {
    const test = setup()
    await test.connect()
    test.logger.clear()
    const workingConfig = edited('Saved but not remembered')
    test.store.setWorkingConfig(workingConfig)
    test.storage.setItem.mockRejectedValueOnce(new Error('Path storage full'))

    await test.store.save(alternatePath)

    expect(test.logger.getSnapshot().entries.map(({ event }) => event)).toContain('action_pad.path_persist_failed')
    expect(test.logger.getSnapshot().entries.find(
      ({ event }) => event === 'action_pad.path_persist_failed'
    )).toMatchObject({
      level: 'error',
      details: expect.objectContaining({
        key: actionPadPathStorageKey(endpoint),
        path: alternatePath,
        reason: expect.objectContaining({ message: 'Path storage full' })
      })
    })
    expect(JSON.stringify(test.storage.setItem.mock.calls)).not.toContain('Saved but not remembered')
    expect(test.store.getState()).toMatchObject({ activeConfig: workingConfig, sourcePath: alternatePath })
    expect(test.store.getState().notice?.severity).toBe('warning')
  })

  it('records direct-write failure with incomplete-file guidance and the host code', async () => {
    const test = setup()
    await test.connect()
    test.store.setWorkingConfig(edited('Failed write'))
    const failure = Object.assign(new Error('Permission denied after open'), {
      name: 'HostDocumentError',
      code: 'permission'
    })
    test.documents.writeHostDocument.mockRejectedValueOnce(failure)
    test.logger.clear()

    await test.store.save(sourcePath)

    expect(entriesFor(test.logger, 'action_pad.save').at(-1)).toMatchObject({
      event: 'action_pad.save.failed',
      level: 'error',
      details: expect.objectContaining({
        context: expect.objectContaining({
          notice: expect.objectContaining({
            recommendedAction: expect.stringContaining('incomplete'),
            details: expect.objectContaining({ hostErrorCode: 'permission', phase: 'writing' })
          }),
          rawLifecycle: {
            writeRequest: expect.objectContaining({ path: sourcePath })
          }
        })
      })
    })
  })
})
