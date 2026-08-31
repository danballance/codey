import type { DuplexTransport } from '@codey/transport'

import {
  getNativeNvim,
  type NativeNvimDataEvent,
  type NativeNvimExitEvent,
  type NativeNvimModule,
  type NativeSubscription
} from '../native/nvim'

export interface ExpoNvimProcessTransportOptions {
  readonly workspacePath: string
}

type TransportState = 'idle' | 'starting' | 'connected' | 'closing' | 'closed'

type EarlyEvent =
  | { readonly kind: 'data'; readonly event: NativeNvimDataEvent }
  | { readonly kind: 'exit'; readonly event: NativeNvimExitEvent }

interface NativeCodedError extends Error {
  code?: string
  nativeCode?: string
}

interface NvimExitError extends NativeCodedError {
  exitCode: number
  stderrTail?: string
}

export class ExpoNvimProcessTransport implements DuplexTransport {
  readonly #module: NativeNvimModule
  readonly #workspacePath: string
  readonly #dataListeners = new Set<(chunk: Uint8Array) => void>()
  readonly #closeListeners = new Set<(error?: Error) => void>()

  #state: TransportState = 'idle'
  #sessionId: number | undefined
  #connectPromise: Promise<void> | undefined
  #closePromise: Promise<void> | undefined
  #stopPromise: Promise<void> | undefined
  #writeTail: Promise<void> = Promise.resolve()
  #subscriptions: NativeSubscription[] = []
  #earlyEvents: EarlyEvent[] = []
  #terminalError: Error | undefined
  #didNotifyClose = false
  #explicitClose = false

  public constructor(
    options: ExpoNvimProcessTransportOptions,
    module?: NativeNvimModule
  ) {
    const workspacePath = options.workspacePath.trim()
    if (workspacePath.length === 0) {
      throw new TypeError('NeoVim workspace path must not be empty')
    }
    this.#module = module ?? getNativeNvim()
    this.#workspacePath = workspacePath
  }

  public connect(): Promise<void> {
    if (this.#state === 'connected') return Promise.resolve()
    if (this.#state === 'starting') return this.#connectPromise!
    if (this.#state === 'closing' || this.#state === 'closed') {
      return Promise.reject(codedError('NeoVim transport is closed', 'E_NVIM_CLOSED'))
    }

    this.#state = 'starting'
    this.#subscribe()
    this.#connectPromise = this.#module
      .start(this.#workspacePath)
      .then((sessionId) => {
        if (!Number.isSafeInteger(sessionId) || sessionId < 1) {
          throw codedError(
            'Native NeoVim module returned an invalid session ID',
            'E_NVIM_START'
          )
        }
        this.#sessionId = sessionId
        if (this.#state !== 'starting') {
          throw codedError(
            'NeoVim transport was closed while starting',
            'E_NVIM_CLOSED'
          )
        }
        this.#state = 'connected'
        this.#drainEarlyEvents()
        if (this.#state !== 'connected') {
          throw this.#terminalError ?? codedError(
            'NeoVim process exited while it was starting',
            'E_NVIM_EXIT'
          )
        }
      })
      .catch((reason: unknown) => {
        const error = withNativeCode(toError(reason, 'NeoVim process failed to start'), 'E_NVIM_START')
        this.#terminate(this.#explicitClose ? undefined : error)
        throw error
      })
    return this.#connectPromise
  }

  public write(data: Uint8Array): Promise<void> {
    if (this.#state !== 'connected' || this.#sessionId === undefined) {
      return Promise.reject(codedError(
        'NeoVim transport is not connected',
        'E_NVIM_NOT_CONNECTED'
      ))
    }

    const sessionId = this.#sessionId
    const bytes = data.slice()
    const operation = this.#writeTail.then(async () => {
      if (this.#state !== 'connected' || this.#sessionId !== sessionId) {
        throw codedError('NeoVim transport is not connected', 'E_NVIM_NOT_CONNECTED')
      }
      await this.#module.write(sessionId, bytes)
    })
    this.#writeTail = operation.catch((reason: unknown) => {
      const error = withNativeCode(toError(reason, 'NeoVim write failed'), 'E_NVIM_WRITE')
      this.#terminate(this.#explicitClose ? undefined : error)
      if (!this.#explicitClose) void this.#requestStop(sessionId)
    })
    return operation
  }

  public onData(listener: (chunk: Uint8Array) => void): () => void {
    this.#dataListeners.add(listener)
    return () => this.#dataListeners.delete(listener)
  }

  public onClose(listener: (error?: Error) => void): () => void {
    this.#closeListeners.add(listener)
    return () => this.#closeListeners.delete(listener)
  }

  public close(): Promise<void> {
    if (this.#state === 'closed') {
      return this.#sessionId === undefined
        ? Promise.resolve()
        : this.#requestStop(this.#sessionId)
    }
    if (this.#state === 'closing') return this.#closePromise!
    if (this.#state === 'idle') {
      this.#explicitClose = true
      this.#state = 'closed'
      this.#notifyClose()
      return Promise.resolve()
    }

    this.#explicitClose = true
    this.#state = 'closing'
    this.#closePromise = (async () => {
      await this.#connectPromise?.catch(() => undefined)
      const sessionId = this.#sessionId
      if (sessionId !== undefined) await this.#requestStop(sessionId)
      this.#state = 'closed'
      this.#unsubscribe()
      this.#notifyClose()
    })()
    return this.#closePromise
  }

  #subscribe(): void {
    this.#subscriptions = [
      this.#module.addListener('data', (event) => this.#receiveData(event)),
      this.#module.addListener('exit', (event) => this.#receiveExit(event))
    ]
  }

  #receiveData(event: NativeNvimDataEvent): void {
    if (this.#sessionId === undefined) {
      if (this.#state === 'starting') this.#earlyEvents.push({ kind: 'data', event })
      return
    }
    if (event.sessionId !== this.#sessionId || this.#state !== 'connected') return
    const bytes = event.bytes instanceof Uint8Array ? event.bytes : Uint8Array.from(event.bytes)
    if (bytes.byteLength === 0) return
    for (const listener of [...this.#dataListeners]) listener(bytes)
  }

  #receiveExit(event: NativeNvimExitEvent): void {
    if (this.#sessionId === undefined) {
      if (this.#state === 'starting') this.#earlyEvents.push({ kind: 'exit', event })
      return
    }
    if (event.sessionId !== this.#sessionId) return
    const error = this.#state === 'closing' || this.#explicitClose
      ? undefined
      : nativeExitError(event)
    this.#terminate(error)
  }

  #drainEarlyEvents(): void {
    const earlyEvents = this.#earlyEvents
    this.#earlyEvents = []
    for (const item of earlyEvents) {
      if (item.kind === 'data') this.#receiveData(item.event)
      else this.#receiveExit(item.event)
    }
  }

  #requestStop(sessionId: number): Promise<void> {
    if (this.#stopPromise === undefined) {
      this.#stopPromise = this.#module.stop(sessionId).catch(() => undefined)
    }
    return this.#stopPromise
  }

  #terminate(error?: Error): void {
    if (this.#state === 'closed') return
    this.#terminalError = error
    this.#state = 'closed'
    this.#unsubscribe()
    this.#notifyClose(error)
  }

  #unsubscribe(): void {
    for (const subscription of this.#subscriptions) subscription.remove()
    this.#subscriptions = []
    this.#earlyEvents = []
  }

  #notifyClose(error?: Error): void {
    if (this.#didNotifyClose) return
    this.#didNotifyClose = true
    for (const listener of [...this.#closeListeners]) listener(error)
  }
}

function nativeExitError(event: NativeNvimExitEvent): NvimExitError {
  const stderrTail = event.stderrTail?.trim()
  const summary = event.message ?? `NeoVim process exited unexpectedly with code ${event.exitCode}`
  const error = codedError(
    stderrTail === undefined || stderrTail.length === 0
      ? summary
      : `${summary}\n${stderrTail}`,
    event.code ?? 'E_NVIM_EXIT'
  ) as NvimExitError
  error.exitCode = event.exitCode
  if (stderrTail !== undefined && stderrTail.length > 0) error.stderrTail = stderrTail
  return error
}

function codedError(message: string, code: string): NativeCodedError {
  const error = new Error(message) as NativeCodedError
  error.name = code
  error.code = code
  error.nativeCode = code
  return error
}

function withNativeCode(error: Error, fallbackCode: string): NativeCodedError {
  const candidate = error as NativeCodedError
  const code = typeof candidate.nativeCode === 'string'
    ? candidate.nativeCode
    : typeof candidate.code === 'string'
      ? candidate.code
      : fallbackCode
  candidate.code = code
  candidate.nativeCode = code
  if (candidate.name === 'Error') candidate.name = code
  return candidate
}

function toError(reason: unknown, fallback: string): Error {
  if (reason instanceof Error) return reason
  if (typeof reason === 'object' && reason !== null) {
    const record = reason as { readonly message?: unknown; readonly code?: unknown; readonly nativeCode?: unknown }
    const message = typeof record.message === 'string' && record.message.length > 0
      ? record.message
      : fallback
    const error = new Error(message) as NativeCodedError
    const code = typeof record.nativeCode === 'string'
      ? record.nativeCode
      : typeof record.code === 'string'
        ? record.code
        : undefined
    if (code !== undefined) {
      error.code = code
      error.nativeCode = code
    }
    return error
  }
  return new Error(typeof reason === 'string' && reason.length > 0 ? reason : fallback)
}
