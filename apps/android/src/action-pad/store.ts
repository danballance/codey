import type { HostDocument, HostDocumentErrorCode } from '@codey/nvim-session'

import { diagnosticLogger, type DiagnosticLogger, type DiagnosticOperation } from '../diagnostics/logger'
import { DEFAULT_ACTION_PAD_CONFIG } from './config'
import {
  ActionPadConfigError,
  isActionPadConfigShape,
  parseActionPadConfig,
  serializeActionPadConfig,
  type ActionPadConfig
} from './document'

export interface ActionPadHostDocuments {
  readActionPad(): Promise<HostDocument>
  writeActionPad(text: string): Promise<void>
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
  readonly nativeCode?: string
  readonly nativeMessage?: string
}

export interface ActionPadNotice {
  readonly severity: ActionPadNoticeSeverity
  readonly summary: string
  readonly recommendedAction?: string
  readonly details?: ActionPadNoticeDetails
}

export interface ActionPadStoreState {
  /** Fixed YAML path below the selected local Neovim config directory. */
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
}

interface OperationContext {
  readonly id: number
  readonly generation: number
  readonly connectionGeneration: number
  readonly diagnostics: DiagnosticOperation
  readonly lifecycle: Record<string, unknown>
}

interface ActiveRun {
  readonly id: number
  readonly cancel: () => void
  readonly diagnostics: DiagnosticOperation
  readonly lifecycle: Record<string, unknown>
}

type OperationOutcome =
  | { readonly status: 'completed' }
  | { readonly status: 'failed'; readonly reason: unknown }
  | { readonly status: 'cancelled' }

const SLOW_OPERATION_MS = 15_000
const NO_CONNECTION_PRESERVATION: ActionPadConnectionPreservation = Object.freeze({
  fieldEdits: false
})
const HOST_ERROR_CODES: readonly HostDocumentErrorCode[] = [
  'conflict', 'invalid-path', 'not-found', 'permission', 'too-large', 'io'
]

/** Keeps Action Pad edits in memory and accesses one fixed local YAML document. */
export class ActionPadConfigStore {
  readonly #listeners = new Set<() => void>()
  readonly #documents: ActionPadHostDocuments
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

  constructor(
    documents: ActionPadHostDocuments,
    initialSourcePath = '',
    logger: DiagnosticLogger = diagnosticLogger
  ) {
    this.#documents = documents
    this.#logger = logger
    this.#state = initialState(normalizeOptionalPath(initialSourcePath))
  }

  getState = (): ActionPadStoreState => this.#state

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  selectSource(sourcePath: string | null): void {
    const normalizedPath = normalizeOptionalPath(sourcePath ?? '')
    if (normalizedPath === this.#state.sourcePath) return
    const connected = this.#state.connected
    this.#cancelActiveRunWithoutNotice()
    this.#generation += 1
    this.#refreshRequested = connected
    this.#connectionPreservation = NO_CONNECTION_PRESERVATION
    this.#initialLoadCompleted = false
    this.#editVersion = 0
    this.#state = { ...initialState(normalizedPath), connected }
    this.#emit()
    this.#logger.info({
      category: 'action-pad',
      event: 'action_pad.source_changed',
      message: 'Selected the fixed local Action Pad document',
      details: { sourcePath: normalizedPath, generation: this.#generation }
    })
    if (connected) void this.#refreshIfNeeded()
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
          ? 'Action Pad local file operations are connected'
          : 'Action Pad local file operations are disconnected',
        details: {
          connected,
          sourcePath: this.#state.sourcePath,
          connectionGeneration: this.#connectionGeneration,
          activeOperation: this.#state.operation
        }
      })
    }
    if (!connected && this.#activeRun !== null) {
      this.#cancelActiveOperation(
        this.#state.operation?.writeStarted
          ? 'The Neovim process closed while a direct save was in progress.'
          : 'The Neovim process closed before any write began.',
        this.#state.operation?.writeStarted
          ? 'The destination may be incomplete or the save may still finish. Reload it before retrying.'
          : 'Start Neovim again, then retry the operation.'
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
    await this.#refreshIfNeeded()
  }

  setConnectionPreservation(preservation: ActionPadConnectionPreservation): void {
    this.#connectionPreservation = { ...preservation }
    this.#resumeDeferredInitialLoadIfReady()
  }

  /** Stops only the local wait. A process write cannot be cancelled once begun. */
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
    if (this.#state.sourcePath.length === 0) {
      this.#refreshRequested = false
      this.#set({ notice: notice('error', 'Choose a Neovim config folder before starting Neovim.') })
      return
    }
    this.#refreshRequested = false
    const preservation = this.#connectionPreservation
    if (this.#state.dirty || preservation.fieldEdits) {
      this.#set({
        notice: notice('info', 'Connected. Your unsaved edits are unchanged.',
          'Save them, or use Reload after confirming that they can be discarded.')
      })
      return
    }
    await this.#run('load', async (context) => {
      await this.#loadDocument(context, false)
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
  async load(): Promise<void> {
    await this.#run('load', async (context) => {
      await this.#loadDocument(context, true)
    })
  }

  async #loadDocument(context: OperationContext, explicit: boolean): Promise<void> {
    const path = requirePath(this.#state.sourcePath)
    const editVersion = this.#editVersion
    this.#updateOperation(context, { phase: 'reading', path })
    const document = await this.#documents.readActionPad()
    context.lifecycle.read = {
      path: document.path,
      missing: document.text === null,
      byteCount: document.text === null ? 0 : utf8ByteLength(document.text)
    }
    this.#assertCurrent(context)
    const preservation = this.#connectionPreservation
    if (!explicit && (this.#state.dirty || preservation.fieldEdits)) {
      this.#set({
        notice: notice('info', 'Connected. Your unsaved edits are unchanged.',
          'Save them, or use Reload after confirming that they can be discarded.')
      })
      return
    }
    if (explicit && editVersion !== this.#editVersion) {
      throw new Error('The working configuration changed while reloading. Try Reload again.')
    }
    const documentPath = requirePath(document.path)
    if (documentPath !== path) {
      throw new Error('The active Neovim config folder changed while loading the Action Pad.')
    }
    const config = document.text === null
      ? cloneConfig(DEFAULT_ACTION_PAD_CONFIG)
      : parseActionPadConfig(document.text)
    this.#editVersion += 1
    this.#initialLoadCompleted = true
    this.#refreshRequested = false
    this.#set({
      activeConfig: cloneConfig(config),
      workingConfig: cloneConfig(config),
      dirty: false,
      initialLoadPending: false,
      notice: document.text === null
        ? notice('info', 'Using the starter configuration. Save will create the local Action Pad file.')
        : notice('success', `Loaded ${path}`)
    })
  }

  async save(): Promise<void> {
    await this.#run('save', async (context) => {
      const path = requirePath(this.#state.sourcePath)
      const config = cloneConfig(this.#state.workingConfig)
      const text = serializeActionPadConfig(config)
      const byteCount = utf8ByteLength(text)
      const editVersion = this.#editVersion
      context.lifecycle.write = { path, byteCount }
      this.#updateOperation(context, { phase: 'writing', path, byteCount, writeStarted: true })
      await this.#documents.writeActionPad(text)
      context.lifecycle.writeCompleted = true
      this.#assertCurrent(context)
      const workingConfig = editVersion === this.#editVersion
        ? cloneConfig(config)
        : this.#state.workingConfig
      this.#initialLoadCompleted = true
      this.#refreshRequested = false
      this.#set({
        activeConfig: cloneConfig(config),
        workingConfig,
        dirty: !sameConfig(workingConfig, config),
        initialLoadPending: false,
        notice: notice('success', editVersion === this.#editVersion
          ? `Saved ${path}`
          : `Saved ${path}. Newer edits are still unsaved.`)
      })
    })
  }

  async #run(
    kind: ActionPadOperationKind,
    operation: (context: OperationContext) => Promise<void>
  ): Promise<void> {
    const path = this.#state.sourcePath
    if (this.#state.busy) {
      this.#logger.debug({
        category: 'action-pad',
        event: 'action_pad.operation_ignored_busy',
        message: 'Ignored an Action Pad operation while another operation is active',
        details: { requestedKind: kind, sourcePath: path, activeOperation: this.#state.operation }
      })
      return
    }
    if (!this.#state.connected) {
      this.#logger.warn({
        category: 'action-pad',
        event: 'action_pad.operation_blocked_disconnected',
        message: 'Blocked an Action Pad operation while Neovim is stopped',
        details: { kind, sourcePath: path }
      })
      this.#set({
        notice: notice('error', 'Start local Neovim to load or save the Action Pad file.',
          'Your unsaved edits remain in memory while this screen stays open.')
      })
      return
    }
    if (path.length === 0) {
      this.#set({ notice: notice('error', 'Choose a Neovim config folder first.') })
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
        generation: this.#generation,
        connectionGeneration: this.#connectionGeneration,
        dirty: this.#state.dirty
      }
    })
    const context: OperationContext = {
      id,
      generation: this.#generation,
      connectionGeneration: this.#connectionGeneration,
      diagnostics,
      lifecycle: {}
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
    this.#activeRun = { id, cancel, diagnostics, lifecycle: context.lifecycle }
    this.#set({ busy: true, operation: operationState, notice: null })
    this.#slowTimer = setTimeout(() => {
      if (this.#activeRun?.id !== id || this.#state.operation?.id !== id) return
      this.#set({ operation: { ...this.#state.operation, slow: true } })
      diagnostics.checkpoint({
        event: `action_pad.${kind}.slow`,
        message: `Action Pad ${kind} is taking longer than expected`,
        level: 'warn',
        details: { operation: this.#state.operation, sourcePath: path }
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
      this.#refreshRequested = false
      const failureNotice = operationFailureNotice(outcome.reason, finalOperation)
      diagnostics.failure(new Error('Action Pad operation failed'), {
        message: `Action Pad ${kind} failed`,
        details: {
          operation: finalOperation,
          failure: diagnosticFailureOf(outcome.reason),
          lifecycle: context.lifecycle
        }
      })
      this.#set({ busy: false, operation: null, notice: failureNotice })
    } else {
      diagnostics.success({
        message: `Action Pad ${kind} completed`,
        details: {
          operation: finalOperation,
          sourcePath: this.#state.sourcePath,
          notice: this.#state.notice,
          dirty: this.#state.dirty,
          lifecycle: context.lifecycle
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
    if (current === null || current.id !== context.id) {
      throw new Error('The Action Pad operation is no longer active.')
    }
    const next = { ...current, ...change }
    this.#set({ operation: next })
    context.diagnostics.checkpoint({
      event: `action_pad.${current.kind}.phase`,
      message: `Action Pad ${current.kind} entered ${next.phase}`,
      details: { previous: current, operation: next }
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
      details: { operation, recommendedAction, lifecycle: active.lifecycle }
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
      message: 'Action Pad operation was superseded by a local config change',
      details: { operation: this.#state.operation, lifecycle: active.lifecycle }
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
      this.#connectionPreservation.fieldEdits
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
      throw new Error('The local Neovim process changed. Your unsaved edits remain in memory; restart and reload the file.')
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

function initialState(sourcePath = ''): ActionPadStoreState {
  const initialNotice = notice('info', 'Starter configuration. Start Neovim to load the local YAML file.')
  return {
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
  const native = nativeFailureOf(reason)
  const details: ActionPadNoticeDetails = {
    ...operationDetails(operation),
    ...(host.code === undefined ? {} : { hostErrorCode: host.code }),
    ...(native.code === undefined ? {} : { nativeCode: native.code }),
    ...(native.message === undefined ? {} : { nativeMessage: native.message })
  }
  let recommendedAction: string
  if (operation.writeStarted) {
    recommendedAction = 'The YAML may now be complete or incomplete. Reload it before retrying; restore your backup if needed.'
  } else if (native.code !== undefined) {
    recommendedAction = 'No write started. Restart Neovim, then retry the operation.'
  } else if (host.code === 'permission') {
    recommendedAction = 'Check that Codey can write the selected local config folder, then retry.'
  } else {
    recommendedAction = 'Review the details and retry after the local file issue is resolved.'
  }
  return notice('error', messageOf(reason), recommendedAction, details)
}

function diagnosticFailureOf(reason: unknown): Record<string, unknown> {
  for (const candidate of errorChain(reason)) {
    if (candidate instanceof ActionPadConfigError) {
      return { kind: 'configuration', issueCount: candidate.issues.length }
    }
  }
  const host = hostFailureOf(reason)
  if (host.code !== undefined) return { kind: 'file', code: host.code }
  const native = nativeFailureOf(reason)
  if (native.code !== undefined) return { kind: 'native-process', code: native.code }
  return { kind: 'unknown' }
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

function nativeFailureOf(reason: unknown): { readonly code?: string; readonly message?: string } {
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
      : typeof record.code === 'string' && record.code.startsWith('E_NVIM_')
        ? record.code
        : typeof record.name === 'string' && record.name.startsWith('E_NVIM_')
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

function sameConfig(a: ActionPadConfig, b: ActionPadConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function cloneConfig(config: ActionPadConfig): ActionPadConfig {
  return JSON.parse(JSON.stringify(config)) as ActionPadConfig
}

function normalizeOptionalPath(path: string): string {
  const selected = path.trim()
  return selected.length === 0 ? '' : requirePath(selected)
}

function requirePath(path: string): string {
  const selected = path.trim()
  if (!selected.startsWith('/')) throw new Error('Choose an absolute local Action Pad path.')
  return selected
}

function messageOf(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  if (isRecord(reason) && typeof reason.message === 'string') return reason.message
  return 'The local file operation failed.'
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
