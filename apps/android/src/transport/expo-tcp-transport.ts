import type { DuplexTransport } from '@codey/transport'
import {
  currentPerformanceTags,
  performanceDiagnosticsEnabled,
  performanceNow,
  recordPerformance,
  type PerformanceTags
} from '@codey/perf'

import {
  diagnosticLogger,
  type DiagnosticLogger,
  type DiagnosticOperation
} from '../diagnostics/logger'
import {
  attachDiagnosticCause,
  diagnosticOriginOf,
  markDiagnosticOrigin
} from '../diagnostics/origin'
import {
  getNativeTcp,
  type NativeSubscription,
  type NativeTcpCloseEvent,
  type NativeTcpDataEvent,
  type NativeTcpModule,
  type NativeTcpWriteMeasurement
} from '../native/tcp'

export interface ExpoTcpTransportOptions {
  readonly host: string
  readonly port: number
  readonly connectTimeoutMs?: number
}

export interface TcpTransportDiagnosticContext {
  readonly generation?: number
  readonly operationId?: string
}

type TransportState = 'idle' | 'connecting' | 'connected' | 'closing' | 'closed'

type EarlyEvent =
  | { readonly kind: 'data'; readonly event: NativeTcpDataEvent }
  | { readonly kind: 'close'; readonly event: NativeTcpCloseEvent }

export class ExpoTcpTransport implements DuplexTransport {
  readonly #module: NativeTcpModule
  readonly #options: Required<ExpoTcpTransportOptions>
  readonly #logger: DiagnosticLogger
  readonly #diagnosticContext: TcpTransportDiagnosticContext
  readonly #dataListeners = new Set<(chunk: Uint8Array) => void>()
  readonly #closeListeners = new Set<(error?: Error) => void>()

  #state: TransportState = 'idle'
  #connectionId: number | undefined
  #connectPromise: Promise<void> | undefined
  #closePromise: Promise<void> | undefined
  #writeTail: Promise<void> = Promise.resolve()
  #subscriptions: NativeSubscription[] = []
  #earlyEvents: EarlyEvent[] = []
  #terminalError: Error | undefined
  #didNotifyClose = false
  #explicitClose = false
  #openOperation: DiagnosticOperation | undefined

  public constructor(
    options: ExpoTcpTransportOptions,
    module?: NativeTcpModule,
    logger: DiagnosticLogger = diagnosticLogger,
    diagnosticContext: TcpTransportDiagnosticContext = {}
  ) {
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
    this.#logger = logger
    this.#diagnosticContext = diagnosticContext
  }

  public connect(): Promise<void> {
    if (this.#state === 'connected') return Promise.resolve()
    if (this.#state === 'connecting') return this.#connectPromise!
    if (this.#state === 'closing' || this.#state === 'closed') {
      return Promise.reject(new Error('TCP transport is closed'))
    }

    this.#state = 'connecting'
    this.#openOperation = this.#logger.operation({
      category: 'transport',
      event: 'transport.tcp.open',
      message: 'Opening the remote TCP transport',
      parentOperationId: this.#diagnosticContext.operationId,
      details: { ...this.#diagnosticContext, ...this.#options }
    })
    let nativeOpen: Promise<number>
    try {
      this.#subscribe()
      nativeOpen = this.#module.open(
        this.#options.host,
        this.#options.port,
        this.#options.connectTimeoutMs
      )
    } catch (reason) {
      const error = toError(reason, 'TCP connection failed')
      const observedOrigin = diagnosticOriginOf(error)
      if (observedOrigin === undefined) markDiagnosticOrigin(error, 'transport.tcp.open')
      const cleanupFailures = this.#terminate(error)
      this.#openOperation.failure(
        observedOrigin === undefined ? error : originObservedError(observedOrigin), {
        message: 'Remote TCP transport failed to open',
        details: {
          ...this.#diagnosticContext,
          ...this.#options,
          cleanupFailures,
          ...(observedOrigin === undefined
            ? {}
            : originSummary(observedOrigin, error))
        }
      })
      this.#connectPromise = Promise.reject(error)
      return this.#connectPromise
    }
    this.#connectPromise = Promise.resolve(nativeOpen)
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
          throw this.#terminalError ?? new Error(
            'TCP connection closed while it was being established'
          )
        }
        this.#openOperation?.success({
          message: 'Remote TCP transport opened',
          details: { ...this.#diagnosticContext, ...this.#options, connectionId }
        })
      })
      .catch((reason: unknown) => {
        const error = toError(reason, 'TCP connection failed')
        if (this.#explicitClose) {
          const cleanupFailures = this.#terminate()
          this.#openOperation?.cancellation({
            message: 'Remote TCP transport was closed while opening',
            details: {
              ...this.#diagnosticContext,
              ...this.#options,
              reason: error,
              cleanupFailures
            }
          })
        } else {
          const observedOrigin = diagnosticOriginOf(error)
          if (observedOrigin === undefined) markDiagnosticOrigin(error, 'transport.tcp.open')
          const cleanupFailures = this.#terminate(error)
          this.#openOperation?.failure(
            observedOrigin === undefined ? error : originObservedError(observedOrigin), {
            message: 'Remote TCP transport failed to open',
            details: {
              ...this.#diagnosticContext,
              ...this.#options,
              cleanupFailures,
              ...(observedOrigin === undefined
                ? {}
                : originSummary(observedOrigin, error))
            }
          })
        }
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
    const diagnosticsEnabled = performanceDiagnosticsEnabled()
    const queuedAtMs = diagnosticsEnabled ? performanceNow() : 0
    const tags: PerformanceTags | undefined = diagnosticsEnabled
      ? {
          source: 'tcp',
          ...currentPerformanceTags(),
          byteLength: bytes.byteLength,
          connectionId
        }
      : undefined
    if (tags !== undefined) {
      recordPerformance('transport_write_queued', { durationMs: 0, tags })
    }
    const operation = this.#writeTail.then(async () => {
      if (this.#state !== 'connected' || this.#connectionId !== connectionId) {
        throw new Error('TCP transport is not connected')
      }
      if (tags !== undefined) {
        recordPerformance('transport_write_started', { startedAtMs: queuedAtMs, tags })
      }
      try {
        const measuredWrite = this.#module.writeMeasured
        if (tags === undefined || measuredWrite === undefined) {
          await this.#module.write(connectionId, bytes)
        } else {
          const nativeQueuedAtMs = performanceNow()
          const measurement = await measuredWrite.call(this.#module, connectionId, bytes)
          recordNativeWritePerformance(measurement, nativeQueuedAtMs, tags)
        }
      } finally {
        if (tags !== undefined) {
          recordPerformance('transport_write_completed', { startedAtMs: queuedAtMs, tags })
        }
      }
    })
    this.#writeTail = operation.catch((reason: unknown) => {
      const error = withNativeCode(toError(reason, 'TCP write failed'), 'E_TCP_WRITE')
      markDiagnosticOrigin(error, 'transport.tcp.write')
      this.#logger.error({
        category: 'transport',
        event: 'transport.tcp.write_failed',
        message: 'Failed to write to the remote TCP transport',
        operationId: this.#diagnosticContext.operationId,
        details: {
          ...this.#diagnosticContext,
          host: this.#options.host,
          port: this.#options.port,
          connectionId,
          bytes,
          error
        }
      })
      const cleanupFailures = this.#terminate(this.#explicitClose ? undefined : error)
      if (cleanupFailures.length > 0) {
        this.#logger.warn({
          category: 'transport',
          event: 'transport.tcp.write_cleanup_failed',
          message: 'TCP write failure cleanup did not complete cleanly',
          operationId: this.#diagnosticContext.operationId,
          details: { ...this.#diagnosticContext, connectionId, cleanupFailures }
        })
      }
      if (!this.#explicitClose) {
        void Promise.resolve().then(() => this.#module.close(connectionId)).catch(
          (closeReason: unknown) => {
          this.#logger.warn({
            category: 'transport',
            event: 'transport.tcp.failure_cleanup_failed',
            message: 'Could not close the native TCP socket after a write failure',
            operationId: this.#diagnosticContext.operationId,
            details: { ...this.#diagnosticContext, connectionId, closeReason }
          })
          }
        )
      }
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
    if (this.#state === 'closed') return this.#closePromise ?? Promise.resolve()
    if (this.#state === 'closing') return this.#closePromise!
    if (this.#state === 'idle') {
      this.#explicitClose = true
      this.#state = 'closed'
      this.#notifyClose()
      return Promise.resolve()
    }

    this.#explicitClose = true
    this.#state = 'closing'
    const closeOperation = this.#logger.operation({
      category: 'transport',
      event: 'transport.tcp.close',
      message: 'Closing the remote TCP transport',
      parentOperationId: this.#diagnosticContext.operationId,
      details: {
        ...this.#diagnosticContext,
        host: this.#options.host,
        port: this.#options.port,
        connectionId: this.#connectionId
      }
    })
    this.#closePromise = (async () => {
      await this.#connectPromise?.catch(() => undefined)
      const connectionId = this.#connectionId
      let nativeCloseFailure: unknown
      if (connectionId !== undefined) {
        // Close the socket before waiting on any write: the socket is what
        // interrupts a native write blocked by a stalled peer. The write tail
        // deliberately remains detached and already owns its rejection.
        try {
          await this.#module.close(connectionId)
        } catch (reason) {
          nativeCloseFailure = reason
        }
      }
      this.#state = 'closed'
      const cleanupFailures = this.#unsubscribe()
      cleanupFailures.push(...this.#notifyClose())
      if (nativeCloseFailure !== undefined || cleanupFailures.length > 0) {
        const failure = toError(
          nativeCloseFailure ?? cleanupFailures[0],
          'TCP transport closed with cleanup failures'
        )
        markDiagnosticOrigin(failure, 'transport.tcp.close')
        closeOperation.failure(failure, {
          event: 'transport.tcp.close.partial_failure',
          message: 'Remote TCP transport closed with native cleanup failures',
          details: {
            ...this.#diagnosticContext,
            connectionId,
            nativeCloseFailure,
            cleanupFailures,
            closed: true
          }
        })
        throw failure
      } else {
        closeOperation.success({ message: 'Closed the remote TCP transport' })
      }
    })()
    return this.#closePromise
  }

  #subscribe(): void {
    const subscriptions: NativeSubscription[] = []
    try {
      subscriptions.push(this.#module.addListener('data', (event) => this.#receiveData(event)))
      subscriptions.push(this.#module.addListener('close', (event) => this.#receiveClose(event)))
      this.#subscriptions = subscriptions
    } catch (reason) {
      this.#subscriptions = subscriptions
      const cleanupFailures = this.#unsubscribe()
      const error = toError(reason, 'Failed to subscribe to native TCP events')
      if (cleanupFailures.length > 0) {
        Object.assign(error, { subscriptionCleanupFailures: cleanupFailures })
      }
      throw error
    }
  }

  #receiveData(event: NativeTcpDataEvent): void {
    if (this.#connectionId === undefined) {
      if (this.#state === 'connecting') this.#earlyEvents.push({ kind: 'data', event })
      return
    }
    if (event.connectionId !== this.#connectionId || this.#state !== 'connected') return
    const bytes = event.bytes instanceof Uint8Array ? event.bytes : Uint8Array.from(event.bytes)
    if (bytes.byteLength === 0) return
    recordNativeReadPerformance(event, bytes.byteLength)
    for (const listener of [...this.#dataListeners]) listener(bytes)
  }

  #receiveClose(event: NativeTcpCloseEvent): void {
    if (this.#connectionId === undefined) {
      if (this.#state === 'connecting') this.#earlyEvents.push({ kind: 'close', event })
      return
    }
    if (event.connectionId !== this.#connectionId || this.#state === 'closed') return
    const error = this.#state === 'closing' || this.#explicitClose
      ? undefined
      : nativeCloseError(event)
    if (error !== undefined) {
      markDiagnosticOrigin(error, 'transport.tcp.close')
      this.#logger.error({
        category: 'transport',
        event: 'transport.tcp.unexpected_close',
        message: 'Remote TCP transport closed unexpectedly',
        operationId: this.#diagnosticContext.operationId,
        details: { ...this.#diagnosticContext, nativeEvent: event, error }
      })
    }
    const cleanupFailures = this.#terminate(error)
    if (cleanupFailures.length > 0) {
      this.#logger.warn({
        category: 'transport',
        event: 'transport.tcp.close_cleanup_failed',
        message: 'Unexpected TCP close cleanup did not complete cleanly',
        operationId: this.#diagnosticContext.operationId,
        details: { ...this.#diagnosticContext, nativeEvent: event, cleanupFailures }
      })
    }
  }

  #drainEarlyEvents(): void {
    const earlyEvents = this.#earlyEvents
    this.#earlyEvents = []
    for (const item of earlyEvents) {
      if (item.kind === 'data') this.#receiveData(item.event)
      else this.#receiveClose(item.event)
    }
  }

  #terminate(error?: Error): unknown[] {
    if (this.#state === 'closed') return []
    this.#terminalError = error
    this.#state = 'closed'
    const cleanupFailures = this.#unsubscribe()
    cleanupFailures.push(...this.#notifyClose(error))
    return cleanupFailures
  }

  #unsubscribe(): unknown[] {
    const failures: unknown[] = []
    for (const subscription of this.#subscriptions) {
      try {
        subscription.remove()
      } catch (reason) {
        failures.push(reason)
      }
    }
    this.#subscriptions = []
    this.#earlyEvents = []
    return failures
  }

  #notifyClose(error?: Error): unknown[] {
    if (this.#didNotifyClose) return []
    this.#didNotifyClose = true
    const failures: unknown[] = []
    for (const listener of [...this.#closeListeners]) {
      try {
        listener(error)
      } catch (reason) {
        failures.push(reason)
      }
    }
    return failures
  }
}

function nativeCloseError(event: NativeTcpCloseEvent): Error {
  const error = new Error(event.message ?? 'TCP connection closed unexpectedly')
  error.name = event.code ?? 'NativeTcpError'
  Object.assign(error, { nativeCode: event.code })
  return error
}

function withNativeCode(error: Error, code: string): Error {
  const candidate = error as Error & { nativeCode?: unknown }
  if (typeof candidate.nativeCode !== 'string') candidate.nativeCode = code
  if (error.name === 'Error') error.name = code
  return error
}

function toError(reason: unknown, fallback: string): Error {
  if (reason instanceof Error) return reason
  if (typeof reason === 'object' && reason !== null) {
    const message = (reason as { readonly message?: unknown }).message
    return attachDiagnosticCause(
      new Error(typeof message === 'string' && message.length > 0 ? message : fallback),
      reason
    )
  }
  return new Error(typeof reason === 'string' && reason.length > 0 ? reason : fallback)
}

function originObservedError(origin: string): Error {
  const error = new Error(`Operational failure was already recorded by ${origin}`)
  error.name = 'DiagnosticOriginObserved'
  return error
}

function originSummary(origin: string, error: Error) {
  return { observedOrigin: origin, errorName: error.name, errorMessage: error.message }
}

function recordNativeReadPerformance(event: NativeTcpDataEvent, byteLength: number): void {
  if (!performanceDiagnosticsEnabled()) return
  const deliveredAtMs = performanceNow()
  const nativeDurationMs = validDuration(event.nativeDurationMs)
  const deliveryDurationMs = event.receivedAtUptimeMs === undefined
    ? null
    : deliveredAtMs - event.receivedAtUptimeMs
  const clocksCompatible = deliveryDurationMs !== null &&
    Number.isFinite(deliveryDurationMs) &&
    deliveryDurationMs >= 0 &&
    deliveryDurationMs <= 60_000
  const tags: PerformanceTags = {
    source: 'tcp',
    byteLength,
    connectionId: event.connectionId
  }

  recordPerformance('native_socket_read', {
    startedAtMs: clocksCompatible && event.receivedAtUptimeMs !== undefined
      ? Math.max(0, event.receivedAtUptimeMs - nativeDurationMs)
      : deliveredAtMs,
    durationMs: nativeDurationMs,
    tags
  })
  recordPerformance('native_socket_read_delivery', {
    startedAtMs: clocksCompatible && event.receivedAtUptimeMs !== undefined
      ? event.receivedAtUptimeMs
      : deliveredAtMs,
    durationMs: clocksCompatible ? deliveryDurationMs ?? 0 : 0,
    tags
  })
}

function recordNativeWritePerformance(
  measurement: NativeTcpWriteMeasurement,
  nativeQueuedAtMs: number,
  tags: PerformanceTags
): void {
  const deliveredAtMs = performanceNow()
  const nativeEntryUptimeMs = compatibleUptimeStart(
    measurement.nativeEntryUptimeMs,
    deliveredAtMs
  ) && measurement.nativeEntryUptimeMs >= nativeQueuedAtMs
    ? measurement.nativeEntryUptimeMs
    : null
  const lockWaitStartedAtUptimeMs = compatibleUptimeStart(
    measurement.lockWaitStartedAtUptimeMs,
    deliveredAtMs
  )
    ? measurement.lockWaitStartedAtUptimeMs
    : deliveredAtMs
  const socketWriteStartedAtUptimeMs = compatibleUptimeStart(
    measurement.socketWriteStartedAtUptimeMs,
    deliveredAtMs
  )
    ? measurement.socketWriteStartedAtUptimeMs
    : deliveredAtMs

  recordPerformance('native_socket_write_queue', {
    startedAtMs: nativeQueuedAtMs,
    durationMs: nativeEntryUptimeMs === null
      ? 0
      : Math.min(60_000, nativeEntryUptimeMs - nativeQueuedAtMs),
    tags
  })
  recordPerformance('native_socket_write_lock_wait', {
    startedAtMs: lockWaitStartedAtUptimeMs,
    durationMs: validDuration(measurement.lockWaitDurationMs),
    tags
  })
  recordPerformance('native_socket_write', {
    startedAtMs: socketWriteStartedAtUptimeMs,
    durationMs: validDuration(measurement.socketWriteDurationMs),
    tags
  })
}

function compatibleUptimeStart(value: number, deliveredAtMs: number): boolean {
  const deliveryDurationMs = deliveredAtMs - value
  return Number.isFinite(value) &&
    value >= 0 &&
    Number.isFinite(deliveryDurationMs) &&
    deliveryDurationMs >= 0 &&
    deliveryDurationMs <= 60_000
}

function validDuration(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 60_000
    ? value
    : 0
}
