import AsyncStorage from '@react-native-async-storage/async-storage'
import type { HostDocument, HostDocumentWrite } from '@codey/nvim-session'

import { DEFAULT_ENDPOINT, type Endpoint } from '../endpoint'
import { DEFAULT_ACTION_PAD_CONFIG } from './config'
import {
  ACTION_PAD_CONFIG_MAX_BYTES,
  isActionPadConfigShape,
  parseActionPadConfig,
  serializeActionPadConfig,
  validateActionPadConfig,
  type ActionPadConfig
} from './document'

export interface ActionPadHostDocuments {
  defaultActionPadPath(endpoint: Endpoint): Promise<string>
  readHostDocument(endpoint: Endpoint, path: string): Promise<HostDocument>
  writeHostDocument(endpoint: Endpoint, request: HostDocumentWrite): Promise<HostDocument>
}

interface DocumentBaseline {
  readonly path: string
  readonly resolvedPath: string
  readonly revision: string | null
}

interface PendingSave extends DocumentBaseline {
  readonly text: string
}

export interface ActionPadStoreState {
  readonly endpoint: Endpoint
  readonly sourcePath: string
  readonly pendingSavePath: string | null
  readonly activeConfig: ActionPadConfig
  readonly draft: ActionPadConfig
  readonly idDrafts: Readonly<Record<string, string>>
  readonly dirty: boolean
  readonly busy: boolean
  readonly connected: boolean
  readonly message: string
  readonly error: boolean
  readonly recoveryWarning: string
}

interface RecoveryRecord {
  readonly version: 1
  readonly sourcePath: string
  readonly activeConfig: ActionPadConfig
  readonly draft: ActionPadConfig | null
  readonly idDrafts: Readonly<Record<string, string>>
  readonly baseline: DocumentBaseline | null
  readonly pendingSave: PendingSave | null
}

type RecoveryStorage = Pick<typeof AsyncStorage, 'getItem' | 'setItem'>
type OperationContext = {
  readonly generation: number
  readonly connectionGeneration: number
  readonly endpoint: Endpoint
}

export function actionPadStorageKey(endpoint: Endpoint): string {
  return `codey.android.action-pad.v1.${encodeURIComponent(endpoint.host)}:${endpoint.port}`
}

/** Owns drafts and file identity, independently of the editor screen's lifetime. */
export class ActionPadConfigStore {
  readonly #listeners = new Set<() => void>()
  readonly #documents: ActionPadHostDocuments
  readonly #storage: RecoveryStorage
  #state: ActionPadStoreState = initialState(DEFAULT_ENDPOINT)
  #baseline: DocumentBaseline | null = null
  #pendingSave: PendingSave | null = null
  #generation = 0
  #connectionGeneration = 0
  #refreshRequested = false
  #editVersion = 0
  #hydrated = false
  #hydration: Promise<void> = Promise.resolve()
  #writeTail: Promise<void> = Promise.resolve()

  constructor(documents: ActionPadHostDocuments, storage: RecoveryStorage = AsyncStorage) {
    this.#documents = documents
    this.#storage = storage
  }

  getState = (): ActionPadStoreState => this.#state

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  selectEndpoint(endpoint: Endpoint): Promise<void> {
    if (sameEndpoint(endpoint, this.#state.endpoint) && this.#hydrated) return this.#hydration
    const generation = ++this.#generation
    this.#refreshRequested = false
    this.#editVersion = 0
    this.#baseline = null
    this.#pendingSave = null
    this.#hydrated = true
    this.#state = { ...initialState(endpoint), busy: true }
    this.#emit()
    this.#hydration = this.#restore(endpoint, generation)
    return this.#hydration
  }

  async #restore(endpoint: Endpoint, generation: number): Promise<void> {
    try {
      await this.#writeTail
      const raw = await this.#storage.getItem(actionPadStorageKey(endpoint))
      if (generation !== this.#generation) return
      if (raw === null || raw === undefined) return
      // Several bounded representations may coexist in the recovery envelope.
      if (raw.length > ACTION_PAD_CONFIG_MAX_BYTES * 5) throw new Error('Recovery data is too large')
      const record = parseRecovery(JSON.parse(raw))
      this.#baseline = record.baseline
      this.#pendingSave = record.pendingSave
      const draft = record.draft ?? record.activeConfig
      const dirty = !sameConfig(draft, record.activeConfig) || Object.keys(record.idDrafts).length > 0
      this.#set({
        sourcePath: record.sourcePath,
        activeConfig: record.activeConfig,
        draft,
        idDrafts: record.idDrafts,
        dirty,
        message: record.pendingSave !== null
          ? 'A previous save was not confirmed. Reconnect and Save to reconcile, or Reload the host file.'
          : dirty ? 'Recovered unsaved edits. Save when connected, or Cancel to discard them.'
            : 'Using the cached configuration until the host is connected.',
        error: record.pendingSave !== null
      })
    } catch (reason) {
      if (generation === this.#generation) {
        this.#set({
          message: `Could not restore the local configuration. Using the starter. ${messageOf(reason)}`,
          error: true
        })
      }
    } finally {
      if (generation === this.#generation) this.#set({ busy: false })
    }
  }

  async setConnected(connected: boolean): Promise<void> {
    const changed = connected !== this.#state.connected
    if (changed) this.#connectionGeneration += 1
    this.#set({ connected })
    if (!connected) {
      this.#refreshRequested = false
      return
    }
    if (!changed) return
    this.#refreshRequested = true
    await this.#hydration
    await this.#refreshIfNeeded()
  }

  async #refreshIfNeeded(): Promise<void> {
    if (!this.#refreshRequested || !this.#state.connected || this.#state.busy) return
    this.#refreshRequested = false
    await this.#run(async (context) => {
      let path = this.#state.sourcePath
      if (path.length === 0) {
        path = await this.#documents.defaultActionPadPath(context.endpoint)
        this.#assertCurrent(context)
        this.#set({ sourcePath: path })
        void this.#persist()
      }
      // Reconnection can refresh a clean document, but never replaces an
      // unsaved draft or retries an unacknowledged write automatically.
      if (this.#state.dirty || this.#pendingSave !== null) {
        this.#set({ message: 'Connected. Your draft is unchanged; Save checks the host file before writing.' })
        return
      }
      const editVersion = this.#editVersion
      const document = await this.#documents.readHostDocument(context.endpoint, path)
      this.#assertCurrent(context)
      if (editVersion !== this.#editVersion) return
      if (document.text === null) {
        if (this.#baseline?.revision) {
          throw new Error('The host file is missing. The cached configuration is unchanged; Export a copy to recover it.')
        }
        this.#baseline = baselineOf(document)
        this.#set({
          sourcePath: document.path,
          message: 'Using the starter configuration. Save will create the selected host file.',
          error: false
        })
        void this.#persist()
        return
      }
      const config = parseActionPadConfig(document.text)
      this.#accept(document, config, editVersion)
      this.#set({ message: `Loaded ${document.path}`, error: false })
    })
  }

  setDraft(config: ActionPadConfig): void {
    if (!isActionPadConfigShape(config)) {
      this.#set({ message: 'This edit has an invalid document structure.', error: true })
      return
    }
    this.#editVersion += 1
    const draft = cloneConfig(config)
    this.#set({
      draft,
      dirty: !sameConfig(draft, this.#state.activeConfig) || Object.keys(this.#state.idDrafts).length > 0
    })
    void this.#persist()
  }

  setIdDrafts(idDrafts: Readonly<Record<string, string>>): void {
    if (!isIdDrafts(idDrafts)) return
    if (JSON.stringify(idDrafts) === JSON.stringify(this.#state.idDrafts)) return
    this.#editVersion += 1
    this.#set({
      idDrafts: { ...idDrafts },
      dirty: !sameConfig(this.#state.draft, this.#state.activeConfig) || Object.keys(idDrafts).length > 0
    })
    void this.#persist()
  }

  discardDraft(): void {
    if (this.#state.busy) return
    this.#editVersion += 1
    this.#set({
      draft: cloneConfig(this.#state.activeConfig),
      idDrafts: {},
      dirty: false,
      message: this.#pendingSave !== null
        ? 'Draft discarded locally. A previous save was not confirmed; Reload to check the host file.'
        : 'Unsaved edits discarded.',
      error: this.#pendingSave !== null
    })
    void this.#persist()
  }

  /** The screen obtains discard confirmation before calling this method. */
  async load(path: string): Promise<void> {
    await this.#run(async (context) => {
      const editVersion = this.#editVersion
      const document = await this.#documents.readHostDocument(context.endpoint, requirePath(path))
      this.#assertCurrent(context)
      if (document.text === null) throw new Error('That host file does not exist. Use Save to create a file.')
      const config = parseActionPadConfig(document.text)
      if (editVersion !== this.#editVersion) throw new Error('The draft changed while loading. Try Load again.')
      this.#pendingSave = null
      this.#set({ idDrafts: {} })
      this.#accept(document, config, editVersion)
      this.#set({ message: `Loaded ${document.path}`, error: false })
    })
  }

  async save(path: string): Promise<void> {
    await this.#run(async (context) => {
      this.#assertNoPendingIds()
      const config = cloneConfig(this.#state.draft)
      const text = serializeActionPadConfig(config)
      const editVersion = this.#editVersion
      const current = await this.#documents.readHostDocument(context.endpoint, requirePath(path))
      this.#assertCurrent(context)

      // A timed-out/lost response does not mean the host failed to save. Read
      // back the exact attempted bytes before deciding whether to write again.
      const pending = this.#pendingSave
      if (pending !== null && current.path !== pending.path) {
        throw new Error(`A save to ${pending.path} was not confirmed. Save to that path to reconcile it, or Load a file before changing the save destination.`)
      }
      if (pending !== null && current.resolvedPath !== pending.resolvedPath) {
        throw new Error('The unconfirmed save path now points to a different file. Reload it or Export your draft to another path.')
      }
      if (
        pending !== null && current.path === pending.path &&
        current.resolvedPath === pending.resolvedPath && current.text === pending.text
      ) {
        this.#baseline = baselineOf(current)
        this.#pendingSave = null
        if (text === pending.text) {
          this.#accept(current, config, editVersion)
          this.#set({ message: 'The previous save was confirmed from the host file.', error: false })
          return
        }
      }

      const baseline = this.#baseline?.path === current.path ? this.#baseline : null
      if (baseline === null && this.#baseline !== null && this.#baseline.revision !== null) {
        throw new Error('Save updates the active file. Use Export for another path, or Load that file before editing it.')
      }
      if (baseline === null && current.text !== null) {
        throw new Error('This file already exists. Load it before saving, or Export to another path.')
      }
      if (baseline !== null && (
        baseline.revision !== current.revision || baseline.resolvedPath !== current.resolvedPath
      )) {
        throw new Error('The host file changed outside Codey. Reload it or Export your draft to another path.')
      }

      const request: HostDocumentWrite = {
        path: current.path,
        text,
        expectedRevision: baseline?.revision ?? null,
        expectedResolvedPath: current.resolvedPath
      }
      this.#pendingSave = { ...baselineOf(current), text }
      await this.#persist()
      this.#assertCurrent(context)
      const written = await this.#documents.writeHostDocument(context.endpoint, request)
      this.#assertCurrent(context)
      if (written.text !== text || written.revision === null) {
        throw new Error('The host did not confirm the complete save. Your draft is retained; reconcile before retrying.')
      }
      this.#pendingSave = null
      this.#accept(written, config, editVersion)
      this.#set({
        message: this.#state.dirty
          ? `Saved ${written.path}. Newer edits are still unsaved.`
          : `Saved ${written.path}`,
        error: false
      })
    })
  }

  async export(
    path: string,
    confirmOverwrite: (path: string) => Promise<boolean> = async () => false
  ): Promise<void> {
    await this.#run(async (context) => {
      this.#assertNoPendingIds()
      const text = serializeActionPadConfig(this.#state.draft)
      const current = await this.#documents.readHostDocument(context.endpoint, requirePath(path))
      this.#assertCurrent(context)
      if (
        current.path === this.#state.sourcePath ||
        current.resolvedPath === this.#baseline?.resolvedPath
      ) {
        throw new Error('Export must use a different file. Use Save to update the active configuration.')
      }
      if (current.text !== null && !await confirmOverwrite(current.path)) {
        this.#assertCurrent(context)
        this.#set({ message: 'Export canceled. No file was changed.', error: false })
        return
      }
      this.#assertCurrent(context)
      const written = await this.#documents.writeHostDocument(context.endpoint, {
        path: current.path,
        text,
        expectedRevision: current.revision,
        expectedResolvedPath: current.resolvedPath
      })
      this.#assertCurrent(context)
      if (written.text !== text || written.revision === null) {
        throw new Error('Export was not confirmed. Check the destination before retrying.')
      }
      this.#set({ message: `Exported ${written.path}. The active file and draft are unchanged.`, error: false })
    })
  }

  flushRecovery(): Promise<void> {
    return this.#writeTail
  }

  async #run(operation: (context: OperationContext) => Promise<void>): Promise<void> {
    if (this.#state.busy) return
    if (!this.#state.connected) {
      this.#set({ message: 'Connect to the Neovim host to load, save, or export. Your draft is kept locally.', error: true })
      return
    }
    const context = {
      generation: this.#generation,
      connectionGeneration: this.#connectionGeneration,
      endpoint: this.#state.endpoint
    }
    this.#set({ busy: true, error: false })
    try {
      await operation(context)
    } catch (reason) {
      if (context.generation === this.#generation && context.connectionGeneration === this.#connectionGeneration) {
        this.#set({ message: messageOf(reason), error: true })
        void this.#persist()
      }
    } finally {
      if (context.generation === this.#generation) {
        this.#set({ busy: false })
        void this.#refreshIfNeeded()
      }
    }
  }

  #assertCurrent(context: OperationContext): void {
    if (
      context.generation !== this.#generation ||
      context.connectionGeneration !== this.#connectionGeneration || !this.#state.connected
    ) {
      throw new Error('The host connection changed. Your draft is retained; reconnect and check the file.')
    }
  }

  #assertNoPendingIds(): void {
    if (Object.keys(this.#state.idDrafts).length > 0) {
      throw new Error('Finish or undo the incomplete ID edits before saving or exporting.')
    }
  }

  #accept(document: HostDocument, config: ActionPadConfig, editVersion: number): void {
    this.#baseline = baselineOf(document)
    const draft = editVersion === this.#editVersion ? config : this.#state.draft
    this.#set({
      sourcePath: document.path,
      activeConfig: config,
      draft,
      dirty: !sameConfig(draft, config) || Object.keys(this.#state.idDrafts).length > 0
    })
    void this.#persist()
  }

  #persist(): Promise<void> {
    const generation = this.#generation
    const key = actionPadStorageKey(this.#state.endpoint)
    const record: RecoveryRecord = {
      version: 1,
      sourcePath: this.#state.sourcePath,
      activeConfig: this.#state.activeConfig,
      draft: this.#state.dirty ? this.#state.draft : null,
      idDrafts: this.#state.idDrafts,
      baseline: this.#baseline,
      pendingSave: this.#pendingSave
    }
    const encoded = JSON.stringify(record)
    this.#writeTail = this.#writeTail.then(async () => {
      try {
        await this.#storage.setItem(key, encoded)
        if (generation === this.#generation && this.#state.recoveryWarning) {
          this.#set({ recoveryWarning: '' })
        }
      } catch (reason) {
        if (generation === this.#generation) {
          this.#set({ recoveryWarning: `Local recovery could not be stored: ${messageOf(reason)}` })
        }
      }
    })
    return this.#writeTail
  }

  #set(change: Partial<ActionPadStoreState>): void {
    this.#state = { ...this.#state, ...change, pendingSavePath: this.#pendingSave?.path ?? null }
    this.#emit()
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }
}

function initialState(endpoint: Endpoint): ActionPadStoreState {
  return {
    endpoint,
    sourcePath: '',
    pendingSavePath: null,
    activeConfig: DEFAULT_ACTION_PAD_CONFIG,
    draft: DEFAULT_ACTION_PAD_CONFIG,
    idDrafts: {},
    dirty: false,
    busy: false,
    connected: false,
    message: 'Starter configuration. Connect to a host to choose a YAML file.',
    error: false,
    recoveryWarning: ''
  }
}

function baselineOf(document: HostDocument): DocumentBaseline {
  return { path: document.path, resolvedPath: document.resolvedPath, revision: document.revision }
}

function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  return a.host === b.host && a.port === b.port
}

function sameConfig(a: ActionPadConfig, b: ActionPadConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function cloneConfig(config: ActionPadConfig): ActionPadConfig {
  return JSON.parse(JSON.stringify(config)) as ActionPadConfig
}

function requirePath(path: string): string {
  if (!path.startsWith('/') && !path.startsWith('~/')) {
    throw new Error('Enter an absolute host path or a path beginning with ~/ .')
  }
  return path
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'The file operation failed.'
}

function parseRecovery(value: unknown): RecoveryRecord {
  if (!isRecord(value) || value.version !== 1 || typeof value.sourcePath !== 'string') {
    throw new Error('Invalid recovery record')
  }
  if (!isActionPadConfigShape(value.activeConfig) || validateActionPadConfig(value.activeConfig).length > 0) {
    throw new Error('Invalid cached configuration')
  }
  if (value.draft !== null && !isActionPadConfigShape(value.draft)) throw new Error('Invalid cached draft')
  if (value.idDrafts !== undefined && !isIdDrafts(value.idDrafts)) throw new Error('Invalid cached ID edits')
  if (value.baseline !== null && !isBaseline(value.baseline)) throw new Error('Invalid cached file identity')
  if (value.pendingSave !== null && (
    !isBaseline(value.pendingSave) || !isRecord(value.pendingSave) || typeof value.pendingSave.text !== 'string'
  )) throw new Error('Invalid cached save attempt')
  return { ...value, idDrafts: value.idDrafts ?? {} } as unknown as RecoveryRecord
}

function isIdDrafts(value: unknown): value is Readonly<Record<string, string>> {
  if (!isRecord(value) || Object.keys(value).length > 10_000) return false
  let characters = 0
  for (const [path, text] of Object.entries(value)) {
    if (!/^menus\[\d+\](?:\.groups\[\d+\](?:\.buttons\[\d+\])?)?\.id$/.test(path) || typeof text !== 'string') return false
    characters += text.length
    if (characters > ACTION_PAD_CONFIG_MAX_BYTES) return false
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBaseline(value: unknown): value is DocumentBaseline {
  return isRecord(value) && typeof value.path === 'string' && typeof value.resolvedPath === 'string' &&
    (value.revision === null || typeof value.revision === 'string')
}
