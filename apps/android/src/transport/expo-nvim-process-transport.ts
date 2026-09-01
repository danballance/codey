import type { DuplexTransport } from '@codey/transport'

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
  getNativeNvim,
  type NativeNvimDataEvent,
  type NativeNvimExitEvent,
  type NativeNvimModule,
  type NativeSubscription
} from '../native/nvim'

export interface ExpoNvimProcessTransportOptions {
  readonly workspacePath: string
  readonly configDirectory: string
}

export interface NvimTransportDiagnosticContext {
  readonly generation?: number
  readonly operationId?: string
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
  readonly #configDirectory: string
  readonly #logger: DiagnosticLogger
  readonly #diagnosticContext: NvimTransportDiagnosticContext
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
  #openOperation: DiagnosticOperation | undefined

  public constructor(
    options: ExpoNvimProcessTransportOptions,
    module?: NativeNvimModule,
    logger: DiagnosticLogger = diagnosticLogger,
    diagnosticContext: NvimTransportDiagnosticContext = {}
  ) {
    const workspacePath = options.workspacePath.trim()
    if (workspacePath.length === 0) {
      throw new TypeError('NeoVim workspace path must not be empty')
    }
    this.#module = module ?? getNativeNvim()
    this.#workspacePath = workspacePath
    const configDirectory = options.configDirectory.trim()
    if (configDirectory.length === 0) {
      throw new TypeError('NeoVim config directory must not be empty')
    }
    this.#configDirectory = configDirectory
    this.#logger = logger
    this.#diagnosticContext = diagnosticContext
  }

  public connect(): Promise<void> {
    if (this.#state === 'connected') return Promise.resolve()
    if (this.#state === 'starting') return this.#connectPromise!
    if (this.#state === 'closing' || this.#state === 'closed') {
      return Promise.reject(codedError('NeoVim transport is closed', 'E_NVIM_CLOSED'))
    }

    this.#state = 'starting'
    this.#openOperation = this.#logger.operation({
      category: 'transport',
      event: 'transport.local.open',
      message: 'Starting the local NeoVim process transport',
      parentOperationId: this.#diagnosticContext.operationId,
      details: {
        ...this.#diagnosticContext,
        workspacePath: this.#workspacePath,
        configDirectory: this.#configDirectory
      }
    })
    let nativeStart: Promise<number>
    try {
      this.#subscribe()
      nativeStart = this.#module.start(this.#workspacePath, this.#configDirectory)
    } catch (reason) {
      const error = withNativeCode(
        toError(reason, 'NeoVim process failed to start'),
        'E_NVIM_START'
      )
      const observedOrigin = diagnosticOriginOf(error)
      if (observedOrigin === undefined) markDiagnosticOrigin(error, 'transport.local.open')
      const cleanupFailures = this.#terminate(error)
      this.#openOperation.failure(
        observedOrigin === undefined ? error : originObservedError(observedOrigin), {
        message: 'Local NeoVim process transport failed to open',
        details: {
          ...this.#diagnosticContext,
          workspacePath: this.#workspacePath,
          configDirectory: this.#configDirectory,
          cleanupFailures,
          ...(observedOrigin === undefined
            ? {}
            : originSummary(observedOrigin, error))
        }
      })
      this.#connectPromise = Promise.reject(error)
      return this.#connectPromise
    }
    this.#connectPromise = Promise.resolve(nativeStart)
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
        this.#openOperation?.success({
          message: 'Local NeoVim process transport opened',
          details: {
            ...this.#diagnosticContext,
            workspacePath: this.#workspacePath,
            configDirectory: this.#configDirectory,
            sessionId
          }
        })
      })
      .catch((reason: unknown) => {
        const error = withNativeCode(toError(reason, 'NeoVim process failed to start'), 'E_NVIM_START')
        if (this.#explicitClose) {
          const cleanupFailures = this.#terminate()
          this.#openOperation?.cancellation({
            message: 'Local NeoVim process transport was closed while opening',
            details: {
              ...this.#diagnosticContext,
              workspacePath: this.#workspacePath,
              configDirectory: this.#configDirectory,
              reason: error,
              cleanupFailures
            }
          })
        } else {
          const observedOrigin = diagnosticOriginOf(error)
          if (observedOrigin === undefined) markDiagnosticOrigin(error, 'transport.local.open')
          const cleanupFailures = this.#terminate(error)
          this.#openOperation?.failure(
            observedOrigin === undefined ? error : originObservedError(observedOrigin), {
            message: 'Local NeoVim process transport failed to open',
            details: {
              ...this.#diagnosticContext,
              workspacePath: this.#workspacePath,
              configDirectory: this.#configDirectory,
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
      markDiagnosticOrigin(error, 'transport.local.write')
      this.#logger.error({
        category: 'transport',
        event: 'transport.local.write_failed',
        message: 'Failed to write to the local NeoVim process',
        operationId: this.#diagnosticContext.operationId,
        details: {
          ...this.#diagnosticContext,
          workspacePath: this.#workspacePath,
          configDirectory: this.#configDirectory,
          sessionId,
          bytes,
          error
        }
      })
      const cleanupFailures = this.#terminate(this.#explicitClose ? undefined : error)
      if (cleanupFailures.length > 0) {
        this.#logger.warn({
          category: 'transport',
          event: 'transport.local.write_cleanup_failed',
          message: 'Local NeoVim write failure cleanup did not complete cleanly',
          operationId: this.#diagnosticContext.operationId,
          details: { ...this.#diagnosticContext, sessionId, cleanupFailures }
        })
      }
      if (!this.#explicitClose) {
        void this.#requestStop(sessionId).catch((stopReason: unknown) => {
          this.#logger.warn({
            category: 'nvim',
            event: 'nvim.process.stop_failed',
            message: 'Native NeoVim stop cleanup failed after a write failure',
            operationId: this.#diagnosticContext.operationId,
            details: {
              ...this.#diagnosticContext,
              workspacePath: this.#workspacePath,
              configDirectory: this.#configDirectory,
              sessionId,
              reason: stopReason
            }
          })
        })
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
    if (this.#state === 'closed') {
      if (this.#closePromise !== undefined) return this.#closePromise
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
    const closeOperation = this.#logger.operation({
      category: 'transport',
      event: 'transport.local.close',
      message: 'Closing the local NeoVim process transport',
      parentOperationId: this.#diagnosticContext.operationId,
      details: {
        ...this.#diagnosticContext,
        workspacePath: this.#workspacePath,
        configDirectory: this.#configDirectory,
        sessionId: this.#sessionId
      }
    })
    this.#closePromise = (async () => {
      await this.#connectPromise?.catch(() => undefined)
      const sessionId = this.#sessionId
      let nativeStopFailure: unknown
      if (sessionId !== undefined) {
        try {
          await this.#requestStop(sessionId)
        } catch (reason) {
          nativeStopFailure = reason
        }
      }
      this.#state = 'closed'
      const cleanupFailures = this.#unsubscribe()
      cleanupFailures.push(...this.#notifyClose())
      if (nativeStopFailure !== undefined || cleanupFailures.length > 0) {
        const failure = toError(
          nativeStopFailure ?? cleanupFailures[0],
          'Local NeoVim transport closed with cleanup failures'
        )
        markDiagnosticOrigin(failure, 'transport.local.close')
        closeOperation.failure(failure, {
          event: 'transport.local.close.partial_failure',
          message: 'Local NeoVim process transport closed with native cleanup failures',
          details: {
            ...this.#diagnosticContext,
            workspacePath: this.#workspacePath,
            configDirectory: this.#configDirectory,
            sessionId,
            nativeStopFailure,
            cleanupFailures,
            closed: true
          }
        })
        throw failure
      } else {
        closeOperation.success({ message: 'Closed the local NeoVim process transport' })
      }
    })()
    return this.#closePromise
  }

  #subscribe(): void {
    const subscriptions: NativeSubscription[] = []
    try {
      subscriptions.push(this.#module.addListener('data', (event) => this.#receiveData(event)))
      subscriptions.push(this.#module.addListener('exit', (event) => this.#receiveExit(event)))
      this.#subscriptions = subscriptions
    } catch (reason) {
      this.#subscriptions = subscriptions
      const cleanupFailures = this.#unsubscribe()
      const error = toError(reason, 'Failed to subscribe to native NeoVim events')
      if (cleanupFailures.length > 0) {
        Object.assign(error, { subscriptionCleanupFailures: cleanupFailures })
      }
      throw error
    }
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
    if (event.sessionId !== this.#sessionId || this.#state === 'closed') return
    const error = this.#state === 'closing' || this.#explicitClose
      ? undefined
      : nativeExitError(event)
    if (error !== undefined) {
      markDiagnosticOrigin(error, 'nvim.process.exit')
      this.#logger.error({
        category: 'nvim',
        event: 'nvim.process.exited',
        message: 'Local NeoVim exited unexpectedly',
        operationId: this.#diagnosticContext.operationId,
        details: {
          ...this.#diagnosticContext,
          workspacePath: this.#workspacePath,
          configDirectory: this.#configDirectory,
          sessionId: this.#sessionId,
          exitEvent: event,
          error
        }
      })
    }
    const cleanupFailures = this.#terminate(error)
    if (cleanupFailures.length > 0) {
      this.#logger.warn({
        category: 'nvim',
        event: 'nvim.process.exit_cleanup_failed',
        message: 'NeoVim exit cleanup did not complete cleanly',
        operationId: this.#diagnosticContext.operationId,
        details: { ...this.#diagnosticContext, exitEvent: event, cleanupFailures }
      })
    }
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
      this.#stopPromise = Promise.resolve().then(() => this.#module.stop(sessionId))
    }
    return this.#stopPromise
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
    const error = attachDiagnosticCause(new Error(message), reason) as NativeCodedError
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

function originObservedError(origin: string): Error {
  const error = new Error(`Operational failure was already recorded by ${origin}`)
  error.name = 'DiagnosticOriginObserved'
  return error
}

function originSummary(origin: string, error: Error) {
  return { observedOrigin: origin, errorName: error.name, errorMessage: error.message }
}
