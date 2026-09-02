import type { HostDocument } from '@codey/nvim-session'

import {
  createDiagnosticLogger,
  type DiagnosticEntry,
  type DiagnosticLogger
} from '../../diagnostics/logger'
import { serializeActionPadConfig, type ActionPadConfig } from '../document'
import { ActionPadConfigStore, type ActionPadHostDocuments } from '../store'

const sourcePath = '/storage/emulated/0/Codey/action-pad.yaml'
const alternatePath = '/storage/emulated/0/Alternate/action-pad.yaml'

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

async function waitForCalls(mock: jest.Mock, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (mock.mock.calls.length >= count) return
    await Promise.resolve()
  }
  throw new Error(`Expected ${count} calls, received ${mock.mock.calls.length}`)
}

async function settle(store: ActionPadConfigStore): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await Promise.resolve()
    if (!store.getState().busy) {
      await Promise.resolve()
      if (!store.getState().busy) return
    }
  }
  throw new Error('Action Pad store did not settle')
}

function createTestLogger(): DiagnosticLogger {
  const sink = jest.fn()
  return createDiagnosticLogger({
    console: { debug: sink, error: sink, info: sink, warn: sink }
  })
}

function setup() {
  let activePath = sourcePath
  const files = new Map<string, string>([[sourcePath, serializeActionPadConfig(fixture)]])
  const documents = {
    readActionPad: jest.fn(async (): Promise<HostDocument> => ({
      path: activePath,
      text: files.get(activePath) ?? null
    })),
    writeActionPad: jest.fn(async (text: string): Promise<void> => {
      files.set(activePath, text)
    })
  } satisfies ActionPadHostDocuments
  const logger = createTestLogger()
  const store = new ActionPadConfigStore(documents, sourcePath, logger)

  return {
    documents,
    files,
    logger,
    store,
    async connect() {
      await store.setConnected(true)
    },
    selectSource(path: string) {
      activePath = path
      store.selectSource(path)
    }
  }
}

function entriesFor(logger: DiagnosticLogger, prefix: string): readonly DiagnosticEntry[] {
  return logger.getSnapshot().entries.filter(({ event }) => event.startsWith(prefix))
}

describe('ActionPadConfigStore local diagnostics', () => {
  it('records local source and process connection changes without endpoint or storage metadata', async () => {
    const test = setup()
    const alternate = edited('Alternate')
    test.files.set(alternatePath, serializeActionPadConfig(alternate))

    test.selectSource(alternatePath)
    await test.connect()

    expect(test.logger.getSnapshot().entries.find(
      ({ event }) => event === 'action_pad.source_changed'
    )).toMatchObject({
      level: 'info',
      details: { sourcePath: alternatePath, generation: 1 }
    })
    expect(test.logger.getSnapshot().entries.find(
      ({ event }) => event === 'action_pad.connection_changed'
    )).toMatchObject({
      level: 'info',
      details: expect.objectContaining({
        connected: true,
        sourcePath: alternatePath,
        connectionGeneration: 1
      })
    })
    const serialized = JSON.stringify(test.logger.getSnapshot())
    expect(serialized).not.toContain('endpoint')
    expect(serialized).not.toContain('storageKey')
    expect(serialized).not.toContain('host:')
  })

  it('records load/save spans and lifecycle metadata without YAML contents', async () => {
    const test = setup()
    await test.connect()

    test.logger.clear()
    await test.store.load()

    expect(entriesFor(test.logger, 'action_pad.load').map(({ event }) => event)).toEqual([
      'action_pad.load.started',
      'action_pad.load.phase',
      'action_pad.load.succeeded'
    ])
    expect(entriesFor(test.logger, 'action_pad.load')[0]?.details).toMatchObject({
      path: sourcePath,
      dirty: false,
      generation: 0,
      connectionGeneration: 1
    })
    expect(entriesFor(test.logger, 'action_pad.load').at(-1)?.details).toMatchObject({
      sourcePath,
      dirty: false,
      lifecycle: {
        read: {
          path: sourcePath,
          missing: false,
          byteCount: expect.any(Number)
        }
      }
    })

    const secret = 'SECRET_ACTION_PAD_LABEL'
    const working = edited(secret)
    test.store.setWorkingConfig(working)
    test.logger.clear()
    test.documents.readActionPad.mockClear()
    await test.store.save()

    expect(entriesFor(test.logger, 'action_pad.save').map(({ event }) => event)).toEqual([
      'action_pad.save.started',
      'action_pad.save.phase',
      'action_pad.save.succeeded'
    ])
    expect(test.documents.readActionPad).not.toHaveBeenCalled()
    expect(entriesFor(test.logger, 'action_pad.save').at(-1)?.details).toMatchObject({
      sourcePath,
      dirty: false,
      lifecycle: {
        write: { path: sourcePath, byteCount: expect.any(Number) },
        writeCompleted: true
      }
    })
    expect(JSON.stringify(test.logger.getSnapshot())).not.toContain(secret)
  })

  it('logs a slow direct write and its eventual success', async () => {
    const test = setup()
    await test.connect()
    test.store.setWorkingConfig(edited('Slow save'))
    const write = deferred<void>()
    test.documents.writeActionPad.mockImplementationOnce(() => write.promise)
    test.logger.clear()
    jest.useFakeTimers()

    try {
      const saving = test.store.save()
      await waitForCalls(test.documents.writeActionPad, 1)
      await jest.advanceTimersByTimeAsync(15_000)

      expect(test.logger.getSnapshot().entries.find(
        ({ event }) => event === 'action_pad.save.slow'
      )).toMatchObject({
        level: 'warn',
        details: expect.objectContaining({
          operation: expect.objectContaining({
            kind: 'save', phase: 'writing', slow: true, writeStarted: true
          })
        })
      })

      write.resolve()
      await saving
      expect(entriesFor(test.logger, 'action_pad.save').at(-1)?.event).toBe(
        'action_pad.save.succeeded'
      )
    } finally {
      jest.useRealTimers()
    }
  })

  it('records local cancellation during a write without logging document text', async () => {
    const test = setup()
    await test.connect()
    const secret = 'SECRET_CANCELLED_WRITE'
    const working = edited(secret)
    test.store.setWorkingConfig(working)
    const write = deferred<void>()
    test.documents.writeActionPad.mockImplementationOnce(() => write.promise)
    test.logger.clear()

    const saving = test.store.save()
    await waitForCalls(test.documents.writeActionPad, 1)
    test.store.stopWaiting()
    await saving

    expect(entriesFor(test.logger, 'action_pad.save').at(-1)).toMatchObject({
      event: 'action_pad.save.cancelled',
      level: 'warn',
      details: expect.objectContaining({
        operation: expect.objectContaining({ phase: 'writing', writeStarted: true }),
        recommendedAction: expect.stringContaining('incomplete'),
        lifecycle: {
          write: { path: sourcePath, byteCount: expect.any(Number) }
        }
      })
    })
    expect(JSON.stringify(test.logger.getSnapshot())).not.toContain(secret)

    write.resolve()
    await Promise.resolve()
  })

  it('records native process failure details and restart guidance', async () => {
    const test = setup()
    await test.connect()
    const failure = Object.assign(new Error('Local Neovim exited'), {
      failure: {
        code: 'E_NVIM_EXIT',
        nativeCode: 'E_NVIM_EXIT',
        message: 'Local Neovim exited',
        nativeMessage: 'Process exited with code 1'
      }
    })
    test.documents.readActionPad.mockRejectedValueOnce(failure)
    test.logger.clear()

    await test.store.load()

    expect(entriesFor(test.logger, 'action_pad.load').at(-1)).toMatchObject({
      event: 'action_pad.load.failed',
      level: 'error',
      details: expect.objectContaining({
        context: expect.objectContaining({
          operation: expect.objectContaining({ phase: 'reading' }),
          failure: { kind: 'native-process', code: 'E_NVIM_EXIT' },
          lifecycle: {}
        })
      })
    })
    expect(JSON.stringify(test.logger.getSnapshot())).not.toContain('socketCode')
  })

  it('records host write failure with incomplete-file guidance and no YAML contents', async () => {
    const test = setup()
    await test.connect()
    const secret = 'SECRET_FAILED_WRITE'
    test.store.setWorkingConfig(edited(secret))
    const failure = Object.assign(new Error('Permission denied after open'), {
      name: 'HostDocumentError',
      code: 'permission'
    })
    test.documents.writeActionPad.mockRejectedValueOnce(failure)
    test.logger.clear()

    await test.store.save()

    expect(entriesFor(test.logger, 'action_pad.save').at(-1)).toMatchObject({
      event: 'action_pad.save.failed',
      level: 'error',
      details: expect.objectContaining({
        context: expect.objectContaining({
          operation: expect.objectContaining({ phase: 'writing' }),
          failure: { kind: 'file', code: 'permission' },
          lifecycle: {
            write: { path: sourcePath, byteCount: expect.any(Number) }
          }
        })
      })
    })
    expect(JSON.stringify(test.logger.getSnapshot())).not.toContain(secret)
  })

  it('does not retain malformed YAML source excerpts in failure diagnostics', async () => {
    const test = setup()
    await test.connect()
    const secret = 'SECRET_MALFORMED_YAML_LINE'
    test.files.set(sourcePath, `version: 1\n${secret}: [unterminated\n`)
    test.logger.clear()

    await test.store.load()

    expect(entriesFor(test.logger, 'action_pad.load').at(-1)).toMatchObject({
      event: 'action_pad.load.failed',
      details: expect.objectContaining({
        context: expect.objectContaining({
          operation: expect.objectContaining({ phase: 'reading' }),
          failure: { kind: 'configuration', issueCount: expect.any(Number) },
          lifecycle: {
            read: { path: sourcePath, missing: false, byteCount: expect.any(Number) }
          }
        })
      })
    })
    expect(JSON.stringify(test.logger.getSnapshot())).not.toContain(secret)
  })

  it('records source-generation cancellation without misreporting a late result as failure', async () => {
    const test = setup()
    await test.connect()
    const oldRead = deferred<HostDocument>()
    test.documents.readActionPad.mockImplementationOnce(() => oldRead.promise)
    test.logger.clear()
    const previousCalls = test.documents.readActionPad.mock.calls.length

    const loading = test.store.load()
    await waitForCalls(test.documents.readActionPad, previousCalls + 1)
    test.files.set(alternatePath, serializeActionPadConfig(edited('Current source')))
    test.selectSource(alternatePath)
    await settle(test.store)

    oldRead.resolve({ path: sourcePath, text: serializeActionPadConfig(edited('Stale source')) })
    await loading
    await Promise.resolve()

    expect(test.logger.getSnapshot().entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'action_pad.load.cancelled', level: 'warn' }),
      expect.objectContaining({ event: 'action_pad.source_changed', level: 'info' })
    ]))
    expect(test.logger.getSnapshot().entries.filter(
      ({ event }) => event === 'action_pad.load.failed'
    )).toHaveLength(0)
  })
})
