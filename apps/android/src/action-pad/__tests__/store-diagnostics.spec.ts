import type { HostDocument, HostDocumentWrite } from '@codey/nvim-session'

import {
  createDiagnosticLogger,
  type DiagnosticEntry,
  type DiagnosticLogger
} from '../../diagnostics/logger'
import { serializeActionPadConfig, type ActionPadConfig } from '../document'
import { ActionPadConfigStore, actionPadStorageKey, type ActionPadHostDocuments } from '../store'

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn() }
}))

const endpoint = { host: 'diagnostics.nvim.test', port: 7777 }
const sourcePath = '/home/test/action-pad.yaml'
const exportPath = '/home/test/action-pad-export.yaml'
const fixture: ActionPadConfig = {
  version: 1,
  rootMenuId: 'home',
  menus: [{
    id: 'home',
    label: 'Home',
    groups: [{
      id: 'main',
      buttons: [{
        id: 'escape',
        label: 'Esc',
        styles: { size: '1/2' },
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
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function createTestLogger(): DiagnosticLogger {
  const sink = jest.fn()
  return createDiagnosticLogger({
    console: { debug: sink, error: sink, info: sink, warn: sink }
  })
}

function setup(initialText: string | null = serializeActionPadConfig(fixture)) {
  let revision = 0
  const files = new Map<string, HostDocument>()
  const storageRecords = new Map<string, string>()
  const put = (path: string, text: string | null, resolvedPath = path): HostDocument => {
    const document = {
      path,
      resolvedPath,
      text,
      revision: text === null ? null : String(++revision)
    }
    files.set(path, document)
    return document
  }
  if (initialText !== null) put(sourcePath, initialText)
  const documents = {
    defaultActionPadPath: jest.fn(async () => sourcePath),
    readHostDocument: jest.fn(async (
      _endpoint: typeof endpoint,
      path: string
    ): Promise<HostDocument> => files.get(path) ?? {
      path,
      resolvedPath: path,
      text: null,
      revision: null
    }),
    writeHostDocument: jest.fn(async (
      _endpoint: typeof endpoint,
      request: HostDocumentWrite
    ): Promise<HostDocument> => put(request.path, request.text))
  } satisfies ActionPadHostDocuments
  const storage = {
    getItem: jest.fn(async (key: string): Promise<string | null> => storageRecords.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string): Promise<void> => {
      storageRecords.set(key, value)
    })
  }
  const logger = createTestLogger()
  const store = new ActionPadConfigStore(documents, storage, undefined, logger)
  const connect = async (): Promise<void> => {
    await store.selectEndpoint(endpoint)
    await store.setConnected(true)
    await store.flushRecovery()
  }
  return { connect, documents, files, logger, put, storage, storageRecords, store }
}

function entriesFor(logger: DiagnosticLogger, prefix: string): readonly DiagnosticEntry[] {
  return logger.getSnapshot().entries.filter(({ event }) => event.startsWith(prefix))
}

describe('ActionPadConfigStore diagnostics', () => {
  it('records recovery restore success and failure with the raw recovery payload', async () => {
    const restoredDraft = edited('Recovered draft')
    const successful = setup()
    const recovery = {
      version: 1,
      sourcePath,
      activeConfig: fixture,
      draft: restoredDraft,
      idDrafts: {},
      baseline: {
        path: sourcePath,
        resolvedPath: sourcePath,
        revision: 'host-revision-1'
      },
      pendingSave: null
    }
    const rawRecovery = JSON.stringify(recovery)
    successful.storageRecords.set(actionPadStorageKey(endpoint), rawRecovery)

    await successful.store.selectEndpoint(endpoint)

    expect(entriesFor(successful.logger, 'action_pad.recovery_restore').map(
      ({ event }) => event
    )).toEqual([
      'action_pad.recovery_restore.started',
      'action_pad.recovery_restore.succeeded'
    ])
    expect(entriesFor(successful.logger, 'action_pad.recovery_restore')[1]?.details).toMatchObject({
      raw: rawRecovery,
      record: expect.objectContaining({ draft: restoredDraft }),
      dirty: true
    })

    const failed = setup()
    const malformed = '{"version":1,"sourcePath":"/private/raw","activeConfig":null}'
    failed.storageRecords.set(actionPadStorageKey(endpoint), malformed)

    await failed.store.selectEndpoint(endpoint)

    expect(entriesFor(failed.logger, 'action_pad.recovery_restore').map(
      ({ event }) => event
    )).toEqual([
      'action_pad.recovery_restore.started',
      'action_pad.recovery_restore.failed'
    ])
    expect(entriesFor(failed.logger, 'action_pad.recovery_restore')[1]?.details).toMatchObject({
      error: expect.objectContaining({ message: expect.stringContaining('Invalid') }),
      context: expect.objectContaining({ endpoint })
    })
  })

  it('records load, save, and cancelled export spans with phases and raw context', async () => {
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
      activeConfig: fixture,
      draft: fixture
    })
    expect(entriesFor(test.logger, 'action_pad.load').at(-1)?.details).toMatchObject({
      rawLifecycle: {
        readDocument: expect.objectContaining({
          path: sourcePath,
          text: serializeActionPadConfig(fixture)
        })
      }
    })

    const draft = edited('Saved diagnostics draft')
    test.logger.clear()
    test.store.setDraft(draft)
    await test.store.flushRecovery()
    expect(test.logger.getSnapshot().entries).toEqual([])

    await test.store.save(sourcePath)
    expect(entriesFor(test.logger, 'action_pad.save').map(({ event }) => event)).toEqual([
      'action_pad.save.started',
      'action_pad.save.phase',
      'action_pad.save.phase',
      'action_pad.save.phase',
      'action_pad.save.succeeded'
    ])
    expect(entriesFor(test.logger, 'action_pad.save')[0]?.details).toMatchObject({
      draft,
      activeConfig: fixture
    })
    expect(entriesFor(test.logger, 'action_pad.save').at(-1)?.details).toMatchObject({
      activeConfig: draft,
      pendingSave: null,
      rawLifecycle: {
        readDocument: expect.objectContaining({ path: sourcePath }),
        writeRequest: expect.objectContaining({
          path: sourcePath,
          text: serializeActionPadConfig(draft)
        }),
        writeDocument: expect.objectContaining({
          path: sourcePath,
          text: serializeActionPadConfig(draft)
        })
      }
    })

    test.put(exportPath, 'unredacted existing export contents')
    test.logger.clear()
    await test.store.export(exportPath, async () => false)
    expect(entriesFor(test.logger, 'action_pad.export').map(({ event }) => event)).toEqual([
      'action_pad.export.started',
      'action_pad.export.phase',
      'action_pad.export.cancelled'
    ])
    expect(entriesFor(test.logger, 'action_pad.export').at(-1)?.details).toMatchObject({
      requestedPath: exportPath,
      current: expect.objectContaining({
        path: exportPath,
        text: 'unredacted existing export contents'
      }),
      rawLifecycle: expect.objectContaining({
        overwriteConfirmation: { path: exportPath, confirmed: false }
      })
    })
  })

  it('logs a slow checkpoint and still records the eventual successful terminal result', async () => {
    const test = setup()
    await test.connect()
    const draft = edited('Slow save')
    test.store.setDraft(draft)
    await test.store.flushRecovery()
    test.logger.clear()
    const read = deferred<HostDocument>()
    test.documents.readHostDocument.mockImplementationOnce(() => read.promise)
    jest.useFakeTimers()

    try {
      const saving = test.store.save(sourcePath)
      while (test.documents.readHostDocument.mock.calls.length < 2) await Promise.resolve()

      await jest.advanceTimersByTimeAsync(15_000)

      expect(test.logger.getSnapshot().entries.find(
        ({ event }) => event === 'action_pad.save.slow'
      )).toMatchObject({
        level: 'warn',
        details: expect.objectContaining({
          operation: expect.objectContaining({
            kind: 'save',
            phase: 'checking-host-file',
            slow: true
          })
        })
      })

      read.resolve(test.files.get(sourcePath)!)
      await saving
      expect(entriesFor(test.logger, 'action_pad.save').at(-1)?.event).toBe(
        'action_pad.save.succeeded'
      )
    } finally {
      jest.useRealTimers()
    }
  })

  it('records uncertain cancellation and a read-only reconciliation without replaying the write', async () => {
    const test = setup()
    await test.connect()
    const draft = edited('Possibly saved')
    test.store.setDraft(draft)
    await test.store.flushRecovery()
    test.logger.clear()
    const write = deferred<HostDocument>()
    test.documents.writeHostDocument.mockImplementationOnce(() => write.promise)

    const saving = test.store.save(sourcePath)
    while (test.documents.writeHostDocument.mock.calls.length === 0) await Promise.resolve()
    test.store.stopWaiting()
    await saving

    const cancellation = entriesFor(test.logger, 'action_pad.save').at(-1)
    expect(cancellation).toMatchObject({
      event: 'action_pad.save.cancelled',
      level: 'warn',
      details: expect.objectContaining({
        operation: expect.objectContaining({ writeStarted: true }),
        recommendedAction: expect.stringContaining('check save'),
        rawLifecycle: expect.objectContaining({
          writeRequest: expect.objectContaining({
            path: sourcePath,
            text: serializeActionPadConfig(draft)
          })
        })
      })
    })
    expect(test.store.getState().pendingSavePath).toBe(sourcePath)

    const written = test.put(sourcePath, serializeActionPadConfig(draft))
    write.resolve(written)
    await Promise.resolve()
    test.logger.clear()

    await test.store.reconcilePendingSave()

    expect(entriesFor(test.logger, 'action_pad.reconcile').map(({ event }) => event)).toEqual([
      'action_pad.reconcile.started',
      'action_pad.reconcile.phase',
      'action_pad.reconcile.succeeded'
    ])
    expect(test.documents.writeHostDocument).toHaveBeenCalledTimes(1)
    expect(test.store.getState()).toMatchObject({
      activeConfig: draft,
      pendingSavePath: null,
      dirty: false
    })
    expect(entriesFor(test.logger, 'action_pad.reconcile').at(-1)?.details).toMatchObject({
      rawLifecycle: {
        pendingSave: expect.objectContaining({ path: sourcePath }),
        readDocument: expect.objectContaining({
          path: sourcePath,
          text: serializeActionPadConfig(draft)
        })
      }
    })
  })

  it('logs failed recovery persistence with the full encoded record but no success noise', async () => {
    const test = setup()
    await test.connect()
    test.logger.clear()

    const firstDraft = edited('Persisted without operational noise')
    test.store.setDraft(firstDraft)
    await test.store.flushRecovery()
    expect(test.logger.getSnapshot().entries).toEqual([])

    const failure = new Error('Recovery storage full')
    test.storage.setItem.mockRejectedValueOnce(failure)
    const secondDraft = edited('Unredacted failed recovery payload')
    test.store.setDraft(secondDraft)
    await test.store.flushRecovery()

    expect(test.logger.getSnapshot().entries.map(({ event }) => event)).toEqual([
      'action_pad.recovery_persist_failed'
    ])
    expect(test.logger.getSnapshot().entries[0]).toMatchObject({
      level: 'error',
      details: expect.objectContaining({
        record: expect.objectContaining({ draft: secondDraft }),
        encoded: expect.stringContaining('Unredacted failed recovery payload'),
        reason: expect.objectContaining({ message: 'Recovery storage full' })
      })
    })
  })
})
