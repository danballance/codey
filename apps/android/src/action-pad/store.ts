import AsyncStorage from '@react-native-async-storage/async-storage'
import type { HostDocument, HostDocumentErrorCode, HostDocumentWrite } from '@codey/nvim-session'

import { diagnosticLogger, type DiagnosticLogger, type DiagnosticOperation } from '../diagnostics/logger'
import { isLocalActionPadEndpoint } from '../connection-target'
import { DEFAULT_ENDPOINT, type Endpoint } from '../endpoint'
import { DEFAULT_ACTION_PAD_CONFIG } from './config'
import {
  ACTION_PAD_CONFIG_MAX_BYTES,
  isActionPadConfigShape,
  parseActionPadConfig,
  serializeActionPadConfig,
  type ActionPadConfig
} from './document'

export interface ActionPadHostDocuments {
  defaultActionPadPath(endpoint: Endpoint): Promise<string>
  readHostDocument(endpoint: Endpoint, path: string): Promise<HostDocument>
  writeHostDocument(endpoint: Endpoint, request: HostDocumentWrite): Promise<void>
}

export type ActionPadOperationKind = 'load' | 'save'
export type ActionPadOperationPhase = 'validating' | 'reading' | 'writing'

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
  /** Resolved YAML path on the selected Neovim host. */
  readonly sourcePath: string
  readonly activeConfig: ActionPadConfig
  readonly workingConfig: ActionPadConfig
  readonly dirty: boolean
  readonly busy: boolean
  readonly connected: boolean
  readonly initialLoadPending: boolean
  readonly operation: ActionPadOperation | null
  readonly notice: ActionPadNotice | null
  readonly message: string
  readonly error: boolean
}

export interface ActionPadConnectionPreservation {
  readonly fieldEdits: boolean
  readonly pathEdit: boolean
}

type PathStorage = Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem'>

interface OperationContext {
  readonly id: number
  readonly generation: number
  readonly connectionGeneration: number
  readonly endpoint: Endpoint
  readonly diagnostics: DiagnosticOperation
  readonly rawLifecycle: Record<string, unknown>
}

interface ActiveRun {
  readonly id: number
  readonly cancel: () => void
  readonly diagnostics: DiagnosticOperation
  readonly rawLifecycle: Record<string, unknown>
}

type OperationOutcome =
  | { readonly status: 'completed' }
  | { readonly status: 'failed'; readonly reason: unknown }
  | { readonly status: 'cancelled' }

const SLOW_OPERATION_MS = 15_000
const NO_CONNECTION_PRESERVATION: ActionPadConnectionPreservation = Object.freeze({
  fieldEdits: false,
  pathEdit: false
})
const HOST_ERROR_CODES: readonly HostDocumentErrorCode[] = [
  'conflict', 'invalid-path', 'not-found', 'permission', 'too-large', 'io'
]

/** Current path-only preference. The stored value is the selected path as plain text. */
export function actionPadPathStorageKey(endpoint: Endpoint): string {
  return `codey.android.action-pad-path.v1.${encodeURIComponent(endpoint.host)}:${endpoint.port}`
}

/** Removed recovery journal key, retained only for one-way sourcePath migration. */
export function legacyActionPadStorageKey(endpoint: Endpoint): string {
  return `codey.android.action-pad.v1.${encodeURIComponent(endpoint.host)}:${endpoint.port}`
}

/** Keeps edits in memory; only Remote YAML path selections are persisted here. */
export class ActionPadConfigStore {
  readonly #listeners = new Set<() => void>()
  readonly #documents: ActionPadHostDocuments
  readonly #storage: PathStorage
  readonly #logger: DiagnosticLogger
  #state: ActionPadStoreState
  #generation = 0
  #connectionGeneration = 0
  #operationSequence = 0
  #activeRun: ActiveRun | null = null
  #slowTimer: ReturnType<typeof setTimeout> | null = null
  #refreshRequested = false
  #connectionPreservation = NO_CONNECTION_PRESERVATION
  #initialLoadCompleted = false
  #editVersion = 0
  #hydrated = false
  #hydration: Promise<void> = Promise.resolve()
  #pathWriteTail: Promise<void> = Promise.resolve()

  constructor(
    documents: ActionPadHostDocuments,
    storage: PathStorage = AsyncStorage,
    initialEndpoint: Endpoint = DEFAULT_ENDPOINT,
    logger: DiagnosticLogger = diagnosticLogger
  ) {
    this.#documents = documents
    this.#storage = storage
    this.#logger = logger
    this.#state = initialState(initialEndpoint)
  }

  getState = (): ActionPadStoreState => this.#state

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  selectEndpoint(endpoint: Endpoint, localSourcePath: string | null = null): Promise<void> {
    const sourcePath = isLocalActionPadEndpoint(endpoint) && localSourcePath !== null
      ? requirePath(localSourcePath)
      : ''
    if (
      sameEndpoint(endpoint, this.#state.endpoint) && this.#hydrated &&
      (!isLocalActionPadEndpoint(endpoint) || sourcePath === this.#state.sourcePath)
    ) return this.#hydration
    this.#cancelActiveRunWithoutNotice()
    const generation = ++this.#generation
    this.#refreshRequested = false
    this.#connectionPreservation = NO_CONNECTION_PRESERVATION
    this.#initialLoadCompleted = false
    this.#editVersion = 0
    this.#hydrated = true
    this.#state = { ...initialState(endpoint, sourcePath), busy: !isLocalActionPadEndpoint(endpoint) }
    this.#emit()
    this.#hydration = isLocalActionPadEndpoint(endpoint)
      ? Promise.resolve()
      : this.#restoreSelectedPath(endpoint, generation)
    return this.#hydration
  }

  async #restoreSelectedPath(endpoint: Endpoint, generation: number): Promise<void> {
    const pathKey = actionPadPathStorageKey(endpoint)
    const legacyKey = legacyActionPadStorageKey(endpoint)
    const operation = this.#logger.operation({
      category: 'action-pad',
      event: 'action_pad.path_restore',
      message: 'Restoring the selected Action Pad path',
      details: { endpoint, generation, pathKey, legacyKey }
    })
    try {
      await this.#pathWriteTail
      const storedPath = await this.#storage.getItem(pathKey)
      if (generation !== this.#generation) {
        operation.cancellation({
          message: 'Ignored an Action Pad path from a superseded endpoint',
          details: { endpoint, generation, currentGeneration: this.#generation, storedPath }
        })
        return
      }
      if (storedPath !== null && storedPath !== undefined) {
        const sourcePath = requirePath(storedPath)
        this.#set({ sourcePath })
        await this.#removeLegacyRecord(endpoint, generation)
        operation.success({
          message: 'Restored the selected Action Pad path',
          details: { endpoint, generation, source: 'path-preference', sourcePath }
        })
        return
      }

      const rawLegacy = await this.#storage.getItem(legacyKey)
      if (generation !== this.#generation) {
        operation.cancellation({
          message: 'Ignored Action Pad migration from a superseded endpoint',
          details: { endpoint, generation, currentGeneration: this.#generation, rawLegacy }
        })
        return
      }
      if (rawLegacy === null || rawLegacy === undefined) {
        operation.success({
          message: 'No selected Action Pad path was present',
          details: { endpoint, generation, source: 'none' }
        })
        return
      }
      if (rawLegacy.length > ACTION_PAD_CONFIG_MAX_BYTES * 5) {
        throw new Error('The legacy Action Pad record is too large to migrate')
      }
      const sourcePath = requirePath(legacySourcePath(JSON.parse(rawLegacy)))
      if (!await this.#persistSelectedPath(endpoint, sourcePath, generation)) {
        throw new Error('Could not store the migrated Action Pad path')
      }
      await this.#removeLegacyRecord(endpoint, generation)
      if (generation !== this.#generation) return
      this.#set({ sourcePath })
      operation.success({
        message: 'Migrated only the selected path from the legacy Action Pad recovery record',
        details: { endpoint, generation, source: 'legacy-recovery', sourcePath }
      })
    } catch (reason) {
      operation.failure(reason, {
        message: 'Could not restore the selected Action Pad path',
        details: { endpoint, generation }
      })
      if (generation === this.#generation) {
        this.#set({
          notice: notice('warning', `Could not restore the selected Action Pad path. ${messageOf(reason)}`,
            'Connect to use the default path for this endpoint.')
        })
      }
    } finally {
      if (generation === this.#generation) this.#set({ busy: false })
    }
  }

  async setConnected(
    connected: boolean,
    preservation: ActionPadConnectionPreservation = NO_CONNECTION_PRESERVATION
  ): Promise<void> {
    this.#connectionPreservation = { ...preservation }
    const changed = connected !== this.#state.connected
    if (changed) {
      this.#connectionGeneration += 1
      this.#logger.info({
        category: 'action-pad',
        event: 'action_pad.connection_changed',
        message: connected
          ? 'Action Pad host file operations are connected'
          : 'Action Pad host file operations are disconnected',
        details: {
          connected,
          endpoint: this.#state.endpoint,
          connectionGeneration: this.#connectionGeneration,
          activeOperation: this.#state.operation
        }
      })
    }
    if (!connected && this.#activeRun !== null) {
      this.#cancelActiveOperation(
        this.#state.operation?.writeStarted
          ? 'The connection closed while a direct save was in progress.'
          : 'The connection closed before any write began.',
        this.#state.operation?.writeStarted
          ? 'The destination may be incomplete or the save may still finish. Reload it before retrying.'
          : 'Reconnect, then retry the operation.'
      )
    }
    this.#set({ connected })
    if (!connected) {
      this.#refreshRequested = false
      this.#connectionPreservation = NO_CONNECTION_PRESERVATION
      return
    }
    if (!changed || this.#initialLoadCompleted) {
      this.#resumeDeferredInitialLoadIfReady()
      return
    }
    this.#refreshRequested = true
    await this.#hydration
    await this.#refreshIfNeeded()
  }

  setConnectionPreservation(preservation: ActionPadConnectionPreservation): void {
    this.#connectionPreservation = { ...preservation }
    this.#resumeDeferredInitialLoadIfReady()
  }

  /** Stops only the local wait. A host write cannot be cancelled once begun. */
  stopWaiting(): void {
    if (this.#activeRun === null || this.#state.operation === null) return
    const writeStarted = this.#state.operation.writeStarted
    this.#cancelActiveOperation(
      writeStarted
        ? 'Stopped waiting while a direct save was in progress.'
        : 'Stopped waiting before any write began.',
      writeStarted
        ? 'The destination may be incomplete or the save may still finish. Reload it before retrying.'
        : 'Retry when ready.'
    )
  }

  async #refreshIfNeeded(): Promise<void> {
    if (!this.#refreshRequested || !this.#state.connected || this.#state.busy) return
    if (this.#initialLoadCompleted) {
      this.#refreshRequested = false
      return
    }
    this.#refreshRequested = false
    await this.#run('load', this.#state.sourcePath, async (context) => {
      if (this.#state.sourcePath.length === 0 && this.#connectionPreservation.pathEdit) {
        this.#set({
          notice: notice('info', 'Connected. Your unsaved edits are unchanged.',
            'Save them, or use Load / Reload after confirming that they can be discarded.')
        })
        return
      }
      let path: string
      if (this.#state.sourcePath.length === 0 && !this.#connectionPreservation.pathEdit) {
        if (isLocalActionPadEndpoint(context.endpoint)) {
          throw new Error('Choose a Neovim config folder before connecting.')
        }
        const defaultPath = requirePath(await this.#documents.defaultActionPadPath(context.endpoint))
        context.rawLifecycle.defaultActionPadPath = defaultPath
        this.#assertCurrent(context)
        if (this.#connectionPreservation.pathEdit) {
          this.#set({
            notice: notice('info', 'Connected. Your unsaved edits are unchanged.',
              'Save them, or use Load / Reload after confirming that they can be discarded.')
          })
          return
        }
        path = defaultPath
        this.#set({ sourcePath: defaultPath })
        await this.#persistSelectedPath(context.endpoint, defaultPath, context.generation)
        this.#assertCurrent(context)
        this.#updateOperation(context, { path })
      } else {
        path = requirePath(this.#state.sourcePath)
      }
      const preservation = this.#connectionPreservation
      if (this.#state.dirty || preservation.fieldEdits || preservation.pathEdit) {
        this.#set({
          notice: notice('info', 'Connected. Your unsaved edits are unchanged.',
            'Save them, or use Load / Reload after confirming that they can be discarded.')
        })
        return
      }
      await this.#loadDocument(context, path, false)
    })
  }

  setWorkingConfig(config: ActionPadConfig): void {
    if (!isActionPadConfigShape(config)) {
      this.#set({ notice: notice('error', 'This edit has an invalid document structure.') })
      return
    }
    this.#editVersion += 1
    const workingConfig = cloneConfig(config)
    this.#set({ workingConfig, dirty: !sameConfig(workingConfig, this.#state.activeConfig) })
    this.#resumeDeferredInitialLoadIfReady()
  }

  discardWorkingConfig(): void {
    if (this.#state.busy) return
    this.#editVersion += 1
    this.#set({
      workingConfig: cloneConfig(this.#state.activeConfig),
      dirty: false,
      notice: notice('info', 'Unsaved edits discarded.')
    })
    this.#connectionPreservation = NO_CONNECTION_PRESERVATION
    this.#resumeDeferredInitialLoadIfReady()
  }

  /** The screen obtains discard confirmation before calling this method. */
  async load(path: string): Promise<void> {
    const selectedPath = requirePath(path)
    await this.#run('load', selectedPath, async (context) => {
      await this.#loadDocument(context, selectedPath, true)
    })
  }

  async #loadDocument(
    context: OperationContext,
    path: string,
    persistSelection: boolean
  ): Promise<void> {
    const editVersion = this.#editVersion
    this.#updateOperation(context, { phase: 'reading', path })
    const document = await this.#documents.readHostDocument(context.endpoint, path)
    context.rawLifecycle.readDocument = document
    this.#assertCurrent(context)
    const preservation = this.#connectionPreservation
    if (!persistSelection && (
      this.#state.dirty || preservation.fieldEdits || preservation.pathEdit
    )) {
      this.#set({
        notice: notice('info', 'Connected. Your unsaved edits are unchanged.',
          'Save them, or use Load / Reload after confirming that they can be discarded.')
      })
      return
    }
    if (persistSelection && editVersion !== this.#editVersion) {
      throw new Error('The working configuration changed while loading. Try Load again.')
    }
    const config = document.text === null
      ? cloneConfig(DEFAULT_ACTION_PAD_CONFIG)
      : parseActionPadConfig(document.text)
    const selectedPath = requirePath(document.path)
    this.#editVersion += 1
    this.#initialLoadCompleted = true
    this.#refreshRequested = false
    this.#set({
      sourcePath: selectedPath,
      activeConfig: cloneConfig(config),
      workingConfig: cloneConfig(config),
      dirty: false,
      initialLoadPending: false,
      notice: document.text === null
        ? notice('info', 'Using the starter configuration. Save will create the selected host file.')
        : notice('success', `Loaded ${selectedPath}`)
    })
    if (
      persistSelection && !isLocalActionPadEndpoint(context.endpoint) &&
      !await this.#persistSelectedPath(context.endpoint, selectedPath, context.generation)
    ) {
      this.#assertCurrent(context)
      this.#set({
        notice: notice('warning', `Loaded ${selectedPath}, but Codey could not remember this path.`,
          'The file is loaded for this session; select it again after restarting.')
      })
    }
  }

  async save(path: string): Promise<void> {
    const selectedPath = requirePath(path)
    await this.#run('save', selectedPath, async (context) => {
      const config = cloneConfig(this.#state.workingConfig)
      const text = serializeActionPadConfig(config)
      const editVersion = this.#editVersion
      const request: HostDocumentWrite = { path: selectedPath, text }
      context.rawLifecycle.writeRequest = request
      this.#updateOperation(context, {
        phase: 'writing', path: selectedPath, byteCount: utf8ByteLength(text), writeStarted: true
      })
      await this.#documents.writeHostDocument(context.endpoint, request)
      context.rawLifecycle.writeCompleted = true
      this.#assertCurrent(context)
      const workingConfig = editVersion === this.#editVersion ? cloneConfig(config) : this.#state.workingConfig
      this.#initialLoadCompleted = true
      this.#refreshRequested = false
      this.#set({
        sourcePath: selectedPath,
        activeConfig: cloneConfig(config),
        workingConfig,
        dirty: !sameConfig(workingConfig, config),
        initialLoadPending: false
      })
      const shouldPersist = !isLocalActionPadEndpoint(context.endpoint)
      const persisted = !shouldPersist || await this.#persistSelectedPath(
        context.endpoint,
        selectedPath,
        context.generation
      )
      this.#assertCurrent(context)
      this.#set({
        notice: persisted
          ? notice('success', this.#state.dirty
            ? `Saved ${selectedPath}. Newer edits are still unsaved.`
            : `Saved ${selectedPath}`)
          : notice('warning', `Saved ${selectedPath}, but Codey could not remember this path.`,
            'The file is saved; select it again after restarting.')
      })
    })
  }

  /** Waits for path preference writes; primarily useful during shutdown and tests. */
  flushPathStorage(): Promise<void> {
    return this.#pathWriteTail
  }

  async #persistSelectedPath(endpoint: Endpoint, path: string, generation: number): Promise<boolean> {
    const key = actionPadPathStorageKey(endpoint)
    let persisted = true
    this.#pathWriteTail = this.#pathWriteTail.then(async () => {
      try {
        await this.#storage.setItem(key, path)
        this.#logger.debug({
          category: 'action-pad',
          event: 'action_pad.path_persisted',
          message: 'Remembered the selected Action Pad path',
          details: { endpoint, generation, currentGeneration: this.#generation, key, path }
        })
      } catch (reason) {
        persisted = false
        this.#logger.error({
          category: 'action-pad',
          event: 'action_pad.path_persist_failed',
          message: 'Could not remember the selected Action Pad path',
          details: { endpoint, generation, currentGeneration: this.#generation, key, path, reason }
        })
      }
    })
    await this.#pathWriteTail
    return persisted
  }

  async #removeLegacyRecord(endpoint: Endpoint, generation: number): Promise<void> {
    const key = legacyActionPadStorageKey(endpoint)
    this.#pathWriteTail = this.#pathWriteTail.then(async () => {
      try {
        await this.#storage.removeItem(key)
      } catch (reason) {
        this.#logger.warn({
          category: 'action-pad',
          event: 'action_pad.legacy_record_remove_failed',
          message: 'Could not remove the legacy Action Pad recovery record',
          details: { endpoint, generation, currentGeneration: this.#generation, key, reason }
        })
      }
    })
    await this.#pathWriteTail
  }

  async #run(
    kind: ActionPadOperationKind,
    path: string,
    operation: (context: OperationContext) => Promise<void>
  ): Promise<void> {
    if (this.#state.busy) {
      this.#logger.debug({
        category: 'action-pad',
        event: 'action_pad.operation_ignored_busy',
        message: 'Ignored an Action Pad host operation while another operation is active',
        details: { requestedKind: kind, requestedPath: path, activeOperation: this.#state.operation }
      })
      return
    }
    if (!this.#state.connected) {
      this.#logger.warn({
        category: 'action-pad',
        event: 'action_pad.operation_blocked_disconnected',
        message: 'Blocked an Action Pad host operation while disconnected',
        details: { kind, path, endpoint: this.#state.endpoint }
      })
      this.#set({
        notice: notice('error', 'Connect to the Neovim host to load or save the Action Pad file.',
          'Your unsaved edits remain in memory while this screen stays open.')
      })
      return
    }

    const id = ++this.#operationSequence
    const diagnostics = this.#logger.operation({
      category: 'action-pad',
      event: `action_pad.${kind}`,
      message: `Running Action Pad ${kind}`,
      details: {
        id,
        path,
        endpoint: this.#state.endpoint,
        generation: this.#generation,
        connectionGeneration: this.#connectionGeneration,
        sourcePath: this.#state.sourcePath,
        dirty: this.#state.dirty
      }
    })
    const context: OperationContext = {
      id,
      generation: this.#generation,
      connectionGeneration: this.#connectionGeneration,
      endpoint: this.#state.endpoint,
      diagnostics,
      rawLifecycle: {}
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
    this.#activeRun = { id, cancel, diagnostics, rawLifecycle: context.rawLifecycle }
    this.#set({ busy: true, operation: operationState, notice: null })
    this.#slowTimer = setTimeout(() => {
      if (this.#activeRun?.id !== id || this.#state.operation?.id !== id) return
      this.#set({ operation: { ...this.#state.operation, slow: true } })
      diagnostics.checkpoint({
        event: `action_pad.${kind}.slow`,
        message: `Action Pad ${kind} is taking longer than expected`,
        level: 'warn',
        details: { operation: this.#state.operation, endpoint: context.endpoint }
      })
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
      // A preservation-clear notification may have queued an automatic refresh
      // while this operation was in flight. Do not turn one host failure into an
      // immediate hidden retry; reconnect or an explicit user action can retry.
      this.#refreshRequested = false
      const failureNotice = operationFailureNotice(outcome.reason, finalOperation)
      diagnostics.failure(outcome.reason, {
        message: `Action Pad ${kind} failed`,
        details: {
          operation: finalOperation,
          endpoint: context.endpoint,
          notice: failureNotice,
          rawLifecycle: context.rawLifecycle
        }
      })
      this.#set({ busy: false, operation: null, notice: failureNotice })
    } else {
      diagnostics.success({
        message: `Action Pad ${kind} completed`,
        details: {
          operation: finalOperation,
          endpoint: context.endpoint,
          sourcePath: this.#state.sourcePath,
          notice: this.#state.notice,
          dirty: this.#state.dirty,
          rawLifecycle: context.rawLifecycle
        }
      })
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
    const next = { ...current, ...change }
    this.#set({ operation: next })
    context.diagnostics.checkpoint({
      event: `action_pad.${current.kind}.phase`,
      message: `Action Pad ${current.kind} entered ${next.phase}`,
      details: { previous: current, operation: next, endpoint: context.endpoint }
    })
  }

  #cancelActiveOperation(summary: string, recommendedAction: string): void {
    const operation = this.#state.operation
    const active = this.#activeRun
    if (operation === null || active === null) return
    this.#clearSlowTimer()
    this.#activeRun = null
    active.diagnostics.cancellation({
      message: summary,
      details: {
        operation,
        endpoint: this.#state.endpoint,
        recommendedAction,
        rawLifecycle: active.rawLifecycle
      }
    })
    active.cancel()
    this.#set({
      busy: false,
      operation: null,
      notice: notice('warning', summary, recommendedAction, operationDetails(operation))
    })
  }

  #cancelActiveRunWithoutNotice(): void {
    const active = this.#activeRun
    this.#clearSlowTimer()
    this.#activeRun = null
    active?.diagnostics.cancellation({
      message: 'Action Pad operation was superseded by an endpoint change',
      details: {
        operation: this.#state.operation,
        endpoint: this.#state.endpoint,
        rawLifecycle: active.rawLifecycle
      }
    })
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

  #resumeDeferredInitialLoadIfReady(): void {
    if (
      !this.#state.connected || this.#initialLoadCompleted || this.#state.dirty ||
      this.#connectionPreservation.fieldEdits || this.#connectionPreservation.pathEdit
    ) return
    this.#refreshRequested = true
    void this.#refreshIfNeeded()
  }

  #assertCurrent(context: OperationContext): void {
    if (
      context.id !== this.#activeRun?.id ||
      context.generation !== this.#generation ||
      context.connectionGeneration !== this.#connectionGeneration ||
      !this.#state.connected
    ) {
      throw new Error('The host connection changed. Your unsaved edits remain in memory; reconnect and reload the file.')
    }
  }

  #set(change: Partial<ActionPadStoreState>): void {
    const next = { ...this.#state, ...change }
    const projectedNotice = next.notice
    this.#state = {
      ...next,
      message: projectedNotice?.summary ?? '',
      error: projectedNotice?.severity === 'error'
    }
    this.#emit()
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }
}

function initialState(endpoint: Endpoint, sourcePath = ''): ActionPadStoreState {
  const initialNotice = notice('info', 'Starter configuration. Connect to load the selected YAML file.')
  return {
    endpoint,
    sourcePath,
    activeConfig: cloneConfig(DEFAULT_ACTION_PAD_CONFIG),
    workingConfig: cloneConfig(DEFAULT_ACTION_PAD_CONFIG),
    dirty: false,
    busy: false,
    connected: false,
    initialLoadPending: true,
    operation: null,
    notice: initialNotice,
    message: initialNotice.summary,
    error: false
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

function operationFailureNotice(reason: unknown, operation: ActionPadOperation): ActionPadNotice {
  const host = hostFailureOf(reason)
  const socket = socketFailureOf(reason)
  const details: ActionPadNoticeDetails = {
    ...operationDetails(operation),
    ...(host.code === undefined ? {} : { hostErrorCode: host.code }),
    ...(socket.code === undefined ? {} : { socketCode: socket.code }),
    ...(socket.message === undefined ? {} : { nativeSocketMessage: socket.message })
  }
  let recommendedAction: string
  if (operation.writeStarted) {
    recommendedAction = 'The YAML may now be complete or incomplete. Reload it before retrying; restore your backup if needed.'
  } else if (socket.code !== undefined) {
    recommendedAction = 'No write started. Reconnect, then retry the operation.'
  } else if (host.code === 'permission') {
    recommendedAction = 'Check that Codey can write this host path, then retry or choose another path.'
  } else {
    recommendedAction = 'Review the details and retry after the host issue is resolved.'
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

function hostFailureOf(reason: unknown): { readonly code?: HostDocumentErrorCode } {
  for (const candidate of errorChain(reason)) {
    const record = candidate as { readonly code?: unknown; readonly name?: unknown }
    const code = typeof record.code === 'string' && HOST_ERROR_CODES.includes(record.code as HostDocumentErrorCode)
      ? record.code as HostDocumentErrorCode
      : undefined
    if (code !== undefined || record.name === 'HostDocumentError') return { code }
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
  const selected = path.trim()
  if (!selected.startsWith('/') && !selected.startsWith('~/')) {
    throw new Error('Enter an absolute host path or a path beginning with ~/.')
  }
  return selected
}

function messageOf(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  if (isRecord(reason) && typeof reason.message === 'string') return reason.message
  return 'The file operation failed.'
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

function legacySourcePath(value: unknown): string {
  if (!isRecord(value) || value.version !== 1 || typeof value.sourcePath !== 'string') {
    throw new Error('Invalid legacy Action Pad recovery record')
  }
  return requirePath(value.sourcePath)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
