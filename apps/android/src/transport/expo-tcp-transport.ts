import type { DuplexTransport } from '@codey/transport'

import {
  getNativeTcp,
  type NativeSubscription,
  type NativeTcpCloseEvent,
  type NativeTcpDataEvent,
  type NativeTcpModule
} from '../native/tcp'

export interface ExpoTcpTransportOptions {
  readonly host: string
  readonly port: number
  readonly connectTimeoutMs?: number
}

type TransportState = 'idle' | 'connecting' | 'connected' | 'closing' | 'closed'

type EarlyEvent =
  | { readonly kind: 'data'; readonly event: NativeTcpDataEvent }
  | { readonly kind: 'close'; readonly event: NativeTcpCloseEvent }

export class ExpoTcpTransport implements DuplexTransport {
  readonly #module: NativeTcpModule
  readonly #options: Required<ExpoTcpTransportOptions>
  readonly #dataListeners = new Set<(chunk: Uint8Array) => void>()
  readonly #closeListeners = new Set<(error?: Error) => void>()

  #state: TransportState = 'idle'
  #connectionId: number | undefined
  #connectPromise: Promise<void> | undefined
  #closePromise: Promise<void> | undefined
  #writeTail: Promise<void> = Promise.resolve()
  #subscriptions: NativeSubscription[] = []
  #earlyEvents: EarlyEvent[] = []
  #didNotifyClose = false
  #explicitClose = false

  public constructor(options: ExpoTcpTransportOptions, module?: NativeTcpModule) {
    const host = options.host.trim()
    if (host.length === 0) throw new TypeError('TCP host must not be empty')
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
      throw new RangeError('TCP port must be an integer between 1 and 65535')
    }
    const connectTimeoutMs = options.connectTimeoutMs ?? 8_000
    if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 0) {
      throw new RangeError('TCP connection timeout must be a non-negative number')
    }
    this.#module = module ?? getNativeTcp()
    this.#options = { host, port: options.port, connectTimeoutMs }
  }

  public connect(): Promise<void> {
    if (this.#state === 'connected') return Promise.resolve()
    if (this.#state === 'connecting') return this.#connectPromise!
    if (this.#state === 'closing' || this.#state === 'closed') {
      return Promise.reject(new Error('TCP transport is closed'))
    }

    this.#state = 'connecting'
    this.#subscribe()
    this.#connectPromise = this.#module
      .open(this.#options.host, this.#options.port, this.#options.connectTimeoutMs)
      .then(async (connectionId) => {
        if (!Number.isSafeInteger(connectionId) || connectionId < 1) {
          throw new Error('Native TCP module returned an invalid connection ID')
        }
        this.#connectionId = connectionId
        if (this.#state !== 'connecting') {
          throw new Error('TCP transport was closed while connecting')
        }
        this.#state = 'connected'
        this.#drainEarlyEvents()
        if (this.#state !== 'connected') {
          throw new Error('TCP connection closed while it was being established')
        }
      })
      .catch((reason: unknown) => {
        const error = toError(reason, 'TCP connection failed')
        this.#terminate(this.#explicitClose ? undefined : error)
        throw error
      })
    return this.#connectPromise
  }

  public write(data: Uint8Array): Promise<void> {
    if (this.#state !== 'connected' || this.#connectionId === undefined) {
      return Promise.reject(new Error('TCP transport is not connected'))
    }

    const connectionId = this.#connectionId
    const bytes = data.slice()
    const operation = this.#writeTail.then(async () => {
      if (this.#state !== 'connected' || this.#connectionId !== connectionId) {
        throw new Error('TCP transport is not connected')
      }
      await this.#module.write(connectionId, bytes)
    })
    this.#writeTail = operation.catch((reason: unknown) => {
      const error = toError(reason, 'TCP write failed')
      this.#terminate(this.#explicitClose ? undefined : error)
      if (!this.#explicitClose) void this.#module.close(connectionId).catch(() => undefined)
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
    if (this.#state === 'closed') return Promise.resolve()
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
      const connectionId = this.#connectionId
      if (connectionId !== undefined) {
        // Close the socket before waiting on any write: the socket is what
        // interrupts a native write blocked by a stalled peer. The write tail
        // deliberately remains detached and already owns its rejection.
        await this.#module.close(connectionId).catch(() => undefined)
      }
      this.#state = 'closed'
      this.#unsubscribe()
      this.#notifyClose()
    })()
    return this.#closePromise
  }

  #subscribe(): void {
    this.#subscriptions = [
      this.#module.addListener('data', (event) => this.#receiveData(event)),
      this.#module.addListener('close', (event) => this.#receiveClose(event))
    ]
  }

  #receiveData(event: NativeTcpDataEvent): void {
    if (this.#connectionId === undefined) {
      if (this.#state === 'connecting') this.#earlyEvents.push({ kind: 'data', event })
      return
    }
    if (event.connectionId !== this.#connectionId || this.#state !== 'connected') return
    const bytes = event.bytes instanceof Uint8Array ? event.bytes : Uint8Array.from(event.bytes)
    if (bytes.byteLength === 0) return
    for (const listener of [...this.#dataListeners]) listener(bytes)
  }

  #receiveClose(event: NativeTcpCloseEvent): void {
    if (this.#connectionId === undefined) {
      if (this.#state === 'connecting') this.#earlyEvents.push({ kind: 'close', event })
      return
    }
    if (event.connectionId !== this.#connectionId) return
    const error = this.#state === 'closing' ? undefined : event.message ? nativeCloseError(event) : undefined
    this.#terminate(error)
  }

  #drainEarlyEvents(): void {
    const earlyEvents = this.#earlyEvents
    this.#earlyEvents = []
    for (const item of earlyEvents) {
      if (item.kind === 'data') this.#receiveData(item.event)
      else this.#receiveClose(item.event)
    }
  }

  #terminate(error?: Error): void {
    if (this.#state === 'closed') return
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

function nativeCloseError(event: NativeTcpCloseEvent): Error {
  const error = new Error(event.message)
  error.name = event.code ?? 'NativeTcpError'
  return error
}

function toError(reason: unknown, fallback: string): Error {
  if (reason instanceof Error) return reason
  return new Error(typeof reason === 'string' && reason.length > 0 ? reason : fallback)
}
