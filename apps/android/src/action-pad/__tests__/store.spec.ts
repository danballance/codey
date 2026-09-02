import type { HostDocument } from '@codey/nvim-session'

import { createDiagnosticLogger } from '../../diagnostics/logger'
import { DEFAULT_ACTION_PAD_CONFIG } from '../config'
import { parseActionPadConfig, serializeActionPadConfig, type ActionPadConfig } from '../document'
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

function edited(label = 'Changed'): ActionPadConfig {
  return {
    ...fixture,
    menus: fixture.menus.map((menu, index) => index === 0 ? { ...menu, label } : menu)
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
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

function setup(options: {
  readonly initialSourcePath?: string
  readonly initialText?: string | null
} = {}) {
  let activePath = options.initialSourcePath ?? sourcePath
  const files = new Map<string, string>()
  if (options.initialText !== null) {
    files.set(sourcePath, options.initialText ?? serializeActionPadConfig(fixture))
  }
  const documents = {
    readActionPad: jest.fn(async (): Promise<HostDocument> => ({
      path: activePath,
      text: files.get(activePath) ?? null
    })),
    writeActionPad: jest.fn(async (text: string): Promise<void> => {
      files.set(activePath, text)
    })
  } satisfies ActionPadHostDocuments
  const sink = jest.fn()
  const logger = createDiagnosticLogger({
    console: { debug: sink, error: sink, info: sink, warn: sink }
  })
  const store = new ActionPadConfigStore(documents, activePath, logger)

  return {
    documents,
    files,
    logger,
    store,
    async connect(preservation = { fieldEdits: false }) {
      await store.setConnected(true, preservation)
    },
    selectSource(path: string | null) {
      activePath = path ?? ''
      store.selectSource(path)
    }
  }
}

describe('ActionPadConfigStore fixed local source', () => {
  it('loads the fixed document on first connection without writing', async () => {
    const test = setup()

    await test.connect()

    expect(test.documents.readActionPad).toHaveBeenCalledTimes(1)
    expect(test.documents.readActionPad).toHaveBeenCalledWith()
    expect(test.documents.writeActionPad).not.toHaveBeenCalled()
    expect(test.store.getState()).toMatchObject({
      sourcePath,
      activeConfig: fixture,
      workingConfig: fixture,
      dirty: false,
      busy: false,
      connected: true,
      initialLoadPending: false,
      error: false
    })
  })

  it('uses the starter for a missing document and creates it only on Save', async () => {
    const test = setup({ initialText: null })

    await test.connect()

    expect(test.store.getState()).toMatchObject({
      sourcePath,
      activeConfig: DEFAULT_ACTION_PAD_CONFIG,
      workingConfig: DEFAULT_ACTION_PAD_CONFIG,
      dirty: false
    })
    expect(test.store.getState().message).toContain('Save will create')
    expect(test.documents.writeActionPad).not.toHaveBeenCalled()

    await test.store.save()

    expect(test.documents.writeActionPad).toHaveBeenCalledTimes(1)
    expect(parseActionPadConfig(test.files.get(sourcePath)!)).toEqual(DEFAULT_ACTION_PAD_CONFIG)
  })

  it('blocks initial access without a source, then loads when a fixed source is selected', async () => {
    const test = setup({ initialSourcePath: '' })

    await test.connect()

    expect(test.documents.readActionPad).not.toHaveBeenCalled()
    expect(test.store.getState()).toMatchObject({ sourcePath: '', initialLoadPending: true })
    expect(test.store.getState().message).toContain('Choose a Neovim config folder')

    test.files.set(alternatePath, serializeActionPadConfig(edited('Selected source')))
    test.selectSource(alternatePath)
    await settle(test.store)

    expect(test.documents.readActionPad).toHaveBeenCalledTimes(1)
    expect(test.store.getState()).toMatchObject({
      sourcePath: alternatePath,
      activeConfig: edited('Selected source'),
      initialLoadPending: false
    })
  })

  it('reloads the same source after confirmed dirty-edit discard', async () => {
    const test = setup()
    await test.connect()
    test.store.setWorkingConfig(edited('Unsaved local edit'))
    const external = edited('Reloaded from disk')
    test.files.set(sourcePath, serializeActionPadConfig(external))

    await test.store.load()

    expect(test.documents.readActionPad).toHaveBeenCalledTimes(2)
    expect(test.store.getState()).toMatchObject({
      sourcePath,
      activeConfig: external,
      workingConfig: external,
      dirty: false,
      error: false
    })
  })

  it('keeps the current active and working state when reload data is invalid', async () => {
    const test = setup()
    await test.connect()
    const working = edited('Keep this edit')
    test.store.setWorkingConfig(working)
    test.files.set(sourcePath, 'version: 99\n')

    await test.store.load()

    expect(test.store.getState()).toMatchObject({
      sourcePath,
      activeConfig: fixture,
      workingConfig: working,
      dirty: true,
      busy: false,
      error: true
    })
    expect(test.store.getState().message).toContain('version')
  })

  it('keeps edits separate from the active pad and discards them only in memory', async () => {
    const test = setup()
    await test.connect()
    const working = edited()

    test.store.setWorkingConfig(working)
    expect(test.store.getState()).toMatchObject({
      activeConfig: fixture,
      workingConfig: working,
      dirty: true
    })

    test.store.discardWorkingConfig()

    expect(test.store.getState()).toMatchObject({
      activeConfig: fixture,
      workingConfig: fixture,
      dirty: false
    })
    expect(test.documents.writeActionPad).not.toHaveBeenCalled()
  })

  it('serializes and saves the working snapshot without a pre-read', async () => {
    const test = setup()
    await test.connect()
    const working = edited('Serialized locally')
    test.store.setWorkingConfig(working)
    test.documents.readActionPad.mockClear()

    await test.store.save()

    expect(test.documents.readActionPad).not.toHaveBeenCalled()
    expect(test.documents.writeActionPad).toHaveBeenCalledWith(
      serializeActionPadConfig(working)
    )
    expect(parseActionPadConfig(test.files.get(sourcePath)!)).toEqual(working)
    expect(test.store.getState()).toMatchObject({
      activeConfig: working,
      workingConfig: working,
      dirty: false,
      error: false
    })
  })

  it('rejects a semantically invalid snapshot before invoking the write', async () => {
    const test = setup()
    await test.connect()
    const menu = fixture.menus[0]!
    const invalid = { ...fixture, menus: [menu, { ...menu }] }
    test.store.setWorkingConfig(invalid)

    await test.store.save()

    expect(test.documents.writeActionPad).not.toHaveBeenCalled()
    expect(test.store.getState()).toMatchObject({
      activeConfig: fixture,
      workingConfig: invalid,
      dirty: true,
      error: true
    })
  })

  it('activates the written snapshot while preserving newer edits made during the write', async () => {
    const test = setup()
    await test.connect()
    const saved = edited('Written snapshot')
    const newer = edited('Newer unsaved edit')
    test.store.setWorkingConfig(saved)
    const write = deferred<void>()
    test.documents.writeActionPad.mockImplementationOnce(() => write.promise)

    const saving = test.store.save()
    await waitForCalls(test.documents.writeActionPad, 1)
    test.store.setWorkingConfig(newer)
    write.resolve()
    await saving

    expect(test.store.getState()).toMatchObject({
      activeConfig: saved,
      workingConfig: newer,
      dirty: true
    })
    expect(test.store.getState().message).toContain('Newer edits')
  })

  it('ignores concurrent load/save requests while one write is active', async () => {
    const test = setup()
    await test.connect()
    test.store.setWorkingConfig(edited('One write'))
    const write = deferred<void>()
    test.documents.writeActionPad.mockImplementationOnce(() => write.promise)
    test.documents.readActionPad.mockClear()

    const saving = test.store.save()
    await waitForCalls(test.documents.writeActionPad, 1)
    await test.store.load()
    await test.store.save()

    expect(test.documents.writeActionPad).toHaveBeenCalledTimes(1)
    expect(test.documents.readActionPad).not.toHaveBeenCalled()
    write.resolve()
    await saving
  })

  it('does not reload or upload dirty offline edits on reconnect', async () => {
    const test = setup()
    await test.connect()
    await test.store.setConnected(false)
    const working = edited('Offline edit')
    test.store.setWorkingConfig(working)
    test.documents.readActionPad.mockClear()
    test.documents.writeActionPad.mockClear()

    await test.store.save()
    expect(test.documents.writeActionPad).not.toHaveBeenCalled()
    expect(test.store.getState().message).toContain('Start local Neovim')

    await test.store.setConnected(true)

    expect(test.documents.readActionPad).not.toHaveBeenCalled()
    expect(test.store.getState()).toMatchObject({
      activeConfig: fixture,
      workingConfig: working,
      dirty: true
    })
  })

  it('defers the first load for preserved field edits and resumes exactly once when cleared', async () => {
    const test = setup()

    await test.connect({ fieldEdits: true })

    expect(test.documents.readActionPad).not.toHaveBeenCalled()
    expect(test.store.getState()).toMatchObject({ initialLoadPending: true, dirty: false })

    const read = deferred<HostDocument>()
    test.documents.readActionPad.mockImplementationOnce(() => read.promise)
    test.store.setConnectionPreservation({ fieldEdits: false })
    test.store.setConnectionPreservation({ fieldEdits: false })
    await waitForCalls(test.documents.readActionPad, 1)
    read.resolve({ path: sourcePath, text: serializeActionPadConfig(fixture) })
    await settle(test.store)

    expect(test.documents.readActionPad).toHaveBeenCalledTimes(1)
    expect(test.store.getState()).toMatchObject({
      activeConfig: fixture,
      workingConfig: fixture,
      initialLoadPending: false
    })
  })

  it('marks a slow write and still accepts its eventual result', async () => {
    const test = setup()
    await test.connect()
    const saved = edited('Slow save')
    test.store.setWorkingConfig(saved)
    const write = deferred<void>()
    test.documents.writeActionPad.mockImplementationOnce(() => write.promise)
    jest.useFakeTimers()

    try {
      const saving = test.store.save()
      await waitForCalls(test.documents.writeActionPad, 1)
      expect(test.store.getState().operation).toMatchObject({
        kind: 'save', phase: 'writing', slow: false, writeStarted: true
      })

      await jest.advanceTimersByTimeAsync(15_000)
      expect(test.store.getState().operation).toMatchObject({ slow: true })

      write.resolve()
      await saving
      expect(test.store.getState()).toMatchObject({
        activeConfig: saved,
        dirty: false,
        busy: false,
        operation: null
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it('stops waiting for a write without treating a late completion as saved', async () => {
    const test = setup()
    await test.connect()
    const working = edited('Possibly partial')
    test.store.setWorkingConfig(working)
    const write = deferred<void>()
    test.documents.writeActionPad.mockImplementationOnce(() => write.promise)

    const saving = test.store.save()
    await waitForCalls(test.documents.writeActionPad, 1)
    test.store.stopWaiting()
    await saving

    expect(test.store.getState()).toMatchObject({
      busy: false,
      operation: null,
      activeConfig: fixture,
      workingConfig: working,
      dirty: true
    })
    expect(test.store.getState().notice?.recommendedAction).toContain('may be incomplete')

    write.resolve()
    await Promise.resolve()
    expect(test.store.getState()).toMatchObject({ activeConfig: fixture, dirty: true })
  })

  it('cancels before a scheduled write starts when the process disconnects', async () => {
    const test = setup()
    await test.connect()
    test.store.setWorkingConfig(edited('Never written'))
    test.documents.writeActionPad.mockClear()

    const saving = test.store.save()
    await test.store.setConnected(false)
    await saving

    expect(test.documents.writeActionPad).not.toHaveBeenCalled()
    expect(test.store.getState()).toMatchObject({ busy: false, connected: false, dirty: true })
    expect(test.store.getState().message).toContain('before any write began')
    expect(test.store.getState().notice?.recommendedAction).toContain('Start Neovim again')
  })

  it('cancels a pending write on disconnect and ignores its late completion', async () => {
    const test = setup()
    await test.connect()
    const working = edited('Interrupted write')
    test.store.setWorkingConfig(working)
    const write = deferred<void>()
    test.documents.writeActionPad.mockImplementationOnce(() => write.promise)

    const saving = test.store.save()
    await waitForCalls(test.documents.writeActionPad, 1)
    await test.store.setConnected(false)
    await saving

    expect(test.store.getState()).toMatchObject({
      connected: false,
      activeConfig: fixture,
      workingConfig: working,
      dirty: true
    })
    expect(test.store.getState().message).toContain('save was in progress')
    expect(test.store.getState().notice?.recommendedAction).toContain('incomplete')

    write.resolve()
    await Promise.resolve()
    expect(test.store.getState()).toMatchObject({ activeConfig: fixture, dirty: true })
  })

  it('ignores a late load result after the selected source generation changes', async () => {
    const test = setup()
    await test.connect()
    const oldRead = deferred<HostDocument>()
    test.documents.readActionPad.mockImplementationOnce(() => oldRead.promise)
    const previousCalls = test.documents.readActionPad.mock.calls.length

    const loading = test.store.load()
    await waitForCalls(test.documents.readActionPad, previousCalls + 1)
    const alternate = edited('New source')
    test.files.set(alternatePath, serializeActionPadConfig(alternate))
    test.selectSource(alternatePath)
    await settle(test.store)

    oldRead.resolve({ path: sourcePath, text: serializeActionPadConfig(edited('Stale source')) })
    await loading
    await Promise.resolve()

    expect(test.store.getState()).toMatchObject({
      sourcePath: alternatePath,
      activeConfig: alternate,
      workingConfig: alternate,
      dirty: false
    })
  })

  it('ignores a late write completion after the selected source generation changes', async () => {
    const test = setup()
    await test.connect()
    const oldWorking = edited('Old source write')
    test.store.setWorkingConfig(oldWorking)
    const oldWrite = deferred<void>()
    test.documents.writeActionPad.mockImplementationOnce(() => oldWrite.promise)

    const saving = test.store.save()
    await waitForCalls(test.documents.writeActionPad, 1)
    const alternate = edited('New source content')
    test.files.set(alternatePath, serializeActionPadConfig(alternate))
    test.selectSource(alternatePath)
    await settle(test.store)

    oldWrite.resolve()
    await saving
    await Promise.resolve()

    expect(test.store.getState()).toMatchObject({
      sourcePath: alternatePath,
      activeConfig: alternate,
      workingConfig: alternate,
      dirty: false
    })
  })

  it('surfaces native process failures without replacing in-memory edits', async () => {
    const test = setup()
    await test.connect()
    const working = edited('Keep after process exit')
    test.store.setWorkingConfig(working)
    const failure = Object.assign(new Error('Local Neovim exited'), {
      failure: {
        code: 'E_NVIM_EXIT',
        nativeCode: 'E_NVIM_EXIT',
        message: 'Local Neovim exited',
        nativeMessage: 'Process exited with code 1'
      }
    })
    test.documents.readActionPad.mockRejectedValueOnce(failure)

    await test.store.load()

    expect(test.store.getState()).toMatchObject({
      activeConfig: fixture,
      workingConfig: working,
      dirty: true,
      error: true
    })
    expect(test.store.getState().notice).toMatchObject({
      details: {
        nativeCode: 'E_NVIM_EXIT',
        nativeMessage: 'Process exited with code 1'
      },
      recommendedAction: expect.stringContaining('Restart Neovim')
    })
  })

  it('retains dirty state and warns about possible partial data after a host write failure', async () => {
    const test = setup()
    await test.connect()
    const working = edited('Failed write')
    test.store.setWorkingConfig(working)
    const failure = Object.assign(new Error('Permission denied after open'), {
      name: 'HostDocumentError',
      code: 'permission'
    })
    test.documents.writeActionPad.mockRejectedValueOnce(failure)

    await test.store.save()

    expect(test.store.getState()).toMatchObject({
      activeConfig: fixture,
      workingConfig: working,
      dirty: true,
      error: true
    })
    expect(test.store.getState().notice).toMatchObject({
      details: { hostErrorCode: 'permission', phase: 'writing' },
      recommendedAction: expect.stringContaining('incomplete')
    })
  })
})
