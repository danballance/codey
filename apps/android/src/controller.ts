import {
  applyRedrawBatch,
  createEditorState,
  toSnapshot,
  type EditorSnapshot,
  type EditorState
} from '@codey/editor-core'
import type {
  HostDocument,
  HostDocumentWrite,
  MouseInput,
  RedrawBatch
} from '@codey/nvim-session'
import {
  currentPerformanceTags,
  performanceDiagnosticsEnabled,
  performanceNow,
  recordPerformance,
  withPerformanceTags,
  type PerformanceInputSample,
  type PerformanceTags
} from '@codey/perf'
import type { DuplexTransport } from '@codey/transport'
import { Systrace } from 'react-native'

import {
  actionPadEndpointForTarget,
  connectionTargetLabel,
  createRemoteConnectionTarget,
  validateConnectionTarget,
  type ConnectionTarget
} from './connection-target'
import {
  diagnosticLogger,
  type DiagnosticLogger,
  type DiagnosticOperation
} from './diagnostics/logger'
import { diagnosticOriginOf } from './diagnostics/origin'
import type { Endpoint } from './endpoint'
import { sameGridSize, type GridSize } from './grid'

export type ConnectionPhase = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface ConnectionFailure {
  /** Stable app/native code suitable for diagnostics and recovery UI. */
  readonly code: string
  readonly message: string
  /** Exact code emitted by the Android socket layer, when one was supplied. */
  readonly nativeCode?: string
  readonly nativeMessage?: string
}

export class ConnectionFailureError extends Error {
  public constructor(
    public readonly failure: ConnectionFailure,
    cause?: unknown
  ) {
    super(failure.message, cause === undefined ? undefined : { cause })
    this.name = 'ConnectionFailureError'
  }
}

export interface ClientState {
  readonly phase: ConnectionPhase
  readonly message: string
  readonly connectionFailure: ConnectionFailure | null
  readonly snapshot: EditorSnapshot | null
  readonly gridSize: GridSize
  readonly performanceSamples: readonly PublishedPerformanceSample[]
}

export type PublishedPerformanceSample = Readonly<
  PerformanceInputSample & PerformanceTags & { readonly flushCount: number }
>

type PendingPerformanceSample = Readonly<PerformanceInputSample & PerformanceTags>

export interface MobileSession {
  connect(): Promise<void>
  attach(width: number, height: number): Promise<void>
  input(keys: string): Promise<void>
  inputMouse(mouse: MouseInput): Promise<void>
  resize(width: number, height: number): Promise<void>
  defaultActionPadPath(): Promise<string>
  readHostDocument(path: string): Promise<HostDocument>
  writeHostDocument(request: HostDocumentWrite): Promise<void>
  onRedraw(listener: (batch: RedrawBatch) => void): () => void
  close(): Promise<void>
}

export interface ConnectionResources {
  readonly transport: DuplexTransport
  readonly session: MobileSession
  readonly disposeDiagnostics?: () => void
}

export interface ConnectionDiagnosticContext {
  readonly generation: number
  readonly operationId: string
}

export type ConnectionFactory = (
  target: ConnectionTarget,
  diagnostics?: ConnectionDiagnosticContext
) => ConnectionResources

export type ConnectionTargetInput = ConnectionTarget | Endpoint

export interface FrameScheduler {
  request(callback: (timestampMs: number) => void): number
  cancel(handle: number): void
}

interface ActiveConnection extends ConnectionResources {
  readonly generation: number
  readonly target: ConnectionTarget
  readonly connectOperation: DiagnosticOperation
  editorState: EditorState
  ready: boolean
  closing: boolean
  closePromise: Promise<void> | null
  attachedGrid: GridSize | null
  pendingSnapshot: EditorSnapshot | null
  pendingInputSamples: PendingPerformanceSample[]
  pendingPublicationSamples: PublishedPerformanceSample[]
  publicationFrame: number | null
  removeRedrawListener: () => void
  removeCloseListener: () => void
  removeDiagnosticListeners: () => void
}

const INITIAL_GRID: GridSize = Object.freeze({ columns: 80, rows: 24 })
const EMPTY_PERFORMANCE_SAMPLES: readonly PublishedPerformanceSample[] = Object.freeze([])
const MAX_PENDING_PERFORMANCE_SAMPLES = 256
const ANDROID_FRAME_SCHEDULER: FrameScheduler = Object.freeze({
  request: (callback: (timestampMs: number) => void) => requestAnimationFrame(callback),
  cancel: (handle: number) => cancelAnimationFrame(handle)
})

export class TabletClientController {
  readonly #listeners = new Set<() => void>()
  readonly #factory: ConnectionFactory
  readonly #frameScheduler: FrameScheduler
  readonly #logger: DiagnosticLogger

  #state: ClientState = {
    phase: 'disconnected',
    message: 'Not connected',
    connectionFailure: null,
    snapshot: null,
    gridSize: INITIAL_GRID,
    performanceSamples: EMPTY_PERFORMANCE_SAMPLES
  }
  #active: ActiveConnection | null = null
  #nextGeneration = 1
  #latestConnectRequest = 0
  #disposed = false
  #closeInFlight: Promise<void> | null = null
  #disposePromise: Promise<void> | null = null
  #pendingResize: { readonly connection: ActiveConnection; readonly size: GridSize } | null = null
  #resizeDrain: Promise<void> | null = null

  public constructor(
    factory: ConnectionFactory,
    frameScheduler: FrameScheduler = ANDROID_FRAME_SCHEDULER,
    logger: DiagnosticLogger = diagnosticLogger
  ) {
    this.#factory = factory
    this.#frameScheduler = frameScheduler
    this.#logger = logger
  }

  public getState = (): ClientState => this.#state

  public subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  public async connect(input: ConnectionTargetInput): Promise<void> {
    this.#assertUsable()
    const target = normalizeConnectionTarget(input)
    const generation = this.#nextGeneration++
    const connectOperation = this.#logger.operation({
      category: 'connection',
      event: 'connection.connect',
      message: 'Establishing a Neovim connection',
      details: { generation, target }
    })
    this.#latestConnectRequest = generation
    try {
      await this.#closeActive(false)
    } catch (reason) {
      connectOperation.failure(reason, {
        message: 'Could not safely close the previous Neovim connection',
        details: { generation, target }
      })
      if (!this.#disposed) this.#setError(reason, 'Could not close the previous connection')
      return
    }
    if (this.#disposed || generation !== this.#latestConnectRequest) {
      connectOperation.cancellation({
        message: 'Connection creation was superseded before resources were created',
        details: { generation, disposed: this.#disposed, latestGeneration: this.#latestConnectRequest }
      })
      return
    }

    let resources: ConnectionResources
    try {
      resources = this.#factory(target, {
        generation,
        operationId: connectOperation.id
      })
      connectOperation.checkpoint({
        event: 'connection.resources.created',
        message: 'Created connection resources',
        details: { generation, target }
      })
    } catch (reason) {
      connectOperation.failure(reason, {
        message: 'Could not create Android connection resources',
        details: { generation, target }
      })
      this.#setError(reason, 'Could not create the Android connection')
      return
    }

    const connection: ActiveConnection = {
      ...resources,
      generation,
      target,
      connectOperation,
      editorState: createEditorState(),
      ready: false,
      closing: false,
      closePromise: null,
      attachedGrid: null,
      pendingSnapshot: null,
      pendingInputSamples: [],
      pendingPublicationSamples: [],
      publicationFrame: null,
      removeRedrawListener: () => undefined,
      removeCloseListener: () => undefined,
      removeDiagnosticListeners: resources.disposeDiagnostics ?? (() => undefined)
    }
    this.#active = connection
    this.#replaceState({
      phase: 'connecting',
      message: target.kind === 'local'
        ? `Starting ${connectionTargetLabel(target)}…`
        : `Connecting to ${remoteTargetAddress(target)}…`,
      connectionFailure: null,
      snapshot: null,
      performanceSamples: EMPTY_PERFORMANCE_SAMPLES
    })

    try {
      const removeRedrawListener = connection.session.onRedraw((batch) => {
        this.#receiveRedraw(connection, batch)
      })
      if (connection.closing) {
        this.#releaseObserver(connection, 'redraw', removeRedrawListener)
      } else {
        connection.removeRedrawListener = removeRedrawListener
      }

      const removeCloseListener = connection.transport.onClose((error) => {
        this.#receiveClose(connection, error)
      })
      if (connection.closing) {
        this.#releaseObserver(connection, 'transport-close', removeCloseListener)
      } else {
        connection.removeCloseListener = removeCloseListener
      }

      if (!this.#isCurrent(connection)) {
        connectOperation.failure(this.#state.connectionFailure, {
          message: 'The Neovim connection closed while observers were being registered',
          details: { generation, target }
        })
        await this.#closeConnection(connection).catch(() => undefined)
        return
      }

      await connection.session.connect()
      connectOperation.checkpoint({
        event: 'connection.session.connected',
        message: 'Connected the MessagePack-RPC session',
        details: { generation }
      })
      if (!this.#isCurrent(connection)) {
        connectOperation.cancellation({
          message: 'Connection was superseded after session connect',
          details: { generation, latestGeneration: this.#latestConnectRequest }
        })
        await this.#closeConnection(connection).catch(() => undefined)
        return
      }

      const attachGrid = this.#state.gridSize
      await connection.session.attach(attachGrid.columns, attachGrid.rows)
      connectOperation.checkpoint({
        event: 'connection.session.attached',
        message: 'Attached the Neovim UI session',
        details: { generation, grid: attachGrid }
      })
      if (!this.#isCurrent(connection)) {
        connectOperation.cancellation({
          message: 'Connection was superseded after session attach',
          details: { generation, latestGeneration: this.#latestConnectRequest }
        })
        await this.#closeConnection(connection).catch(() => undefined)
        return
      }

      connection.attachedGrid = attachGrid
      connection.ready = true
      this.#replaceState({
        phase: 'connected',
        message: target.kind === 'local'
          ? `Running ${connectionTargetLabel(target)}`
          : `Connected to ${remoteTargetAddress(target)}`,
        connectionFailure: null
      })
      connectOperation.success({
        message: 'Neovim connection is ready',
        details: { generation, target, grid: attachGrid }
      })

      const latestGrid = this.#state.gridSize
      if (!sameGridSize(attachGrid, latestGrid)) {
        await this.#scheduleResize(connection, latestGrid)
      }
    } catch (reason) {
      if (!this.#isCurrent(connection) && (
        this.#disposed || generation !== this.#latestConnectRequest
      )) {
        connectOperation.cancellation({
          message: 'Connection failed after it was superseded',
          details: {
            generation,
            latestGeneration: this.#latestConnectRequest,
            reason: diagnosticReason(reason)
          }
        })
        await this.#closeConnection(connection).catch(() => undefined)
        return
      }
      connectOperation.failure(diagnosticReason(reason), {
        message: 'Neovim connection failed',
        details: {
          generation,
          target,
          origin: diagnosticOriginOf(reason)
        }
      })
      await this.#closeConnection(connection).catch(() => undefined)
      if (!this.#disposed) this.#setError(reason, 'Connection failed')
    }
  }

  public async disconnect(): Promise<void> {
    if (this.#disposed) return
    const active = this.#active
    const operation = this.#logger.operation({
      category: 'connection',
      event: 'connection.disconnect',
      message: 'Disconnecting the active Neovim session',
      parentOperationId: active?.connectOperation.id,
      details: active === null ? { active: false } : {
        active: true,
        generation: active.generation,
        target: active.target
      }
    })
    this.#latestConnectRequest = this.#nextGeneration++
    try {
      await this.#closeActive(true)
      operation.success({ message: 'Disconnected the Neovim session' })
    } catch (reason) {
      operation.failure(reason, { message: 'Neovim disconnect cleanup failed' })
    }
  }

  public async input(keys: string): Promise<void> {
    if (keys.length === 0) return
    const connection = this.#active
    if (connection === null || !connection.ready || connection.closing) return

    const diagnosticsEnabled = performanceDiagnosticsEnabled()
    const inheritedTags = diagnosticsEnabled ? currentPerformanceTags() : undefined
    const performanceTags: PerformanceTags | undefined = diagnosticsEnabled
      ? {
          inputLength: keys.length,
          connectionGeneration: connection.generation,
          resizeInFlight: this.#resizeInFlight()
        }
      : undefined
    if (inheritedTags !== undefined && performanceTags !== undefined) {
      const sample = inputSampleFromTags({ ...inheritedTags, ...performanceTags })
      if (sample !== null) this.#enqueuePerformanceSample(connection, sample)
    }
    if (performanceTags !== undefined) {
      recordPerformance('controller_input', {
        durationMs: 0,
        tags: performanceTags
      })
    }

    try {
      const inputPromise = performanceTags !== undefined
        ? withPerformanceTags(performanceTags, () => connection.session.input(keys))
        : connection.session.input(keys)
      await inputPromise
    } catch (reason) {
      if (this.#isCurrent(connection)) {
        this.#logger.error({
          category: 'ime',
          event: 'input.write_failed',
          message: 'Neovim input failed and the connection will close',
          operationId: connection.connectOperation.id,
          details: {
            generation: connection.generation,
            keys,
            reason: diagnosticReason(reason)
          }
        })
        await this.#failConnection(connection, reason, 'Input failed')
      }
    }
  }

  public async inputMouse(mouse: MouseInput): Promise<void> {
    const connection = this.#active
    if (connection === null || !connection.ready || connection.closing) return

    try {
      await connection.session.inputMouse(mouse)
    } catch (reason) {
      if (this.#isCurrent(connection)) {
        this.#logger.error({
          category: 'ime',
          event: 'mouse.write_failed',
          message: 'Neovim mouse input failed and the connection will close',
          operationId: connection.connectOperation.id,
          details: {
            generation: connection.generation,
            mouse,
            reason: diagnosticReason(reason)
          }
        })
        await this.#failConnection(connection, reason, 'Mouse input failed')
      }
    }
  }

  public defaultActionPadPath(endpoint: Endpoint): Promise<string> {
    return this.#documentOperation(endpoint, (session) => session.defaultActionPadPath())
  }

  public readHostDocument(endpoint: Endpoint, path: string): Promise<HostDocument> {
    return this.#documentOperation(endpoint, (session) => session.readHostDocument(path))
  }

  public writeHostDocument(endpoint: Endpoint, request: HostDocumentWrite): Promise<void> {
    return this.#documentOperation(endpoint, (session) => session.writeHostDocument(request))
  }

  async #documentOperation<T>(endpoint: Endpoint, operation: (session: MobileSession) => Promise<T>): Promise<T> {
    const connection = this.#active
    const actionPadEndpoint = connection === null
      ? null
      : actionPadEndpointForTarget(connection.target)
    if (
      connection === null || !connection.ready || connection.closing ||
      actionPadEndpoint === null ||
      actionPadEndpoint.host !== endpoint.host || actionPadEndpoint.port !== endpoint.port
    ) {
      throw new Error('Connect to this configuration’s Neovim session before accessing its files.')
    }

    try {
      // Document RPCs have no client-side deadline. The Action Pad store marks
      // a pending request as slow after 15 seconds and lets the user explicitly
      // disconnect; abandoning a wait must never replay a write.
      const result = await operation(connection.session)
      if (!this.#isCurrent(connection) || !connection.ready || connection.closing) {
        const failure = this.#state.connectionFailure
        if (failure !== null) throw new ConnectionFailureError(failure)
        throw new Error('The connection changed during the file operation. Reconnect and check the file before retrying.')
      }
      return result
    } catch (reason) {
      const failure = this.#state.connectionFailure
      if (failure !== null && !(reason instanceof ConnectionFailureError)) {
        throw new ConnectionFailureError(failure, reason)
      }
      throw reason
    }
  }

  public setGridSize(size: GridSize): void {
    if (sameGridSize(this.#state.gridSize, size)) return
    this.#replaceState({ gridSize: size })
    const connection = this.#active
    if (connection !== null && connection.ready && !connection.closing) {
      void this.#scheduleResize(connection, size)
    }
  }

  public dispose(): Promise<void> {
    if (this.#disposed) return this.#disposePromise ?? Promise.resolve()
    const active = this.#active
    const operation = this.#logger.operation({
      category: 'connection',
      event: 'connection.controller_dispose',
      message: 'Disposing the tablet connection controller',
      parentOperationId: active?.connectOperation.id,
      details: active === null ? { active: false } : {
        active: true,
        generation: active.generation,
        target: active.target
      }
    })
    this.#disposed = true
    this.#latestConnectRequest = this.#nextGeneration++
    this.#listeners.clear()
    this.#disposePromise = (async () => {
      try {
        await this.#closeActive(false)
        operation.success({ message: 'Disposed the tablet connection controller' })
      } catch (reason) {
        operation.failure(reason, { message: 'Tablet connection controller disposal failed' })
      } finally {
        this.#replaceState({
          phase: 'disconnected',
          message: 'Disposed',
          connectionFailure: null,
          snapshot: null,
          performanceSamples: EMPTY_PERFORMANCE_SAMPLES
        })
      }
    })()
    return this.#disposePromise
  }

  #scheduleResize(connection: ActiveConnection, size: GridSize): Promise<void> {
    this.#pendingResize = { connection, size }
    if (this.#resizeDrain === null) {
      const drain = this.#drainResizes().finally(() => {
        if (this.#resizeDrain === drain) this.#resizeDrain = null
      })
      this.#resizeDrain = drain
    }
    return this.#resizeDrain
  }

  async #drainResizes(): Promise<void> {
    while (this.#pendingResize !== null) {
      const { connection, size } = this.#pendingResize
      this.#pendingResize = null
      if (!this.#isCurrent(connection) || !connection.ready) continue
      if (connection.attachedGrid !== null && sameGridSize(connection.attachedGrid, size)) continue

      const resizeOperation = this.#logger.operation({
        category: 'rpc',
        event: 'rpc.resize',
        message: 'Resizing the attached Neovim UI',
        parentOperationId: connection.connectOperation.id,
        details: {
          generation: connection.generation,
          previousGrid: connection.attachedGrid,
          requestedGrid: size
        }
      })
      try {
        await connection.session.resize(size.columns, size.rows)
        if (this.#isCurrent(connection)) {
          connection.attachedGrid = size
          resizeOperation.success({
            message: 'Resized the attached Neovim UI',
            details: { generation: connection.generation, grid: size }
          })
        } else {
          resizeOperation.cancellation({
            message: 'Resize result arrived after the connection changed',
            details: { generation: connection.generation, grid: size }
          })
        }
      } catch (reason) {
        if (this.#isCurrent(connection)) {
          resizeOperation.failure(diagnosticReason(reason), {
            message: 'Failed to resize the Neovim UI',
            details: { generation: connection.generation, grid: size }
          })
          this.#pendingResize = null
          await this.#failConnection(connection, reason, 'Resize failed')
        } else {
          resizeOperation.cancellation({
            message: 'Resize failed after the connection changed',
            details: { generation: connection.generation, grid: size, reason }
          })
        }
      }
    }
  }

  #receiveRedraw(connection: ActiveConnection, batch: RedrawBatch): void {
    if (!this.#isCurrent(connection)) return
    Systrace.beginEvent('Codey/redraw')
    try {
      const diagnosticsEnabled = performanceDiagnosticsEnabled()
      const hasPendingSamples = connection.pendingInputSamples.length > 0
      const redrawStartedAt = diagnosticsEnabled || hasPendingSamples ? performanceNow() : 0
      const performanceTags: PerformanceTags | undefined = diagnosticsEnabled
        ? {
            source: 'redraw',
            connectionGeneration: connection.generation,
            eventCount: batch.length,
            resizeInFlight: this.#resizeInFlight()
          }
        : undefined
      const reduction = performanceTags === undefined
        ? applyRedrawBatch(connection.editorState, batch)
        : withPerformanceTags(performanceTags, () =>
            applyRedrawBatch(connection.editorState, batch)
          )
      connection.editorState = reduction.state
      if (reduction.didFlush) {
        this.#assignPendingSamples(
          connection,
          connection.editorState.flushCount,
          redrawStartedAt
        )
        connection.pendingSnapshot = toSnapshot(connection.editorState)
        if (connection.publicationFrame === null) {
          connection.publicationFrame = this.#frameScheduler.request(() => {
            this.#publishPendingSnapshot(connection)
          })
        }
      }
      if (performanceTags !== undefined) {
        recordPerformance('redraw_processing', {
          startedAtMs: redrawStartedAt,
          tags: {
            ...performanceTags,
            flushCount: connection.editorState.flushCount,
            didFlush: reduction.didFlush
          }
        })
      }
    } finally {
      Systrace.endEvent()
    }
  }

  #publishPendingSnapshot(connection: ActiveConnection): void {
    const snapshot = connection.pendingSnapshot
    const performanceSamples = connection.pendingPublicationSamples
    connection.pendingSnapshot = null
    connection.pendingPublicationSamples = []
    connection.publicationFrame = null
    if (snapshot === null || !this.#isCurrent(connection)) {
      this.#recordDiscardedSamples('input_sample_unpublished', performanceSamples)
      return
    }

    const diagnosticsEnabled = performanceDiagnosticsEnabled()
    const publicationStartedAt = diagnosticsEnabled || performanceSamples.length > 0
      ? performanceNow()
      : 0
    if (diagnosticsEnabled) {
      for (const sample of performanceSamples) {
        recordPerformance('input_to_snapshot', {
          startedAtMs: sample.inputStartedAtMs,
          durationMs: elapsedMilliseconds(sample.inputStartedAtMs, publicationStartedAt),
          tags: sample
        })
      }
    }
    this.#replaceState({
      snapshot,
      performanceSamples: performanceSamples.length === 0
        ? EMPTY_PERFORMANCE_SAMPLES
        : Object.freeze(performanceSamples)
    })
    if (diagnosticsEnabled) {
      recordPerformance('snapshot_publication', {
        startedAtMs: publicationStartedAt,
        tags: {
          source: 'redraw',
          connectionGeneration: connection.generation,
          flushCount: snapshot.flushCount,
          resizeInFlight: this.#resizeInFlight()
        }
      })
    }
  }

  #receiveClose(connection: ActiveConnection, error?: Error): void {
    if (!this.#isCurrent(connection)) return
    const connectionFailure = connectionFailureOf(error, 'Neovim connection closed')
    this.#logger.error({
      category: connection.target.kind === 'local' ? 'nvim' : 'transport',
      event: connection.target.kind === 'local'
        ? 'nvim.process.unexpected_exit'
        : 'transport.unexpected_close',
      message: error?.message ?? 'Neovim connection closed unexpectedly',
      operationId: connection.connectOperation.id,
      details: {
        generation: connection.generation,
        target: connection.target,
        failure: connectionFailure,
        error: diagnosticReason(error)
      }
    })
    void this.#closeConnection(connection).catch(() => undefined)
    this.#replaceState({
      phase: 'error',
      message: error?.message
        ? `Neovim connection closed: ${error.message}`
        : 'Neovim connection closed',
      connectionFailure,
      snapshot: null,
      performanceSamples: EMPTY_PERFORMANCE_SAMPLES
    })
  }

  async #failConnection(
    connection: ActiveConnection,
    reason: unknown,
    fallback: string
  ): Promise<void> {
    await this.#closeConnection(connection).catch(() => undefined)
    if (!this.#disposed) this.#setError(reason, fallback)
  }

  async #closeActive(reportDisconnected: boolean): Promise<void> {
    let failed = false
    let failure: unknown
    try {
      const connection = this.#active
      if (connection !== null) {
        await this.#closeConnection(connection)
      } else {
        await this.#closeInFlight
      }
    } catch (reason) {
      failed = true
      failure = reason
    } finally {
      if (reportDisconnected && !this.#disposed) {
        this.#replaceState({
          phase: 'disconnected',
          message: 'Disconnected',
          connectionFailure: null,
          snapshot: null,
          performanceSamples: EMPTY_PERFORMANCE_SAMPLES
        })
      }
    }
    if (failed) throw failure
  }

  async #closeConnection(connection: ActiveConnection): Promise<void> {
    if (connection.closing) {
      await connection.closePromise
      return
    }
    connection.closing = true
    connection.ready = false
    this.#cancelPendingSnapshot(connection)
    this.#recordDiscardedSamples('input_sample_unmatched', connection.pendingInputSamples)
    connection.pendingInputSamples = []
    if (this.#active === connection) this.#active = null
    if (this.#pendingResize?.connection === connection) this.#pendingResize = null
    this.#detach(connection)
    const closePromise = Promise.resolve()
      .then(() => connection.session.close())
      .catch((reason: unknown) => {
        this.#logger.warn({
          category: 'connection',
          event: 'connection.cleanup_failed',
          message: 'Connection cleanup failed while closing the Neovim session',
          operationId: connection.connectOperation.id,
          details: { generation: connection.generation, target: connection.target, reason }
        })
        throw reason
      })
    connection.closePromise = closePromise
    this.#closeInFlight = closePromise
    try {
      await closePromise
    } finally {
      if (this.#closeInFlight === closePromise) this.#closeInFlight = null
    }
  }

  #detach(connection: ActiveConnection): void {
    const observers = [
      ['redraw', connection.removeRedrawListener],
      ['transport-close', connection.removeCloseListener],
      ['diagnostics', connection.removeDiagnosticListeners]
    ] as const
    for (const [observer, remove] of observers) {
      this.#releaseObserver(connection, observer, remove)
    }
    connection.removeRedrawListener = () => undefined
    connection.removeCloseListener = () => undefined
    connection.removeDiagnosticListeners = () => undefined
  }

  #releaseObserver(
    connection: ActiveConnection,
    observer: 'redraw' | 'transport-close' | 'diagnostics',
    remove: () => void
  ): void {
    try {
      remove()
    } catch (reason) {
      this.#logger.warn({
        category: 'connection',
        event: 'connection.observer_detach_failed',
        message: `Failed to release the ${observer} observer`,
        operationId: connection.connectOperation.id,
        details: { generation: connection.generation, observer, reason }
      })
    }
  }

  #cancelPendingSnapshot(connection: ActiveConnection): void {
    if (connection.publicationFrame !== null) {
      this.#frameScheduler.cancel(connection.publicationFrame)
      connection.publicationFrame = null
    }
    connection.pendingSnapshot = null
    this.#recordDiscardedSamples(
      'input_sample_unpublished',
      connection.pendingPublicationSamples
    )
    connection.pendingPublicationSamples = []
  }

  #enqueuePerformanceSample(
    connection: ActiveConnection,
    sample: PendingPerformanceSample
  ): void {
    if (
      connection.pendingInputSamples.length + connection.pendingPublicationSamples.length >=
      MAX_PENDING_PERFORMANCE_SAMPLES
    ) {
      const dropped = connection.pendingPublicationSamples.shift() ??
        connection.pendingInputSamples.shift()
      if (dropped !== undefined) {
        this.#recordDiscardedSamples('input_sample_dropped', [dropped])
      }
    }
    connection.pendingInputSamples.push(sample)
  }

  #assignPendingSamples(
    connection: ActiveConnection,
    flushCount: number,
    redrawReceivedAtMs: number
  ): void {
    const samples = connection.pendingInputSamples
    connection.pendingInputSamples = []
    for (const sample of samples) {
      const published = Object.freeze({ ...sample, flushCount })
      connection.pendingPublicationSamples.push(published)
      if (performanceDiagnosticsEnabled()) {
        recordPerformance('input_to_redraw', {
          startedAtMs: sample.inputStartedAtMs,
          durationMs: elapsedMilliseconds(sample.inputStartedAtMs, redrawReceivedAtMs),
          tags: published
        })
      }
    }
  }

  #recordDiscardedSamples(
    stage: 'input_sample_dropped' | 'input_sample_unmatched' | 'input_sample_unpublished',
    samples: readonly PendingPerformanceSample[]
  ): void {
    if (samples.length === 0 || !performanceDiagnosticsEnabled()) return
    const discardedAtMs = performanceNow()
    for (const sample of samples) {
      recordPerformance(stage, {
        startedAtMs: sample.inputStartedAtMs,
        durationMs: elapsedMilliseconds(sample.inputStartedAtMs, discardedAtMs),
        tags: sample
      })
    }
  }

  #resizeInFlight(): boolean {
    return this.#pendingResize !== null || this.#resizeDrain !== null
  }

  #isCurrent(connection: ActiveConnection): boolean {
    return (
      this.#active === connection &&
      connection.generation === this.#latestConnectRequest &&
      !connection.closing &&
      !this.#disposed
    )
  }

  #setError(reason: unknown, fallback: string): void {
    const detail = reason instanceof Error && reason.message ? reason.message : fallback
    const connectionFailure = connectionFailureOf(reason, fallback)
    this.#replaceState({
      phase: 'error',
      message: detail,
      connectionFailure,
      snapshot: null,
      performanceSamples: EMPTY_PERFORMANCE_SAMPLES
    })
  }

  #replaceState(patch: Partial<ClientState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const listener of [...this.#listeners]) listener()
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error('Tablet client controller is disposed')
  }
}

function normalizeConnectionTarget(input: ConnectionTargetInput): ConnectionTarget {
  return 'kind' in input
    ? validateConnectionTarget(input)
    : createRemoteConnectionTarget(input.host, input.port)
}

function remoteTargetAddress(target: Extract<ConnectionTarget, { readonly kind: 'remote' }>): string {
  const host = target.host.includes(':') ? `[${target.host}]` : target.host
  return `${host}:${target.port}`
}

function inputSampleFromTags(tags: PerformanceTags): PendingPerformanceSample | null {
  if (
    tags.sampleId === undefined ||
    !Number.isSafeInteger(tags.sampleId) ||
    tags.sampleId < 1 ||
    tags.inputStartedAtMs === undefined ||
    !Number.isFinite(tags.inputStartedAtMs) ||
    tags.inputStartedAtMs < 0
  ) {
    return null
  }
  return Object.freeze({ ...tags }) as PendingPerformanceSample
}

function elapsedMilliseconds(startedAtMs: number, endedAtMs: number): number {
  return Math.max(0, endedAtMs - startedAtMs)
}

function connectionFailureOf(reason: unknown, fallback: string): ConnectionFailure {
  const error = reason instanceof Error ? reason : undefined
  const candidate = error as (Error & { readonly nativeCode?: unknown; readonly code?: unknown }) | undefined
  const namedCode = error?.name && error.name !== 'Error' ? error.name : undefined
  const nativeCode = typeof candidate?.nativeCode === 'string'
    ? candidate.nativeCode
    : typeof candidate?.code === 'string'
      ? candidate.code
      : namedCode?.startsWith('E_TCP_') || namedCode?.startsWith('ECONN')
        ? namedCode
        : undefined
  return {
    code: nativeCode ?? (error === undefined ? 'E_CONNECTION_CLOSED' : 'E_CONNECTION'),
    message: error?.message || fallback,
    ...(nativeCode === undefined ? {} : { nativeCode }),
    ...(error?.message ? { nativeMessage: error.message } : {})
  }
}

function diagnosticReason(reason: unknown): unknown {
  const origin = diagnosticOriginOf(reason)
  if (origin === undefined || !(reason instanceof Error)) return reason
  return {
    alreadyLoggedAt: origin,
    name: reason.name,
    message: reason.message
  }
}
