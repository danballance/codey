import type { HostDocument, HostDocumentWrite } from '@codey/nvim-session'

import { DEFAULT_ACTION_PAD_CONFIG } from '../config'
import { parseActionPadConfig, serializeActionPadConfig, type ActionPadConfig } from '../document'
import { ActionPadConfigStore, actionPadStorageKey, type ActionPadHostDocuments } from '../store'

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn() }
}))

const endpoint = { host: 'nvim.test', port: 6666 }
const otherEndpoint = { host: 'other.test', port: 6666 }
const sourcePath = '/home/test/action-pad.yaml'
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

function editLabel(config: ActionPadConfig, label = 'Changed'): ActionPadConfig {
  return {
    ...config,
    menus: config.menus.map((menu, index) => index === 0 ? { ...menu, label } : menu)
  }
}

function editButtonLabel(
  config: ActionPadConfig,
  label: ActionPadConfig['menus'][number]['groups'][number]['buttons'][number]['label']
): ActionPadConfig {
  return {
    ...config,
    menus: config.menus.map((menu, menuIndex) => menuIndex === 0 ? {
      ...menu,
      groups: menu.groups.map((group, groupIndex) => groupIndex === 0 ? {
        ...group,
        buttons: group.buttons.map((button, buttonIndex) => buttonIndex === 0
          ? { ...button, label }
          : button)
      } : group)
    } : menu)
  }
}

function withUnusedMenu(config: ActionPadConfig): ActionPadConfig {
  return {
    ...config,
    menus: [...config.menus, {
      id: 'unused', label: 'Unused', groups: [{
        id: 'tools', buttons: [{
          id: 'noop', label: 'No-op', styles: { size: '1/2' },
          tap: { type: 'input', nvimInput: '<Nop>', after: 'stay' }
        }]
      }]
    }]
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
  let revision = 0
  const files = new Map<string, HostDocument>()
  const storageRecords = new Map<string, string>()
  const put = (path: string, text: string, resolvedPath = path) => {
    const document = { path, resolvedPath, text, revision: String(++revision) }
    files.set(path, document)
    return document
  }
  if (initialText !== null) put(sourcePath, initialText)
  const documents = {
    defaultActionPadPath: jest.fn(async () => sourcePath),
    readHostDocument: jest.fn(async (_endpoint: typeof endpoint, path: string): Promise<HostDocument> => (
      files.get(path) ?? { path, resolvedPath: path, text: null, revision: null }
    )),
    writeHostDocument: jest.fn(async (_endpoint: typeof endpoint, request: HostDocumentWrite): Promise<HostDocument> => {
      const existing = files.get(request.path)
      if ((existing?.revision ?? null) !== request.expectedRevision) throw new Error('Host revision conflict')
      return put(request.path, request.text, existing?.resolvedPath)
    })
  } satisfies ActionPadHostDocuments
  const storage = {
    getItem: jest.fn(async (key: string): Promise<string | null> => storageRecords.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string): Promise<void> => { storageRecords.set(key, value) })
  }
  const store = new ActionPadConfigStore(documents, storage)
  const connect = async () => {
    await store.selectEndpoint(endpoint)
    await store.setConnected(true)
  }
  return { store, documents, storage, storageRecords, files, put, connect }
}

describe('ActionPadConfigStore', () => {
  it('loads an existing host file on connection and never creates a missing one during startup', async () => {
    const existing = setup()
    await existing.connect()
    expect(existing.store.getState().activeConfig).toEqual(fixture)
    expect(existing.store.getState().sourcePath).toBe(sourcePath)
    expect(existing.documents.writeHostDocument).not.toHaveBeenCalled()

    const missing = setup(null)
    await missing.connect()
    expect(missing.store.getState().activeConfig).toEqual(DEFAULT_ACTION_PAD_CONFIG)
    expect(missing.documents.writeHostDocument).not.toHaveBeenCalled()
    expect(missing.store.getState().message).toContain('Save will create')
  })

  it('keeps edits separate from active configuration until a confirmed save', async () => {
    const test = setup()
    await test.connect()
    const draft = editLabel(fixture)
    test.store.setDraft(draft)
    expect(test.store.getState()).toMatchObject({ activeConfig: fixture, draft, dirty: true })
    expect(test.documents.writeHostDocument).not.toHaveBeenCalled()
    await test.store.save(sourcePath)
    expect(test.store.getState()).toMatchObject({ activeConfig: draft, draft, dirty: false, error: false })
    expect(test.files.get(sourcePath)?.text).toBe(serializeActionPadConfig(draft))
    expect(test.documents.writeHostDocument).toHaveBeenCalledWith(endpoint, expect.objectContaining({
      path: sourcePath, expectedRevision: '1', expectedResolvedPath: sourcePath
    }))
  })

  it('recovers, saves, and reloads rich run colours and button styling without flattening them', async () => {
    const test = setup()
    await test.connect()
    const richLabel = [
      { text: '\uf07c ', fontSize: 22 as const, bold: false, color: '#9ece6a' },
      { text: 'Open', fontSize: 15 as const, bold: true, color: '#E0AF68' },
      { text: ' file', fontSize: 12 as const, bold: false }
    ]
    const labelled = editButtonLabel(fixture, richLabel)
    const firstMenu = labelled.menus[0]!
    const firstGroup = firstMenu.groups[0]!
    const draft: ActionPadConfig = {
      ...labelled,
      menus: [{
        ...firstMenu,
        groups: [{
          ...firstGroup,
          buttons: firstGroup.buttons.map((button, index) => index === 0 ? {
            ...button,
            styles: {
              size: '1/5', appearance: 'outline',
              backgroundColor: 'transparent', outlineColor: '#73daca'
            }
          } : button)
        }]
      }]
    }
    test.store.setDraft(draft)
    await test.store.flushRecovery()

    const restored = new ActionPadConfigStore(test.documents, test.storage)
    await restored.selectEndpoint(endpoint)
    expect(restored.getState()).toMatchObject({ activeConfig: fixture, draft, dirty: true })
    await restored.setConnected(true)
    await restored.save(sourcePath)

    const saved = parseActionPadConfig(test.files.get(sourcePath)!.text!)
    expect(saved.menus[0]!.groups[0]!.buttons[0]!.label).toEqual(richLabel)
    expect(saved.menus[0]!.groups[0]!.buttons[0]!.styles).toEqual({
      size: '1/5', appearance: 'outline', backgroundColor: 'transparent', outlineColor: '#73daca'
    })
    expect(restored.getState()).toMatchObject({ activeConfig: draft, draft, dirty: false })
  })

  it('recovers a removed menu offline and keeps it absent after save and a fresh reload', async () => {
    const original = withUnusedMenu(fixture)
    const test = setup(serializeActionPadConfig(original))
    await test.connect()
    const draft = { ...original, menus: original.menus.filter((menu) => menu.id !== 'unused') }
    test.store.setDraft(draft)
    await test.store.flushRecovery()

    const restored = new ActionPadConfigStore(test.documents, test.storage)
    await restored.selectEndpoint(endpoint)
    expect(restored.getState()).toMatchObject({ activeConfig: original, draft, dirty: true })

    await restored.setConnected(true)
    await restored.save(sourcePath)
    expect(restored.getState()).toMatchObject({ activeConfig: draft, draft, dirty: false })
    expect(parseActionPadConfig(test.files.get(sourcePath)!.text!).menus.map((menu) => menu.id)).toEqual(['home'])

    const reloaded = new ActionPadConfigStore(test.documents, {
      getItem: jest.fn(async () => null),
      setItem: jest.fn(async () => undefined)
    })
    await reloaded.selectEndpoint(endpoint)
    await reloaded.setConnected(true)
    expect(reloaded.getState()).toMatchObject({ activeConfig: draft, draft, dirty: false })
  })

  it('creates a chosen new file only on Save and does not overwrite an unlinked existing file', async () => {
    const test = setup(null)
    await test.connect()
    const newPath = '/home/test/new/action-pad.yaml'
    await test.store.save(newPath)
    expect(test.store.getState().sourcePath).toBe(newPath)
    expect(test.files.has(newPath)).toBe(true)
    test.put('/home/test/existing.yaml', serializeActionPadConfig(fixture))
    test.documents.writeHostDocument.mockClear()
    await test.store.save('/home/test/existing.yaml')
    expect(test.documents.writeHostDocument).not.toHaveBeenCalled()
    expect(test.store.getState().message).toContain('Save updates the active file')
  })

  it('keeps the active file and draft unchanged when Load is invalid, missing, or fails', async () => {
    const test = setup()
    await test.connect()
    const draft = editLabel(fixture)
    test.store.setDraft(draft)
    test.put('/bad.yaml', 'version: 99\n')
    await test.store.load('/bad.yaml')
    expect(test.store.getState()).toMatchObject({ sourcePath, activeConfig: fixture, draft, dirty: true, error: true })
    await test.store.load('/missing.yaml')
    expect(test.store.getState().message).toContain('does not exist')
    test.documents.readHostDocument.mockRejectedValueOnce(new Error('Permission denied'))
    await test.store.load('/private.yaml')
    expect(test.store.getState()).toMatchObject({ activeConfig: fixture, draft, message: 'Permission denied' })
  })

  it('rejects invalid drafts before file I/O and restores incomplete drafts safely', async () => {
    const test = setup()
    await test.connect()
    const firstMenu = fixture.menus[0]!
    const firstGroup = firstMenu.groups[0]!
    const draft: ActionPadConfig = {
      ...fixture,
      menus: [{
        ...firstMenu,
        groups: [{
          ...firstGroup,
          buttons: firstGroup.buttons.map((button, index) => index === 0
            ? { ...button, styles: { ...button.styles, backgroundColor: '#' } }
            : button)
        }]
      }]
    }
    test.store.setDraft(draft)
    test.documents.readHostDocument.mockClear()
    await test.store.save(sourcePath)
    expect(test.documents.readHostDocument).not.toHaveBeenCalled()
    expect(test.store.getState().dirty).toBe(true)
    await test.store.flushRecovery()
    const restored = new ActionPadConfigStore(test.documents, test.storage)
    await restored.selectEndpoint(endpoint)
    expect(restored.getState()).toMatchObject({ activeConfig: fixture, draft, dirty: true })
  })

  it('retains drafts offline and never uploads them when reconnecting', async () => {
    const test = setup()
    await test.connect()
    await test.store.setConnected(false)
    const draft = editLabel(fixture)
    test.store.setDraft(draft)
    await test.store.save(sourcePath)
    expect(test.store.getState().message).toContain('Connect to the Neovim host')
    await test.store.setConnected(true)
    expect(test.store.getState()).toMatchObject({ activeConfig: fixture, draft, dirty: true })
    expect(test.documents.writeHostDocument).not.toHaveBeenCalled()
  })

  it('queues a fresh clean-file read when reconnecting during an obsolete refresh', async () => {
    const test = setup()
    await test.connect()
    await test.store.setConnected(false)
    const newer = editLabel(fixture, 'Host version')
    test.put(sourcePath, serializeActionPadConfig(newer))
    const stale = deferred<HostDocument>()
    const refreshed = deferred<void>()
    test.documents.readHostDocument.mockImplementationOnce(() => stale.promise)
    test.documents.readHostDocument.mockImplementationOnce(async (_endpoint, path) => {
      refreshed.resolve()
      return test.files.get(path)!
    })
    const oldRefresh = test.store.setConnected(true)
    await Promise.resolve()
    await test.store.setConnected(false)
    await test.store.setConnected(true)
    stale.reject(new Error('Old connection closed'))
    await oldRefresh
    await refreshed.promise
    await Promise.resolve()
    expect(test.store.getState()).toMatchObject({ activeConfig: newer, connected: true, dirty: false })
    expect(test.documents.readHostDocument).toHaveBeenCalledTimes(3)
  })

  it('persists unresolved ID fields separately, keeps them dirty, and prevents saving a hidden valid value', async () => {
    const test = setup()
    await test.connect()
    const idDrafts = { 'menus[0].groups[0].buttons[0].id': '' }
    test.store.setIdDrafts(idDrafts)
    expect(test.store.getState()).toMatchObject({ activeConfig: fixture, draft: fixture, dirty: true, idDrafts })
    await test.store.flushRecovery()
    const restored = new ActionPadConfigStore(test.documents, test.storage)
    await restored.selectEndpoint(endpoint)
    await restored.setConnected(true)
    expect(restored.getState()).toMatchObject({ dirty: true, idDrafts })
    await restored.save(sourcePath)
    expect(test.documents.writeHostDocument).not.toHaveBeenCalled()
    expect(restored.getState().message).toContain('incomplete ID edits')
    restored.discardDraft()
    expect(restored.getState()).toMatchObject({ idDrafts: {}, dirty: false })
    restored.setIdDrafts(idDrafts)
    await restored.load(sourcePath)
    expect(restored.getState()).toMatchObject({ idDrafts: {}, dirty: false })
  })

  it('detects external changes and symlink retargeting without overwriting either', async () => {
    const test = setup()
    await test.connect()
    test.store.setDraft(editLabel(fixture))
    test.put(sourcePath, serializeActionPadConfig(editLabel(fixture, 'Outside edit')))
    await test.store.save(sourcePath)
    expect(test.store.getState().message).toContain('changed outside Codey')
    expect(test.documents.writeHostDocument).not.toHaveBeenCalled()
    await test.store.load(sourcePath)
    test.store.setDraft(editLabel(fixture))
    const baseline = test.files.get(sourcePath)!
    test.files.set(sourcePath, { ...baseline, resolvedPath: '/another/target.yaml' })
    await test.store.save(sourcePath)
    expect(test.documents.writeHostDocument).not.toHaveBeenCalled()
  })

  it('keeps a failed save recoverable and reconciles lost acknowledgements without writing twice', async () => {
    const test = setup()
    await test.connect()
    const draft = editLabel(fixture)
    test.store.setDraft(draft)
    test.documents.writeHostDocument.mockImplementationOnce(async (_endpoint, request) => {
      test.put(request.path, request.text)
      throw new Error('Connection lost after writing')
    })
    await test.store.save(sourcePath)
    expect(test.store.getState()).toMatchObject({ activeConfig: fixture, draft, dirty: true, error: true })
    await test.store.flushRecovery()
    const restored = new ActionPadConfigStore(test.documents, test.storage)
    await restored.selectEndpoint(endpoint)
    await restored.setConnected(true)
    expect(restored.getState().dirty).toBe(true)
    await restored.save(sourcePath)
    expect(test.documents.writeHostDocument).toHaveBeenCalledTimes(1)
    expect(restored.getState()).toMatchObject({ activeConfig: draft, dirty: false, error: false })
  })

  it('keeps the first save destination through recovery and refuses to redirect an uncertain save', async () => {
    const test = setup(null)
    await test.connect()
    const destination = '/home/test/first-save.yaml'
    const draft = editLabel(DEFAULT_ACTION_PAD_CONFIG)
    test.store.setDraft(draft)
    test.documents.writeHostDocument.mockImplementationOnce(async (_endpoint, request) => {
      test.put(request.path, request.text)
      throw new Error('Lost acknowledgement')
    })
    await test.store.save(destination)
    expect(test.store.getState().pendingSavePath).toBe(destination)
    await test.store.flushRecovery()
    const restored = new ActionPadConfigStore(test.documents, test.storage)
    await restored.selectEndpoint(endpoint)
    await restored.setConnected(true)
    expect(restored.getState().pendingSavePath).toBe(destination)
    await restored.save(sourcePath)
    expect(restored.getState().message).toContain('was not confirmed')
    expect(test.documents.writeHostDocument).toHaveBeenCalledTimes(1)
    expect(test.files.has(sourcePath)).toBe(false)
    await restored.save(restored.getState().pendingSavePath!)
    expect(test.documents.writeHostDocument).toHaveBeenCalledTimes(1)
    expect(restored.getState()).toMatchObject({ sourcePath: destination, pendingSavePath: null, dirty: false })
  })

  it('does not redirect an unconfirmed first save through a retargeted symlink', async () => {
    const test = setup(null)
    await test.connect()
    const path = '/home/test/linked/action-pad.yaml'
    test.files.set(path, { path, resolvedPath: '/first/action-pad.yaml', text: null, revision: null })
    test.documents.writeHostDocument.mockRejectedValueOnce(new Error('Write response lost'))
    await test.store.save(path)
    expect(test.store.getState().pendingSavePath).toBe(path)
    test.files.set(path, { path, resolvedPath: '/second/action-pad.yaml', text: null, revision: null })
    await test.store.save(path)
    expect(test.documents.writeHostDocument).toHaveBeenCalledTimes(1)
    expect(test.store.getState()).toMatchObject({ pendingSavePath: path, error: true })
    expect(test.store.getState().message).toContain('now points to a different file')
  })

  it('preserves edits made while a save is in progress', async () => {
    const test = setup()
    await test.connect()
    const firstDraft = editLabel(fixture, 'First')
    test.store.setDraft(firstDraft)
    const result = deferred<HostDocument>()
    test.documents.writeHostDocument.mockImplementationOnce(() => result.promise)
    const saving = test.store.save(sourcePath)
    while (test.documents.writeHostDocument.mock.calls.length === 0) await Promise.resolve()
    const newerDraft = editLabel(fixture, 'Newer')
    test.store.setDraft(newerDraft)
    result.resolve(test.put(sourcePath, serializeActionPadConfig(firstDraft)))
    await saving
    expect(test.store.getState()).toMatchObject({ activeConfig: firstDraft, draft: newerDraft, dirty: true })
  })

  it('exports a snapshot with confirmation without changing the link, active pad, or dirty state', async () => {
    const test = setup()
    await test.connect()
    const richLabel = [
      { text: '\uf07c ', fontSize: 22 as const, bold: false },
      { text: 'Export', fontSize: 15 as const, bold: true },
      { text: ' copy', fontSize: 12 as const, bold: false }
    ]
    const draft = editButtonLabel(fixture, richLabel)
    test.store.setDraft(draft)
    const destination = '/home/test/export.yaml'
    test.put(destination, 'existing backup')
    const refuse = jest.fn(async () => false)
    await test.store.export(destination, refuse)
    expect(refuse).toHaveBeenCalledWith(destination)
    expect(test.files.get(destination)?.text).toBe('existing backup')
    await test.store.export(destination, async () => true)
    expect(test.files.get(destination)?.text).toBe(serializeActionPadConfig(draft))
    expect(parseActionPadConfig(test.files.get(destination)!.text!).menus[0]!.groups[0]!.buttons[0]!.label).toEqual(richLabel)
    expect(test.store.getState()).toMatchObject({ sourcePath, activeConfig: fixture, draft, dirty: true })
    test.documents.writeHostDocument.mockClear()
    await test.store.export(sourcePath, async () => true)
    expect(test.documents.writeHostDocument).not.toHaveBeenCalled()
    expect(test.store.getState().message).toContain('different file')
  })

  it('does not send a save after switching endpoints while its initial read is pending', async () => {
    const test = setup()
    await test.connect()
    test.store.setDraft(editLabel(fixture))
    const result = deferred<HostDocument>()
    test.documents.readHostDocument.mockImplementationOnce(() => result.promise)
    const saving = test.store.save(sourcePath)
    await test.store.selectEndpoint(otherEndpoint)
    result.resolve(test.files.get(sourcePath)!)
    await saving
    expect(test.documents.writeHostDocument).not.toHaveBeenCalled()
    expect(test.store.getState()).toMatchObject({ endpoint: otherEndpoint, activeConfig: DEFAULT_ACTION_PAD_CONFIG, dirty: false })
    await test.store.selectEndpoint(endpoint)
    expect(test.store.getState().dirty).toBe(true)
  })

  it('serializes recovery writes and discards only the draft', async () => {
    const test = setup()
    await test.connect()
    test.store.setDraft(editLabel(fixture, 'One'))
    test.store.setDraft(editLabel(fixture, 'Two'))
    await test.store.flushRecovery()
    const record = JSON.parse(test.storageRecords.get(actionPadStorageKey(endpoint))!)
    expect(record.draft.menus[0].label).toBe('Two')
    test.store.discardDraft()
    expect(test.store.getState()).toMatchObject({ activeConfig: fixture, draft: fixture, dirty: false })
    expect(test.documents.writeHostDocument).not.toHaveBeenCalled()
  })

  it('rejects legacy recovery configurations without explicit button sizes', async () => {
    const test = setup()
    test.storageRecords.set(actionPadStorageKey(endpoint), JSON.stringify({
      version: 1,
      sourcePath,
      activeConfig: {
        version: 1,
        rootMenuId: 'home',
        menus: [{
          id: 'home', label: 'Home', groups: [{
            id: 'main', buttons: [{
              id: 'escape', label: 'Esc',
              tap: { type: 'input', nvimInput: '<Esc>', after: 'stay' }
            }]
          }]
        }]
      },
      draft: null,
      idDrafts: {},
      baseline: null,
      pendingSave: null
    }))

    await test.store.selectEndpoint(endpoint)

    expect(test.store.getState()).toMatchObject({
      activeConfig: DEFAULT_ACTION_PAD_CONFIG,
      draft: DEFAULT_ACTION_PAD_CONFIG,
      dirty: false,
      error: true
    })
    expect(test.store.getState().message).toContain('Invalid cached configuration')
  })

  it('falls back safely on malformed recovery data and reports storage failure', async () => {
    const test = setup()
    test.storageRecords.set(actionPadStorageKey(endpoint), '{"version":1,"sourcePath":"/a","activeConfig":null}')
    await test.store.selectEndpoint(endpoint)
    expect(test.store.getState()).toMatchObject({ activeConfig: DEFAULT_ACTION_PAD_CONFIG, error: true })
    test.storage.setItem.mockRejectedValueOnce(new Error('Storage full'))
    test.store.setDraft(editLabel(DEFAULT_ACTION_PAD_CONFIG))
    await test.store.flushRecovery()
    expect(test.store.getState().recoveryWarning).toContain('Storage full')
    expect(test.store.getState().dirty).toBe(true)
  })
})
