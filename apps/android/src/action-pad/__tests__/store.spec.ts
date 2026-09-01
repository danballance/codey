import type { HostDocument, HostDocumentWrite } from '@codey/nvim-session'

import {
  actionPadEndpointForTarget,
  LOCAL_ACTION_PAD_FILE_NAME,
  DEFAULT_LOCAL_TARGET
} from '../../connection-target'
import { createDiagnosticLogger } from '../../diagnostics/logger'
import { DEFAULT_ACTION_PAD_CONFIG } from '../config'
import { parseActionPadConfig, serializeActionPadConfig, type ActionPadConfig } from '../document'
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

const endpoint = { host: 'nvim.test', port: 6666 }
const otherEndpoint = { host: 'other.test', port: 7777 }
const localEndpoint = actionPadEndpointForTarget(DEFAULT_LOCAL_TARGET)
const sourcePath = '/home/test/action-pad.yaml'
const alternatePath = '/home/test/alternate.yaml'
const localConfigDirectory = '/storage/emulated/0/Codey'
const localActionPadPath = `${localConfigDirectory}/${LOCAL_ACTION_PAD_FILE_NAME}`
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
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function setup(initialText: string | null = serializeActionPadConfig(fixture)) {
  const files = new Map<string, string>()
  const storageRecords = new Map<string, string>()
  if (initialText !== null) files.set(sourcePath, initialText)
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
  const sink = jest.fn()
  const logger = createDiagnosticLogger({ console: { debug: sink, error: sink, info: sink, warn: sink } })
  const store = new ActionPadConfigStore(documents, storage, undefined, logger)
  const connect = async () => {
    await store.selectEndpoint(endpoint)
    await store.setConnected(true)
  }
  return { connect, documents, files, storage, storageRecords, store }
}

describe('ActionPadConfigStore', () => {
  it('loads the default file on first connection and persists only its path', async () => {
    const test = setup()

    await test.connect()

    expect(test.documents.defaultActionPadPath).toHaveBeenCalledWith(endpoint)
    expect(test.documents.readHostDocument).toHaveBeenCalledWith(endpoint, sourcePath)
    expect(test.documents.writeHostDocument).not.toHaveBeenCalled()
    expect(test.store.getState()).toMatchObject({
      sourcePath,
      activeConfig: fixture,
      workingConfig: fixture,
      dirty: false
    })
    expect(test.storageRecords.get(actionPadPathStorageKey(endpoint))).toBe(sourcePath)
    expect(test.storageRecords.get(actionPadPathStorageKey(endpoint))).not.toContain('activeConfig')
  })

  it('uses the starter for a missing selected file and creates it only on Save', async () => {
    const test = setup(null)
    await test.connect()

    expect(test.store.getState()).toMatchObject({
      sourcePath,
      activeConfig: DEFAULT_ACTION_PAD_CONFIG,
      workingConfig: DEFAULT_ACTION_PAD_CONFIG,
      dirty: false
    })
    expect(test.store.getState().message).toContain('Save will create')
    expect(test.documents.writeHostDocument).not.toHaveBeenCalled()

    await test.store.save(sourcePath)
    expect(parseActionPadConfig(test.files.get(sourcePath)!)).toEqual(DEFAULT_ACTION_PAD_CONFIG)
  })

  it('restores a remembered path without resolving the default', async () => {
    const test = setup()
    const alternate = edited('Remembered')
    test.files.set(alternatePath, serializeActionPadConfig(alternate))
    test.storageRecords.set(actionPadPathStorageKey(endpoint), alternatePath)

    await test.connect()

    expect(test.documents.defaultActionPadPath).not.toHaveBeenCalled()
    expect(test.documents.readHostDocument).toHaveBeenCalledWith(endpoint, alternatePath)
    expect(test.store.getState()).toMatchObject({ sourcePath: alternatePath, activeConfig: alternate })
  })

  it('loads the fixed Local Action Pad path supplied by connection setup', async () => {
    const test = setup(null)
    test.files.set(localActionPadPath, serializeActionPadConfig(fixture))
    test.storageRecords.set(actionPadPathStorageKey(localEndpoint), localConfigDirectory)

    await test.store.selectEndpoint(localEndpoint, localActionPadPath)
    await test.store.setConnected(true)

    expect(test.documents.defaultActionPadPath).not.toHaveBeenCalled()
    expect(test.documents.readHostDocument).toHaveBeenCalledWith(localEndpoint, localActionPadPath)
    expect(test.store.getState()).toMatchObject({
      sourcePath: localActionPadPath,
      activeConfig: fixture
    })
    expect(test.storage.setItem).not.toHaveBeenCalled()
  })

  it('does not resolve a private Local fallback when no config path was supplied', async () => {
    const test = setup()

    await test.store.selectEndpoint(localEndpoint)
    await test.store.setConnected(true)

    expect(test.documents.defaultActionPadPath).not.toHaveBeenCalled()
    expect(test.documents.readHostDocument).not.toHaveBeenCalled()
    expect(test.store.getState().message).toContain('Choose a Neovim config folder')
    expect(test.storageRecords.has(actionPadPathStorageKey(localEndpoint))).toBe(false)
  })

  it('ignores an older Local YAML preference instead of treating it as a directory', async () => {
    const test = setup(null)
    const legacyFileLocation = '/storage/emulated/0/legacy-action-pad.yaml'
    test.storageRecords.set(actionPadPathStorageKey(localEndpoint), legacyFileLocation)
    test.files.set(localActionPadPath, serializeActionPadConfig(fixture))

    await test.store.selectEndpoint(localEndpoint, localActionPadPath)
    await test.store.setConnected(true)

    expect(test.documents.readHostDocument).toHaveBeenCalledWith(localEndpoint, localActionPadPath)
    expect(test.store.getState().sourcePath).toBe(localActionPadPath)
    expect(test.storage.setItem).not.toHaveBeenCalled()
  })

  it('saves Local edits only to the fixed path without persisting a path preference', async () => {
    const test = setup(null)
    await test.store.selectEndpoint(localEndpoint, localActionPadPath)
    await test.store.setConnected(true)
    test.store.setWorkingConfig(edited())

    await test.store.save(localActionPadPath)

    expect(test.documents.writeHostDocument).toHaveBeenCalledWith(
      localEndpoint,
      expect.objectContaining({ path: localActionPadPath })
    )
    expect(test.storage.setItem).not.toHaveBeenCalled()
  })

  it('migrates only sourcePath from legacy recovery and removes the journal', async () => {
    const test = setup()
    const recoveredDraft = edited('Must not recover')
    const legacyKey = legacyActionPadStorageKey(endpoint)
    test.storageRecords.set(legacyKey, JSON.stringify({
      version: 1,
      sourcePath: alternatePath,
      activeConfig: recoveredDraft,
      draft: recoveredDraft,
      idDrafts: { 'menus[0].id': 'local-only' },
      baseline: { path: alternatePath, resolvedPath: alternatePath, revision: '1' },
      pendingSave: { path: alternatePath, text: 'unconfirmed bytes' }
    }))

    await test.store.selectEndpoint(endpoint)

    expect(test.store.getState()).toMatchObject({
      sourcePath: alternatePath,
      activeConfig: DEFAULT_ACTION_PAD_CONFIG,
      workingConfig: DEFAULT_ACTION_PAD_CONFIG,
      dirty: false
    })
    expect(test.storageRecords.get(actionPadPathStorageKey(endpoint))).toBe(alternatePath)
    expect(test.storageRecords.has(legacyKey)).toBe(false)
    expect(test.storage.removeItem).toHaveBeenCalledWith(legacyKey)
  })

  it('falls back to the default after an invalid stored path', async () => {
    const test = setup()
    test.storageRecords.set(actionPadPathStorageKey(endpoint), 'relative/action-pad.yaml')

    await test.store.selectEndpoint(endpoint)
    expect(test.store.getState()).toMatchObject({ sourcePath: '', busy: false })
    expect(test.store.getState().notice?.severity).toBe('warning')

    await test.store.setConnected(true)
    expect(test.documents.defaultActionPadPath).toHaveBeenCalled()
    expect(test.store.getState().sourcePath).toBe(sourcePath)
  })

  it('keeps working edits separate from the active pad and discards them in memory', async () => {
    const test = setup()
    await test.connect()
    const workingConfig = edited()

    test.store.setWorkingConfig(workingConfig)
    expect(test.store.getState()).toMatchObject({ activeConfig: fixture, workingConfig, dirty: true })
    expect(test.storageRecords.get(actionPadPathStorageKey(endpoint))).toBe(sourcePath)

    test.store.discardWorkingConfig()
    expect(test.store.getState()).toMatchObject({
      activeConfig: fixture,
      workingConfig: fixture,
      dirty: false
    })
    expect(test.documents.writeHostDocument).not.toHaveBeenCalled()
  })

  it('saves directly with last-writer-wins semantics and never pre-reads', async () => {
    const test = setup()
    await test.connect()
    const workingConfig = edited('Local wins')
    test.store.setWorkingConfig(workingConfig)
    test.files.set(sourcePath, serializeActionPadConfig(edited('Outside change')))
    test.documents.readHostDocument.mockClear()

    await test.store.save(sourcePath)

    expect(test.documents.readHostDocument).not.toHaveBeenCalled()
    expect(test.documents.writeHostDocument).toHaveBeenCalledWith(endpoint, {
      path: sourcePath,
      text: serializeActionPadConfig(workingConfig)
    })
    expect(test.store.getState()).toMatchObject({
      sourcePath,
      activeConfig: workingConfig,
      workingConfig,
      dirty: false,
      error: false
    })
  })

  it('selects and remembers a new Save destination only after write success', async () => {
    const test = setup()
    await test.connect()
    const workingConfig = edited('New destination')
    test.store.setWorkingConfig(workingConfig)
    const destination = '/home/test/new/action-pad.yaml'

    await test.store.save(destination)

    expect(test.store.getState()).toMatchObject({ sourcePath: destination, activeConfig: workingConfig })
    expect(test.storageRecords.get(actionPadPathStorageKey(endpoint))).toBe(destination)
    expect(test.files.get(destination)).toBe(serializeActionPadConfig(workingConfig))
  })

  it('retains active and working state when a direct save fails and warns about partial data', async () => {
    const test = setup()
    await test.connect()
    const workingConfig = edited('Still in memory')
    test.store.setWorkingConfig(workingConfig)
    const destination = '/home/test/failing.yaml'
    test.documents.writeHostDocument.mockRejectedValueOnce(new Error('Write failed after truncation'))

    await test.store.save(destination)

    expect(test.store.getState()).toMatchObject({
      sourcePath,
      activeConfig: fixture,
      workingConfig,
      dirty: true,
      error: true
    })
    expect(test.store.getState().notice?.recommendedAction).toContain('incomplete')
    expect(test.storageRecords.get(actionPadPathStorageKey(endpoint))).toBe(sourcePath)
  })

  it('validates the working snapshot before invoking the host write', async () => {
    const test = setup()
    await test.connect()
    const menu = fixture.menus[0]!
    const invalid = { ...fixture, menus: [menu, { ...menu }] }
    test.store.setWorkingConfig(invalid)

    await test.store.save(sourcePath)

    expect(test.documents.writeHostDocument).not.toHaveBeenCalled()
    expect(test.store.getState()).toMatchObject({ activeConfig: fixture, workingConfig: invalid, dirty: true })
  })

  it('activates the saved snapshot while preserving edits made during the write', async () => {
    const test = setup()
    await test.connect()
    const saved = edited('Saved snapshot')
    const newer = edited('Newer edit')
    test.store.setWorkingConfig(saved)
    const write = deferred<void>()
    test.documents.writeHostDocument.mockImplementationOnce(() => write.promise)

    const saving = test.store.save(sourcePath)
    while (test.documents.writeHostDocument.mock.calls.length === 0) await Promise.resolve()
    test.store.setWorkingConfig(newer)
    write.resolve()
    await saving

    expect(test.store.getState()).toMatchObject({ activeConfig: saved, workingConfig: newer, dirty: true })
    expect(test.store.getState().message).toContain('Newer edits')
  })

  it('loads another file and selects a missing file as a starter-backed destination', async () => {
    const test = setup()
    await test.connect()
    const alternate = edited('Loaded alternate')
    test.files.set(alternatePath, serializeActionPadConfig(alternate))
    test.store.setWorkingConfig(edited('Discarded by confirmed UI action'))

    await test.store.load(alternatePath)
    expect(test.store.getState()).toMatchObject({
      sourcePath: alternatePath,
      activeConfig: alternate,
      workingConfig: alternate,
      dirty: false
    })
    expect(test.storageRecords.get(actionPadPathStorageKey(endpoint))).toBe(alternatePath)

    const missing = '/home/test/missing.yaml'
    await test.store.load(missing)
    expect(test.store.getState()).toMatchObject({
      sourcePath: missing,
      activeConfig: DEFAULT_ACTION_PAD_CONFIG,
      workingConfig: DEFAULT_ACTION_PAD_CONFIG,
      dirty: false
    })
    expect(test.documents.writeHostDocument).not.toHaveBeenCalled()
  })

  it('leaves the current path and configurations unchanged when Load is invalid', async () => {
    const test = setup()
    await test.connect()
    const workingConfig = edited('Keep me')
    test.store.setWorkingConfig(workingConfig)
    test.files.set(alternatePath, 'version: 99\n')

    await test.store.load(alternatePath)

    expect(test.store.getState()).toMatchObject({
      sourcePath,
      activeConfig: fixture,
      workingConfig,
      dirty: true,
      error: true
    })
    expect(test.storageRecords.get(actionPadPathStorageKey(endpoint))).toBe(sourcePath)
  })

  it('does not reload or upload dirty in-memory edits on reconnect', async () => {
    const test = setup()
    await test.connect()
    await test.store.setConnected(false)
    const workingConfig = edited('Offline edit')
    test.store.setWorkingConfig(workingConfig)
    test.documents.readHostDocument.mockClear()

    await test.store.save(sourcePath)
    expect(test.documents.writeHostDocument).not.toHaveBeenCalled()
    expect(test.store.getState().message).toContain('Connect')

    await test.store.setConnected(true)
    expect(test.documents.readHostDocument).not.toHaveBeenCalled()
    expect(test.store.getState()).toMatchObject({
      activeConfig: fixture,
      workingConfig,
      dirty: true
    })
  })

  it('does not silently reload a clean configuration on reconnect', async () => {
    const test = setup()
    await test.connect()
    test.files.set(sourcePath, serializeActionPadConfig(edited('Outside change')))
    test.documents.readHostDocument.mockClear()

    await test.store.setConnected(false)
    await test.store.setConnected(true)

    expect(test.documents.readHostDocument).not.toHaveBeenCalled()
    expect(test.store.getState()).toMatchObject({ activeConfig: fixture, workingConfig: fixture, dirty: false })
  })

  it.each([
    { fieldEdits: false, storeEdit: true },
    { fieldEdits: true, storeEdit: false }
  ])('resumes the deferred load when config or field edits are manually reverted', async ({
    fieldEdits,
    storeEdit
  }) => {
    const test = setup()
    await test.store.selectEndpoint(endpoint)
    const workingConfig = edited('Offline edit')
    if (storeEdit) test.store.setWorkingConfig(workingConfig)

    await test.store.setConnected(true, { fieldEdits, pathEdit: false })

    expect(test.documents.defaultActionPadPath).toHaveBeenCalledWith(endpoint)
    expect(test.documents.readHostDocument).not.toHaveBeenCalled()
    expect(test.storageRecords.get(actionPadPathStorageKey(endpoint))).toBe(sourcePath)
    expect(test.store.getState()).toMatchObject({
      sourcePath,
      activeConfig: DEFAULT_ACTION_PAD_CONFIG,
      workingConfig: storeEdit ? workingConfig : DEFAULT_ACTION_PAD_CONFIG,
      dirty: storeEdit,
      initialLoadPending: true
    })

    if (storeEdit) test.store.setWorkingConfig(DEFAULT_ACTION_PAD_CONFIG)
    else test.store.setConnectionPreservation({ fieldEdits: false, pathEdit: false })
    expect(test.store.getState()).toMatchObject({ busy: true, initialLoadPending: true })
    while (test.store.getState().busy) await Promise.resolve()

    expect(test.documents.readHostDocument).toHaveBeenCalledWith(endpoint, sourcePath)
    expect(test.store.getState()).toMatchObject({
      sourcePath,
      activeConfig: fixture,
      workingConfig: fixture,
      dirty: false,
      initialLoadPending: false
    })
  })

  it('resumes the deferred load when a locally edited path is manually reverted', async () => {
    const test = setup()
    await test.store.selectEndpoint(endpoint)

    await test.store.setConnected(true, { fieldEdits: false, pathEdit: true })

    expect(test.documents.defaultActionPadPath).not.toHaveBeenCalled()
    expect(test.documents.readHostDocument).not.toHaveBeenCalled()
    expect(test.store.getState()).toMatchObject({
      sourcePath: '',
      activeConfig: DEFAULT_ACTION_PAD_CONFIG,
      initialLoadPending: true
    })

    test.store.setConnectionPreservation({ fieldEdits: false, pathEdit: false })
    expect(test.store.getState()).toMatchObject({ busy: true, initialLoadPending: true })
    while (test.store.getState().busy) await Promise.resolve()

    expect(test.documents.defaultActionPadPath).toHaveBeenCalledWith(endpoint)
    expect(test.documents.readHostDocument).toHaveBeenCalledWith(endpoint, sourcePath)
    expect(test.store.getState()).toMatchObject({
      sourcePath,
      activeConfig: fixture,
      workingConfig: fixture,
      initialLoadPending: false
    })
  })

  it('queues only one resumed read when preservation clears during a busy deferred refresh', async () => {
    const test = setup()
    await test.store.selectEndpoint(endpoint)
    await test.store.setConnected(true, { fieldEdits: true, pathEdit: false })
    const read = deferred<HostDocument>()
    test.documents.readHostDocument.mockImplementationOnce(() => read.promise)

    test.store.setConnectionPreservation({ fieldEdits: false, pathEdit: false })
    test.store.setConnectionPreservation({ fieldEdits: false, pathEdit: false })
    while (test.documents.readHostDocument.mock.calls.length === 0) await Promise.resolve()
    read.resolve({ path: sourcePath, text: serializeActionPadConfig(fixture) })
    while (test.store.getState().busy) await Promise.resolve()

    expect(test.documents.readHostDocument).toHaveBeenCalledTimes(1)
    expect(test.store.getState()).toMatchObject({ activeConfig: fixture, initialLoadPending: false })
  })

  it('does not retry a failed initial read queued by repeated preservation-clear notifications', async () => {
    const test = setup()
    await test.store.selectEndpoint(endpoint)
    const read = deferred<HostDocument>()
    test.documents.readHostDocument.mockImplementationOnce(() => read.promise)

    const connecting = test.store.setConnected(true)
    while (test.documents.readHostDocument.mock.calls.length === 0) await Promise.resolve()
    test.store.setConnectionPreservation({ fieldEdits: false, pathEdit: false })
    test.store.setConnectionPreservation({ fieldEdits: false, pathEdit: false })
    read.reject(new Error('Initial Action Pad read failed'))
    await connecting
    await Promise.resolve()

    expect(test.documents.readHostDocument).toHaveBeenCalledTimes(1)
    expect(test.store.getState()).toMatchObject({
      busy: false,
      error: true,
      initialLoadPending: true,
      message: 'Initial Action Pad read failed'
    })
  })

  it.each(['config', 'field', 'path'] as const)(
    'does not publish an automatic first load when a new %s edit appears during the host read',
    async (editKind) => {
      const test = setup()
      await test.store.selectEndpoint(endpoint)
      const firstRead = deferred<HostDocument>()
      test.documents.readHostDocument.mockImplementationOnce(() => firstRead.promise)

      const connecting = test.store.setConnected(true)
      while (test.documents.readHostDocument.mock.calls.length === 0) await Promise.resolve()

      if (editKind === 'config') test.store.setWorkingConfig(edited('Edit during read'))
      else test.store.setConnectionPreservation({
        fieldEdits: editKind === 'field',
        pathEdit: editKind === 'path'
      })
      firstRead.resolve({ path: sourcePath, text: serializeActionPadConfig(fixture) })
      await connecting

      expect(test.store.getState()).toMatchObject({
        activeConfig: DEFAULT_ACTION_PAD_CONFIG,
        dirty: editKind === 'config',
        initialLoadPending: true
      })
      expect(test.documents.readHostDocument).toHaveBeenCalledTimes(1)

      if (editKind === 'config') test.store.setWorkingConfig(DEFAULT_ACTION_PAD_CONFIG)
      else test.store.setConnectionPreservation({ fieldEdits: false, pathEdit: false })
      while (test.store.getState().busy) await Promise.resolve()

      expect(test.documents.readHostDocument).toHaveBeenCalledTimes(2)
      expect(test.store.getState()).toMatchObject({
        activeConfig: fixture,
        workingConfig: fixture,
        dirty: false,
        initialLoadPending: false
      })
    }
  )

  it('resumes a deferred initial load on reconnect when edits were discarded offline', async () => {
    const test = setup()
    await test.store.selectEndpoint(endpoint)
    test.store.setWorkingConfig(edited('Offline edit'))
    await test.store.setConnected(true, { fieldEdits: false, pathEdit: false })
    expect(test.documents.readHostDocument).not.toHaveBeenCalled()

    await test.store.setConnected(false)
    test.store.discardWorkingConfig()
    expect(test.documents.readHostDocument).not.toHaveBeenCalled()

    await test.store.setConnected(true)
    expect(test.documents.readHostDocument).toHaveBeenCalledWith(endpoint, sourcePath)
    expect(test.store.getState()).toMatchObject({ activeConfig: fixture, workingConfig: fixture, dirty: false })
  })

  it('stops waiting for a write without treating it as saved', async () => {
    const test = setup()
    await test.connect()
    const workingConfig = edited('Possibly partial')
    test.store.setWorkingConfig(workingConfig)
    const write = deferred<void>()
    test.documents.writeHostDocument.mockImplementationOnce(() => write.promise)

    const saving = test.store.save(sourcePath)
    while (test.documents.writeHostDocument.mock.calls.length === 0) await Promise.resolve()
    test.store.stopWaiting()
    await saving

    expect(test.store.getState()).toMatchObject({
      busy: false,
      operation: null,
      activeConfig: fixture,
      workingConfig,
      dirty: true
    })
    expect(test.store.getState().notice?.recommendedAction).toContain('may be incomplete')
    write.resolve()
    await Promise.resolve()
  })

  it('ignores late completion after an endpoint switch', async () => {
    const test = setup()
    await test.connect()
    test.store.setWorkingConfig(edited('Old endpoint edit'))
    const write = deferred<void>()
    test.documents.writeHostDocument.mockImplementationOnce(() => write.promise)

    const saving = test.store.save(sourcePath)
    while (test.documents.writeHostDocument.mock.calls.length === 0) await Promise.resolve()
    await test.store.selectEndpoint(otherEndpoint)
    write.resolve()
    await saving
    await Promise.resolve()

    expect(test.store.getState()).toMatchObject({
      endpoint: otherEndpoint,
      sourcePath: '',
      activeConfig: DEFAULT_ACTION_PAD_CONFIG,
      workingConfig: DEFAULT_ACTION_PAD_CONFIG,
      dirty: false
    })
  })

  it('keeps a successful load or save usable when path persistence fails', async () => {
    const loadTest = setup()
    await loadTest.connect()
    const alternate = edited('Loaded despite storage')
    loadTest.files.set(alternatePath, serializeActionPadConfig(alternate))
    loadTest.storage.setItem.mockRejectedValueOnce(new Error('Storage full'))

    await loadTest.store.load(alternatePath)
    expect(loadTest.store.getState()).toMatchObject({ sourcePath: alternatePath, activeConfig: alternate })
    expect(loadTest.store.getState().notice?.severity).toBe('warning')

    const saveTest = setup()
    await saveTest.connect()
    const saved = edited('Saved despite storage')
    saveTest.store.setWorkingConfig(saved)
    saveTest.storage.setItem.mockRejectedValueOnce(new Error('Storage full'))
    await saveTest.store.save(alternatePath)
    expect(saveTest.store.getState()).toMatchObject({ sourcePath: alternatePath, activeConfig: saved })
    expect(saveTest.store.getState().notice?.severity).toBe('warning')
    expect(saveTest.files.get(alternatePath)).toBe(serializeActionPadConfig(saved))
  })

  it('marks a pending host operation slow and still accepts its result', async () => {
    jest.useFakeTimers()
    const test = setup()
    try {
      await test.connect()
      const saved = edited('Slow save')
      test.store.setWorkingConfig(saved)
      const write = deferred<void>()
      test.documents.writeHostDocument.mockImplementationOnce(() => write.promise)
      const saving = test.store.save(sourcePath)
      while (test.documents.writeHostDocument.mock.calls.length === 0) await Promise.resolve()

      expect(test.store.getState().operation).toMatchObject({ kind: 'save', phase: 'writing', slow: false })
      await jest.advanceTimersByTimeAsync(15_000)
      expect(test.store.getState().operation).toMatchObject({ slow: true })

      write.resolve()
      await saving
      expect(test.store.getState()).toMatchObject({ activeConfig: saved, busy: false, operation: null })
    } finally {
      jest.useRealTimers()
    }
  })
})
