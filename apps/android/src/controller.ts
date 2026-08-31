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
  writeHostDocument(request: HostDocumentWrite): Promise<HostDocument>
  onRedraw(listener: (batch: RedrawBatch) => void): () => void
  close(): Promise<void>
}

export interface ConnectionResources {
  readonly transport: DuplexTransport
  readonly session: MobileSession
}

export type ConnectionFactory = (target: ConnectionTarget) => ConnectionResources

export type ConnectionTargetInput = ConnectionTarget | Endpoint

export interface FrameScheduler {
  request(callback: (timestampMs: number) => void): number
  cancel(handle: number): void
}

interface ActiveConnection extends ConnectionResources {
  readonly generation: number
  readonly target: ConnectionTarget
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
    frameScheduler: FrameScheduler = ANDROID_FRAME_SCHEDULER
  ) {
    this.#factory = factory
    this.#frameScheduler = frameScheduler
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
    this.#latestConnectRequest = generation
    await this.#closeActive(false)
    if (this.#disposed || generation !== this.#latestConnectRequest) return

    let resources: ConnectionResources
    try {
      resources = this.#factory(target)
    } catch (reason) {
      this.#setError(reason, 'Could not create the Android connection')
      return
    }

    const connection: ActiveConnection = {
      ...resources,
      generation,
      target,
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
      removeCloseListener: () => undefined
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

    connection.removeRedrawListener = connection.session.onRedraw((batch) => {
      this.#receiveRedraw(connection, batch)
    })
    connection.removeCloseListener = connection.transport.onClose((error) => {
      this.#receiveClose(connection, error)
    })

    try {
      await connection.session.connect()
      if (!this.#isCurrent(connection)) {
        await this.#closeConnection(connection)
        return
      }

      const attachGrid = this.#state.gridSize
      await connection.session.attach(attachGrid.columns, attachGrid.rows)
      if (!this.#isCurrent(connection)) {
        await this.#closeConnection(connection)
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

      const latestGrid = this.#state.gridSize
      if (!sameGridSize(attachGrid, latestGrid)) {
        await this.#scheduleResize(connection, latestGrid)
      }
    } catch (reason) {
      if (!this.#isCurrent(connection)) {
        await this.#closeConnection(connection)
        return
      }
      await this.#closeConnection(connection)
      if (!this.#disposed) this.#setError(reason, 'Connection failed')
    }
  }

  public async disconnect(): Promise<void> {
    if (this.#disposed) return
    this.#latestConnectRequest = this.#nextGeneration++
    await this.#closeActive(true)
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

  public writeHostDocument(endpoint: Endpoint, request: HostDocumentWrite): Promise<HostDocument> {
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
    this.#disposed = true
    this.#latestConnectRequest = this.#nextGeneration++
    this.#listeners.clear()
    this.#disposePromise = this.#closeActive(false)
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

      try {
        await connection.session.resize(size.columns, size.rows)
        if (this.#isCurrent(connection)) connection.attachedGrid = size
      } catch (reason) {
        if (this.#isCurrent(connection)) {
          this.#pendingResize = null
          await this.#failConnection(connection, reason, 'Resize failed')
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
    void this.#closeConnection(connection)
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
    await this.#closeConnection(connection)
    if (!this.#disposed) this.#setError(reason, fallback)
  }

  async #closeActive(reportDisconnected: boolean): Promise<void> {
    const connection = this.#active
    if (connection !== null) {
      await this.#closeConnection(connection)
    } else {
      await this.#closeInFlight
    }
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
      .catch(() => {
        // A remote close may have already torn the transport down.
      })
    connection.closePromise = closePromise
    this.#closeInFlight = closePromise
    await closePromise
    if (this.#closeInFlight === closePromise) this.#closeInFlight = null
  }

  #detach(connection: ActiveConnection): void {
    connection.removeRedrawListener()
    connection.removeCloseListener()
    connection.removeRedrawListener = () => undefined
    connection.removeCloseListener = () => undefined
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
