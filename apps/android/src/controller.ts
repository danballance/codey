import {
  applyRedrawBatch,
  createEditorState,
  toSnapshot,
  type EditorSnapshot,
  type EditorState
} from '@codey/editor-core'
import type { RedrawBatch } from '@codey/nvim-session'
import type { DuplexTransport } from '@codey/transport'

import type { Endpoint } from './endpoint'
import { sameGridSize, type GridSize } from './grid'

export type ConnectionPhase = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface ClientState {
  readonly phase: ConnectionPhase
  readonly message: string
  readonly snapshot: EditorSnapshot | null
  readonly gridSize: GridSize
}

export interface MobileSession {
  connect(): Promise<void>
  attach(width: number, height: number): Promise<void>
  input(keys: string): Promise<void>
  resize(width: number, height: number): Promise<void>
  onRedraw(listener: (batch: RedrawBatch) => void): () => void
  close(): Promise<void>
}

export interface ConnectionResources {
  readonly transport: DuplexTransport
  readonly session: MobileSession
}

export type ConnectionFactory = (endpoint: Endpoint) => ConnectionResources

interface ActiveConnection extends ConnectionResources {
  readonly generation: number
  editorState: EditorState
  ready: boolean
  closing: boolean
  closePromise: Promise<void> | null
  attachedGrid: GridSize | null
  removeRedrawListener: () => void
  removeCloseListener: () => void
}

const INITIAL_GRID: GridSize = Object.freeze({ columns: 80, rows: 24 })

export class TabletClientController {
  readonly #listeners = new Set<() => void>()
  readonly #factory: ConnectionFactory

  #state: ClientState = {
    phase: 'disconnected',
    message: 'Not connected',
    snapshot: null,
    gridSize: INITIAL_GRID
  }
  #active: ActiveConnection | null = null
  #nextGeneration = 1
  #latestConnectRequest = 0
  #disposed = false
  #closeInFlight: Promise<void> | null = null
  #disposePromise: Promise<void> | null = null
  #pendingResize: { readonly connection: ActiveConnection; readonly size: GridSize } | null = null
  #resizeDrain: Promise<void> | null = null

  public constructor(factory: ConnectionFactory) {
    this.#factory = factory
  }

  public getState = (): ClientState => this.#state

  public subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  public async connect(endpoint: Endpoint): Promise<void> {
    this.#assertUsable()
    const generation = this.#nextGeneration++
    this.#latestConnectRequest = generation
    await this.#closeActive(false)
    if (this.#disposed || generation !== this.#latestConnectRequest) return

    let resources: ConnectionResources
    try {
      resources = this.#factory(endpoint)
    } catch (reason) {
      this.#setError(reason, 'Could not create the Android connection')
      return
    }

    const connection: ActiveConnection = {
      ...resources,
      generation,
      editorState: createEditorState(),
      ready: false,
      closing: false,
      closePromise: null,
      attachedGrid: null,
      removeRedrawListener: () => undefined,
      removeCloseListener: () => undefined
    }
    this.#active = connection
    this.#replaceState({
      phase: 'connecting',
      message: `Connecting to ${endpoint.host}:${endpoint.port}…`,
      snapshot: null
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
        message: `Connected to ${endpoint.host}:${endpoint.port}`
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

    try {
      await connection.session.input(keys)
    } catch (reason) {
      if (this.#isCurrent(connection)) {
        await this.#failConnection(connection, reason, 'Input failed')
      }
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
    const reduction = applyRedrawBatch(connection.editorState, batch)
    connection.editorState = reduction.state
    if (reduction.didFlush) {
      this.#replaceState({ snapshot: toSnapshot(connection.editorState) })
    }
  }

  #receiveClose(connection: ActiveConnection, error?: Error): void {
    if (!this.#isCurrent(connection)) return
    void this.#closeConnection(connection)
    this.#replaceState({
      phase: 'error',
      message: error?.message
        ? `Neovim connection closed: ${error.message}`
        : 'Neovim connection closed',
      snapshot: null
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
        snapshot: null
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
    this.#replaceState({ phase: 'error', message: detail, snapshot: null })
  }

  #replaceState(patch: Partial<ClientState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const listener of [...this.#listeners]) listener()
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error('Tablet client controller is disposed')
  }
}
