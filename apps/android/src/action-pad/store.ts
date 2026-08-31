import AsyncStorage from '@react-native-async-storage/async-storage'
import type {
  HostDocument,
  HostDocumentErrorCode,
  HostDocumentErrorStage,
  HostDocumentWrite
} from '@codey/nvim-session'

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

export type ActionPadOperationKind = 'load' | 'save' | 'export' | 'reconcile'
export type ActionPadOperationPhase =
  | 'validating'
  | 'checking-host-file'
  | 'writing'
  | 'awaiting-confirmation'

export interface ActionPadOperation {
  readonly id: number
  readonly kind: ActionPadOperationKind
  readonly phase: ActionPadOperationPhase
  readonly startedAtMs: number
  readonly path: string
  readonly byteCount?: number
  readonly slow: boolean
  readonly writeStarted: boolean
}

export type ActionPadNoticeSeverity = 'info' | 'success' | 'warning' | 'error'

export interface ActionPadNoticeDetails {
  readonly operation?: ActionPadOperationKind
  readonly phase?: ActionPadOperationPhase
  readonly durationMs?: number
  readonly path?: string
  readonly byteCount?: number
  readonly hostErrorCode?: HostDocumentErrorCode
  readonly hostStage?: HostDocumentErrorStage
  readonly socketCode?: string
  readonly nativeSocketMessage?: string
}

export interface ActionPadNotice {
  readonly severity: ActionPadNoticeSeverity
  readonly summary: string
  readonly recommendedAction?: string
  readonly details?: ActionPadNoticeDetails
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
  readonly operation: ActionPadOperation | null
  readonly notice: ActionPadNotice | null
  readonly recoveryNotice: ActionPadNotice | null
  /** Compatibility projections for consumers that have not moved to notices yet. */
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

interface OperationContext {
  readonly id: number
  readonly generation: number
  readonly connectionGeneration: number
  readonly endpoint: Endpoint
}

interface ActiveRun {
  readonly id: number
  readonly cancel: () => void
}

type OperationOutcome =
  | { readonly status: 'completed' }
  | { readonly status: 'failed'; readonly reason: unknown }
  | { readonly status: 'cancelled' }

const SLOW_OPERATION_MS = 15_000
const HOST_ERROR_CODES: readonly HostDocumentErrorCode[] = [
  'conflict', 'modified-buffer', 'invalid-path', 'not-found', 'permission', 'too-large', 'io'
]
const HOST_ERROR_STAGES: readonly HostDocumentErrorStage[] = [
  'validation', 'filesystem', 'conflict', 'permission', 'publication', 'sync', 'read-back'
]

export function actionPadStorageKey(endpoint: Endpoint): string {
  return `codey.android.action-pad.v1.${encodeURIComponent(endpoint.host)}:${endpoint.port}`
}

/** Owns drafts, file identity, operation diagnostics, and uncertain-save recovery. */
export class ActionPadConfigStore {
  readonly #listeners = new Set<() => void>()
  readonly #documents: ActionPadHostDocuments
  readonly #storage: RecoveryStorage
  #state: ActionPadStoreState
  #baseline: DocumentBaseline | null = null
  #pendingSave: PendingSave | null = null
  #generation = 0
  #connectionGeneration = 0
  #operationSequence = 0
  #activeRun: ActiveRun | null = null
  #slowTimer: ReturnType<typeof setTimeout> | null = null
  #refreshRequested = false
  #editVersion = 0
  #hydrated = false
  #hydration: Promise<void> = Promise.resolve()
  #writeTail: Promise<void> = Promise.resolve()

  constructor(
    documents: ActionPadHostDocuments,
    storage: RecoveryStorage = AsyncStorage,
    initialEndpoint: Endpoint = DEFAULT_ENDPOINT
  ) {
    this.#documents = documents
    this.#storage = storage
    this.#state = initialState(initialEndpoint)
  }

  getState = (): ActionPadStoreState => this.#state

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  selectEndpoint(endpoint: Endpoint): Promise<void> {
    if (sameEndpoint(endpoint, this.#state.endpoint) && this.#hydrated) return this.#hydration
    this.#cancelActiveRunWithoutNotice()
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
        notice: record.pendingSave !== null
          ? notice('warning',
              'A previous save was not confirmed.',
              'Reconnect & check save before retrying. The draft is still local.',
              { operation: 'reconcile', path: record.pendingSave.path })
          : dirty
            ? notice('info', 'Recovered unsaved edits.', 'Save when connected, or Cancel to keep or discard them.')
            : notice('info', 'Using the cached configuration until the host is connected.')
      })
    } catch (reason) {
      if (generation === this.#generation) {
        this.#set({
          notice: notice('error', `Could not restore the local configuration. Using the starter. ${messageOf(reason)}`)
        })
      }
    } finally {
      if (generation === this.#generation) this.#set({ busy: false })
    }
  }

  async setConnected(connected: boolean): Promise<void> {
    const changed = connected !== this.#state.connected
    if (changed) this.#connectionGeneration += 1
    if (!connected && this.#activeRun !== null) {
      this.#cancelActiveOperation(
        this.#state.operation?.writeStarted
          ? 'The connection closed after writing began. The result is uncertain.'
          : 'The connection closed before any write began.',
        this.#state.operation?.writeStarted
          ? 'Reconnect & check save before retrying.'
          : 'Reconnect, then retry the operation.'
      )
    }
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

  /** Stops only the local wait. The caller is responsible for disconnecting the controller. */
  stopWaiting(): void {
    if (this.#activeRun === null || this.#state.operation === null) return
    const writeStarted = this.#state.operation.writeStarted
    this.#cancelActiveOperation(
      writeStarted
        ? 'Stopped waiting after writing began. The save result is uncertain.'
        : 'Stopped waiting before any write began.',
      writeStarted
        ? 'Reconnect & check save before retrying.'
        : 'Reconnect, then retry when ready.'
    )
  }

  async #refreshIfNeeded(): Promise<void> {
    if (!this.#refreshRequested || !this.#state.connected || this.#state.busy) return
    this.#refreshRequested = false
    await this.#run('load', this.#state.sourcePath, async (context) => {
      let path = this.#state.sourcePath
      if (path.length === 0) {
        this.#updateOperation(context, { phase: 'checking-host-file' })
        path = await this.#documents.defaultActionPadPath(context.endpoint)
        this.#assertCurrent(context)
        this.#set({ sourcePath: path })
        this.#updateOperation(context, { path })
        void this.#persist()
      }
      // Reconnection never replaces a draft or checks/retries an unacknowledged write.
      if (this.#state.dirty || this.#pendingSave !== null) {
        this.#set({
          notice: this.#pendingSave === null
            ? notice('info', 'Connected. Your draft is unchanged.', 'Save checks the host file before writing.')
            : notice('warning', 'Connected. A previous save is still unconfirmed.', 'Use Reconnect & check save; no write will be replayed.', {
                operation: 'reconcile', path: this.#pendingSave.path
              })
        })
        return
      }
      const editVersion = this.#editVersion
      this.#updateOperation(context, { phase: 'checking-host-file', path })
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
          notice: notice('info', 'Using the starter configuration. Save will create the selected host file.')
        })
        void this.#persist()
        return
      }
      const config = parseActionPadConfig(document.text)
      this.#accept(document, config, editVersion)
      this.#set({ notice: notice('success', `Loaded ${document.path}`) })
    })
  }

  setDraft(config: ActionPadConfig): void {
    if (!isActionPadConfigShape(config)) {
      this.#set({ notice: notice('error', 'This edit has an invalid document structure.') })
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
      notice: this.#pendingSave !== null
        ? notice('warning', 'Draft discarded locally, but a previous save is unconfirmed.', 'Reconnect & check save or Load the host file.', {
            operation: 'reconcile', path: this.#pendingSave.path
          })
        : notice('info', 'Unsaved edits discarded.')
    })
    void this.#persist()
  }

  /** The screen obtains discard confirmation before calling this method. */
  async load(path: string): Promise<void> {
    await this.#run('load', path, async (context) => {
      const requiredPath = requirePath(path)
      const editVersion = this.#editVersion
      this.#updateOperation(context, { phase: 'checking-host-file', path: requiredPath })
      const document = await this.#documents.readHostDocument(context.endpoint, requiredPath)
      this.#assertCurrent(context)
      if (document.text === null) throw new Error('That host file does not exist. Use Save to create a file.')
      const config = parseActionPadConfig(document.text)
      if (editVersion !== this.#editVersion) throw new Error('The draft changed while loading. Try Load again.')
      this.#pendingSave = null
      this.#set({ idDrafts: {} })
      this.#accept(document, config, editVersion)
      this.#set({ notice: notice('success', `Loaded ${document.path}`) })
    })
  }

  async save(path: string): Promise<void> {
    if (this.#pendingSave !== null) {
      this.#set({
        notice: notice('warning', `A save to ${this.#pendingSave.path} was not confirmed.`,
          'Use Reconnect & check save before another Save. No write was sent.', {
            operation: 'reconcile', path: this.#pendingSave.path
          })
      })
      return
    }
    await this.#run('save', path, async (context) => {
      this.#assertNoPendingIds()
      const config = cloneConfig(this.#state.draft)
      const text = serializeActionPadConfig(config)
      const byteCount = utf8ByteLength(text)
      const editVersion = this.#editVersion
      const requiredPath = requirePath(path)
      this.#updateOperation(context, {
        phase: 'checking-host-file', path: requiredPath, byteCount
      })
      const current = await this.#documents.readHostDocument(context.endpoint, requiredPath)
      this.#assertCurrent(context)

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
        throw new Error('The host file changed outside Codey. Load it or Export your draft to another path.')
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
      this.#updateOperation(context, { phase: 'writing', writeStarted: true })
      const writing = this.#documents.writeHostDocument(context.endpoint, request)
      this.#updateOperation(context, { phase: 'awaiting-confirmation' })
      const written = await writing
      this.#assertCurrent(context)
      if (written.text !== text || written.revision === null) {
        throw new Error('The host did not confirm the complete save. Your draft is retained; reconcile before retrying.')
      }
      this.#pendingSave = null
      this.#accept(written, config, editVersion)
      this.#set({
        notice: notice('success', this.#state.dirty
          ? `Saved ${written.path}. Newer edits are still unsaved.`
          : `Saved ${written.path}`)
      })
    })
  }

  async export(
    path: string,
    confirmOverwrite: (path: string) => Promise<boolean> = async () => false
  ): Promise<void> {
    await this.#run('export', path, async (context) => {
      this.#assertNoPendingIds()
      const text = serializeActionPadConfig(this.#state.draft)
      const byteCount = utf8ByteLength(text)
      const requiredPath = requirePath(path)
      this.#updateOperation(context, {
        phase: 'checking-host-file', path: requiredPath, byteCount
      })
      const current = await this.#documents.readHostDocument(context.endpoint, requiredPath)
      this.#assertCurrent(context)
      if (
        current.path === this.#state.sourcePath ||
        current.resolvedPath === this.#baseline?.resolvedPath
      ) {
        throw new Error('Export must use a different file. Use Save to update the active configuration.')
      }
      if (current.text !== null && !await confirmOverwrite(current.path)) {
        this.#assertCurrent(context)
        this.#set({ notice: notice('info', 'Export canceled. No file was changed.') })
        return
      }
      this.#assertCurrent(context)
      this.#updateOperation(context, { phase: 'writing', writeStarted: true })
      const writing = this.#documents.writeHostDocument(context.endpoint, {
        path: current.path,
        text,
        expectedRevision: current.revision,
        expectedResolvedPath: current.resolvedPath
      })
      this.#updateOperation(context, { phase: 'awaiting-confirmation' })
      const written = await writing
      this.#assertCurrent(context)
      if (written.text !== text || written.revision === null) {
        throw new Error('Export was not confirmed. Check the destination before retrying.')
      }
      this.#set({
        notice: notice('success', `Exported ${written.path}. The active file and draft are unchanged.`)
      })
    })
  }

  /** Reads the pending target exactly once and never invokes the write method. */
  async reconcilePendingSave(): Promise<void> {
    const pendingAtStart = this.#pendingSave
    if (pendingAtStart === null) {
      this.#set({ notice: notice('info', 'There is no unconfirmed save to check.') })
      return
    }
    await this.#run('reconcile', pendingAtStart.path, async (context) => {
      const pending = this.#pendingSave
      if (pending === null) return
      this.#updateOperation(context, { phase: 'checking-host-file', path: pending.path })
      const current = await this.#documents.readHostDocument(context.endpoint, pending.path)
      this.#assertCurrent(context)

      if (current.path !== pending.path) {
        this.#set({ notice: blockedReconcileNotice(
          'The unconfirmed save returned a different host path.', pending, current
        ) })
        return
      }
      if (current.resolvedPath !== pending.resolvedPath) {
        this.#set({ notice: blockedReconcileNotice(
          'The unconfirmed save path now resolves to a different target.', pending, current
        ) })
        return
      }

      if (current.text === pending.text) {
        const savedConfig = parseActionPadConfig(pending.text)
        this.#baseline = baselineOf(current)
        this.#pendingSave = null
        const draft = this.#state.draft
        const dirty = !sameConfig(draft, savedConfig) || Object.keys(this.#state.idDrafts).length > 0
        this.#set({
          sourcePath: current.path,
          activeConfig: savedConfig,
          draft,
          dirty,
          notice: notice('success', dirty
            ? 'The previous save was confirmed. Newer local edits remain unsaved.'
            : 'The previous save was confirmed from the host file.', undefined, {
              operation: 'reconcile', phase: 'checking-host-file', path: current.path
            })
        })
        void this.#persist()
        return
      }

      if (current.text === null || current.revision === pending.revision) {
        this.#baseline = baselineOf(current)
        this.#pendingSave = null
        this.#set({
          sourcePath: current.path,
          notice: notice('warning',
            current.text === null
              ? 'The attempted save is not present; the target is missing.'
              : 'The host still contains the original version.',
            'The uncertainty is cleared. Review the draft and choose Save to retry explicitly.', {
              operation: 'reconcile', phase: 'checking-host-file', path: current.path
            })
        })
        void this.#persist()
        return
      }

      this.#set({
        notice: notice('error', 'The host file contains different external changes.',
          'Nothing was written. Load the host version or Export your local draft.', {
            operation: 'reconcile', phase: 'checking-host-file', path: current.path
          })
      })
    })
  }

  flushRecovery(): Promise<void> {
    return this.#writeTail
  }

  async #run(
    kind: ActionPadOperationKind,
    path: string,
    operation: (context: OperationContext) => Promise<void>
  ): Promise<void> {
    if (this.#state.busy) return
    if (!this.#state.connected) {
      this.#set({
        notice: notice('error', 'Connect to the Neovim host to load, save, export, or reconcile.',
          'Your draft is kept locally.')
      })
      return
    }

    const id = ++this.#operationSequence
    const context: OperationContext = {
      id,
      generation: this.#generation,
      connectionGeneration: this.#connectionGeneration,
      endpoint: this.#state.endpoint
    }
    const operationState: ActionPadOperation = {
      id,
      kind,
      phase: 'validating',
      startedAtMs: Date.now(),
      path,
      slow: false,
      writeStarted: false
    }
    let cancel!: () => void
    const cancellation = new Promise<OperationOutcome>((resolve) => {
      cancel = () => resolve({ status: 'cancelled' })
    })
    this.#activeRun = { id, cancel }
    this.#set({ busy: true, operation: operationState, notice: null })
    this.#slowTimer = setTimeout(() => {
      if (this.#activeRun?.id !== id || this.#state.operation?.id !== id) return
      this.#set({ operation: { ...this.#state.operation, slow: true } })
    }, SLOW_OPERATION_MS)

    const work: Promise<OperationOutcome> = Promise.resolve()
      .then(() => this.#activeRun?.id === id ? operation(context) : undefined)
      .then<OperationOutcome, OperationOutcome>(
        () => ({ status: 'completed' }),
        (reason: unknown) => ({ status: 'failed', reason })
      )
    const outcome = await Promise.race([work, cancellation])
    if (outcome.status === 'cancelled' || this.#activeRun?.id !== id) return

    const finalOperation = this.#state.operation?.id === id ? this.#state.operation : operationState
    this.#clearActiveRun(id)
    if (outcome.status === 'failed') {
      const failureNotice = operationFailureNotice(outcome.reason, finalOperation)
      warnOperationFailure(failureNotice)
      this.#set({ busy: false, operation: null, notice: failureNotice })
      void this.#persist()
    } else {
      this.#set({ busy: false, operation: null })
    }
    void this.#refreshIfNeeded()
  }

  #updateOperation(
    context: OperationContext,
    change: Partial<Omit<ActionPadOperation, 'id' | 'kind' | 'startedAtMs' | 'slow'>>
  ): void {
    this.#assertCurrent(context)
    const current = this.#state.operation
    if (current === null || current.id !== context.id) throw new Error('The host operation is no longer active.')
    this.#set({ operation: { ...current, ...change } })
  }

  #cancelActiveOperation(summary: string, recommendedAction: string): void {
    const operation = this.#state.operation
    const active = this.#activeRun
    if (operation === null || active === null) return
    if (operation.kind === 'save' && !operation.writeStarted) this.#pendingSave = null
    this.#clearSlowTimer()
    this.#activeRun = null
    active.cancel()
    this.#set({
      busy: false,
      operation: null,
      notice: notice('warning', summary, recommendedAction, operationDetails(operation))
    })
    void this.#persist()
  }

  #cancelActiveRunWithoutNotice(): void {
    const active = this.#activeRun
    this.#clearSlowTimer()
    this.#activeRun = null
    active?.cancel()
  }

  #clearActiveRun(id: number): void {
    if (this.#activeRun?.id === id) this.#activeRun = null
    this.#clearSlowTimer()
  }

  #clearSlowTimer(): void {
    if (this.#slowTimer !== null) clearTimeout(this.#slowTimer)
    this.#slowTimer = null
  }

  #assertCurrent(context: OperationContext): void {
    if (
      context.id !== this.#activeRun?.id ||
      context.generation !== this.#generation ||
      context.connectionGeneration !== this.#connectionGeneration ||
      !this.#state.connected
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
        if (generation === this.#generation && this.#state.recoveryNotice !== null) {
          this.#set({ recoveryNotice: null })
        }
      } catch (reason) {
        if (generation === this.#generation) {
          this.#set({
            recoveryNotice: notice('warning', `Local recovery could not be stored: ${messageOf(reason)}`,
              'Keep this editor open until local storage is available.')
          })
        }
      }
    })
    return this.#writeTail
  }

  #set(change: Partial<ActionPadStoreState>): void {
    const next = {
      ...this.#state,
      ...change,
      pendingSavePath: this.#pendingSave?.path ?? null
    }
    const projectedNotice = next.notice
    const projectedRecovery = next.recoveryNotice
    this.#state = {
      ...next,
      message: projectedNotice?.summary ?? '',
      error: projectedNotice?.severity === 'error',
      recoveryWarning: projectedRecovery?.summary ?? ''
    }
    this.#emit()
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }
}

function initialState(endpoint: Endpoint): ActionPadStoreState {
  const initialNotice = notice('info', 'Starter configuration. Connect to a host to choose a YAML file.')
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
    operation: null,
    notice: initialNotice,
    recoveryNotice: null,
    message: initialNotice.summary,
    error: false,
    recoveryWarning: ''
  }
}

function notice(
  severity: ActionPadNoticeSeverity,
  summary: string,
  recommendedAction?: string,
  details?: ActionPadNoticeDetails
): ActionPadNotice {
  return {
    severity,
    summary,
    ...(recommendedAction === undefined ? {} : { recommendedAction }),
    ...(details === undefined ? {} : { details })
  }
}

function blockedReconcileNotice(
  summary: string,
  pending: PendingSave,
  current: HostDocument
): ActionPadNotice {
  return notice('error', summary,
    'Nothing was written. Load the host target or Export your local draft; Save remains blocked.', {
      operation: 'reconcile',
      phase: 'checking-host-file',
      path: current.path || pending.path
    })
}

function operationFailureNotice(reason: unknown, operation: ActionPadOperation): ActionPadNotice {
  const host = hostFailureOf(reason)
  const socket = socketFailureOf(reason)
  const details: ActionPadNoticeDetails = {
    ...operationDetails(operation),
    ...(host.code === undefined ? {} : { hostErrorCode: host.code }),
    ...(host.stage === undefined ? {} : { hostStage: host.stage }),
    ...(socket.code === undefined ? {} : { socketCode: socket.code }),
    ...(socket.message === undefined ? {} : { nativeSocketMessage: socket.message })
  }
  let recommendedAction: string
  if (operation.writeStarted && operation.kind === 'save') {
    recommendedAction = 'The save may have completed. Reconnect & check save before retrying.'
  } else if (operation.writeStarted && operation.kind === 'export') {
    recommendedAction = 'The export may have completed. Check the destination before retrying.'
  } else if (socket.code !== undefined) {
    recommendedAction = 'No write started. Reconnect, then retry the operation.'
  } else if (host.code === 'conflict' || host.code === 'modified-buffer') {
    recommendedAction = 'Load the host file or Export the local draft; do not overwrite external changes.'
  } else if (host.code === 'permission') {
    recommendedAction = 'Check host file permissions or Export to a writable path.'
  } else {
    recommendedAction = operation.writeStarted
      ? 'The result may be uncertain. Check the target before retrying.'
      : 'Review the details and retry when the host issue is resolved.'
  }
  return notice('error', messageOf(reason), recommendedAction, details)
}

function operationDetails(operation: ActionPadOperation): ActionPadNoticeDetails {
  return {
    operation: operation.kind,
    phase: operation.phase,
    durationMs: Math.max(0, Date.now() - operation.startedAtMs),
    path: operation.path,
    ...(operation.byteCount === undefined ? {} : { byteCount: operation.byteCount })
  }
}

function hostFailureOf(reason: unknown): {
  readonly code?: HostDocumentErrorCode
  readonly stage?: HostDocumentErrorStage
} {
  for (const candidate of errorChain(reason)) {
    const record = candidate as { readonly code?: unknown; readonly stage?: unknown; readonly name?: unknown }
    const code = typeof record.code === 'string' && HOST_ERROR_CODES.includes(record.code as HostDocumentErrorCode)
      ? record.code as HostDocumentErrorCode
      : undefined
    const stage = typeof record.stage === 'string' && HOST_ERROR_STAGES.includes(record.stage as HostDocumentErrorStage)
      ? record.stage as HostDocumentErrorStage
      : undefined
    if (code !== undefined || record.name === 'HostDocumentError') return { code, stage }
  }
  return {}
}

function socketFailureOf(reason: unknown): { readonly code?: string; readonly message?: string } {
  for (const candidate of errorChain(reason)) {
    const record = candidate as {
      readonly failure?: unknown
      readonly nativeCode?: unknown
      readonly code?: unknown
      readonly name?: unknown
      readonly message?: unknown
    }
    if (isRecord(record.failure)) {
      const code = typeof record.failure.nativeCode === 'string'
        ? record.failure.nativeCode
        : typeof record.failure.code === 'string' ? record.failure.code : undefined
      if (code !== undefined) {
        return {
          code,
          message: typeof record.failure.nativeMessage === 'string'
            ? record.failure.nativeMessage
            : typeof record.failure.message === 'string' ? record.failure.message : undefined
        }
      }
    }
    const code = typeof record.nativeCode === 'string'
      ? record.nativeCode
      : typeof record.code === 'string' && (record.code.startsWith('E_TCP_') || record.code.startsWith('ECONN'))
        ? record.code
        : typeof record.name === 'string' && (record.name.startsWith('E_TCP_') || record.name.startsWith('ECONN'))
          ? record.name
          : undefined
    if (code !== undefined) {
      return { code, message: typeof record.message === 'string' ? record.message : undefined }
    }
  }
  return {}
}

function errorChain(reason: unknown): readonly unknown[] {
  const chain: unknown[] = []
  let current: unknown = reason
  const seen = new Set<unknown>()
  while (current !== null && (typeof current === 'object' || typeof current === 'function') && !seen.has(current)) {
    chain.push(current)
    seen.add(current)
    current = (current as { readonly cause?: unknown }).cause
  }
  return chain
}

function warnOperationFailure(failure: ActionPadNotice): void {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return
  const details = failure.details
  if (details?.hostErrorCode === undefined && details?.socketCode === undefined) return
  // Deliberately closed metadata: never include YAML, labels, commands, or typed input.
  console.warn('Action Pad host operation failed', {
    operation: details?.operation,
    phase: details?.phase,
    durationMs: details?.durationMs,
    path: details?.path,
    byteCount: details?.byteCount,
    hostErrorCode: details?.hostErrorCode,
    hostStage: details?.hostStage,
    socketCode: details?.socketCode
  })
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

function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (
      code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
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
    !isBaseline(value.pendingSave) || !isRecord(value.pendingSave) ||
    typeof value.pendingSave.text !== 'string' || utf8ByteLength(value.pendingSave.text) > ACTION_PAD_CONFIG_MAX_BYTES
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
