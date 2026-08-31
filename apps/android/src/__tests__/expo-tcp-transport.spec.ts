import type {
  NativeSubscription,
  NativeTcpCloseEvent,
  NativeTcpDataEvent,
  NativeTcpModule,
  NativeTcpWriteMeasurement
} from '../native/tcp'
import {
  clearPerformanceRecords,
  configurePerformanceDiagnostics,
  getPerformanceRecords,
  performanceNow
} from '@codey/perf'
import { createDiagnosticLogger, type DiagnosticLogger } from '../diagnostics/logger'
import { diagnosticOriginOf } from '../diagnostics/origin'
import { ExpoTcpTransport } from '../transport/expo-tcp-transport'

class FakeNativeTcp implements NativeTcpModule {
  readonly writes: Array<{ connectionId: number; bytes: number[] }> = []
  readonly measuredWrites: Array<{ connectionId: number; bytes: number[] }> = []
  nextConnectionId = 1
  openError: Error | undefined
  openSynchronousError: Error | undefined
  openImplementation: (() => Promise<number>) | undefined
  addListenerImplementation:
    | ((eventName: 'data' | 'close') => NativeSubscription)
    | undefined
  writeImplementation: ((connectionId: number, bytes: Uint8Array) => Promise<void>) | undefined
  writeMeasuredImplementation:
    | ((connectionId: number, bytes: Uint8Array) => Promise<NativeTcpWriteMeasurement>)
    | undefined
  removeListenerImplementation: ((eventName: 'data' | 'close') => void) | undefined
  readonly close = jest.fn(async (_connectionId: number) => undefined)

  readonly #dataListeners = new Set<(event: NativeTcpDataEvent) => void>()
  readonly #closeListeners = new Set<(event: NativeTcpCloseEvent) => void>()

  open(_host: string, _port: number, _timeoutMs: number): Promise<number> {
    if (this.openSynchronousError !== undefined) throw this.openSynchronousError
    if (this.openError !== undefined) return Promise.reject(this.openError)
    if (this.openImplementation !== undefined) return this.openImplementation()
    return Promise.resolve(this.nextConnectionId++)
  }

  async write(connectionId: number, bytes: Uint8Array): Promise<void> {
    this.writes.push({ connectionId, bytes: [...bytes] })
    await this.writeImplementation?.(connectionId, bytes)
  }

  async writeMeasured(
    connectionId: number,
    bytes: Uint8Array
  ): Promise<NativeTcpWriteMeasurement> {
    this.measuredWrites.push({ connectionId, bytes: [...bytes] })
    if (this.writeMeasuredImplementation !== undefined) {
      return this.writeMeasuredImplementation(connectionId, bytes)
    }
    const now = performanceNow()
    return {
      nativeEntryUptimeMs: now,
      lockWaitStartedAtUptimeMs: now,
      lockWaitDurationMs: 0,
      socketWriteStartedAtUptimeMs: now,
      socketWriteDurationMs: 0
    }
  }

  addListener(
    eventName: 'data',
    listener: (event: NativeTcpDataEvent) => void
  ): NativeSubscription
  addListener(
    eventName: 'close',
    listener: (event: NativeTcpCloseEvent) => void
  ): NativeSubscription
  addListener(
    eventName: 'data' | 'close',
    listener: ((event: NativeTcpDataEvent) => void) | ((event: NativeTcpCloseEvent) => void)
  ): NativeSubscription {
    if (this.addListenerImplementation !== undefined) {
      return this.addListenerImplementation(eventName)
    }
    const listeners = eventName === 'data' ? this.#dataListeners : this.#closeListeners
    listeners.add(listener as never)
    return {
      remove: () => {
        this.removeListenerImplementation?.(eventName)
        listeners.delete(listener as never)
      }
    }
  }

  emitData(event: NativeTcpDataEvent): void {
    for (const listener of [...this.#dataListeners]) listener(event)
  }

  emitClose(event: NativeTcpCloseEvent): void {
    for (const listener of [...this.#closeListeners]) listener(event)
  }
}

function createTestLogger(): DiagnosticLogger {
  const sink = jest.fn()
  return createDiagnosticLogger({
    console: { debug: sink, error: sink, info: sink, warn: sink }
  })
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('ExpoTcpTransport', () => {
  beforeEach(() => {
    configurePerformanceDiagnostics({ enabled: false })
    clearPerformanceRecords()
  })

  afterEach(() => {
    configurePerformanceDiagnostics({ enabled: false })
    clearPerformanceRecords()
  })

  it('forwards split binary data only for its connection ID', async () => {
    const native = new FakeNativeTcp()
    const transport = new ExpoTcpTransport(
      { host: '192.168.0.20', port: 6666 }, native, createTestLogger()
    )
    const chunks: number[][] = []
    transport.onData((chunk) => chunks.push([...chunk]))
    await transport.connect()

    native.emitData({ connectionId: 99, bytes: [8] })
    native.emitData({ connectionId: 1, bytes: Uint8Array.of(1, 2) })
    native.emitData({ connectionId: 1, bytes: [3, 4] })

    expect(chunks).toEqual([[1, 2], [3, 4]])
  })

  it('serializes writes and preserves byte order', async () => {
    const native = new FakeNativeTcp()
    const gates = [deferred(), deferred()]
    let writeIndex = 0
    native.writeImplementation = async () => gates[writeIndex++]!.promise
    const transport = new ExpoTcpTransport(
      { host: 'tablet-host', port: 6666 }, native, createTestLogger()
    )
    await transport.connect()

    const first = transport.write(Uint8Array.of(1, 2))
    const second = transport.write(Uint8Array.of(3, 4))
    await Promise.resolve()
    expect(native.writes).toEqual([{ connectionId: 1, bytes: [1, 2] }])

    gates[0]!.resolve()
    await first
    await Promise.resolve()
    expect(native.writes).toEqual([
      { connectionId: 1, bytes: [1, 2] },
      { connectionId: 1, bytes: [3, 4] }
    ])
    gates[1]!.resolve()
    await second
    expect(native.measuredWrites).toEqual([])
  })

  it('uses measured native writes only for diagnostics and records separate timing stages', async () => {
    configurePerformanceDiagnostics({ enabled: true, log: false })
    const native = new FakeNativeTcp()
    native.writeMeasuredImplementation = async () => {
      const now = performanceNow()
      return {
        nativeEntryUptimeMs: now,
        lockWaitStartedAtUptimeMs: now,
        lockWaitDurationMs: 2.5,
        socketWriteStartedAtUptimeMs: now,
        socketWriteDurationMs: 3.75
      }
    }
    const transport = new ExpoTcpTransport(
      { host: 'tablet-host', port: 6666 }, native, createTestLogger()
    )
    await transport.connect()

    await transport.write(Uint8Array.of(1, 2, 3))

    expect(native.writes).toEqual([])
    expect(native.measuredWrites).toEqual([{ connectionId: 1, bytes: [1, 2, 3] }])
    const records = getPerformanceRecords()
    expect(records.map((record) => record.stage)).toEqual(
      expect.arrayContaining([
        'native_socket_write_queue',
        'native_socket_write_lock_wait',
        'native_socket_write'
      ])
    )
    expect(
      records.find((record) => record.stage === 'native_socket_write_lock_wait')?.durationMs
    ).toBe(2.5)
    expect(
      records.find((record) => record.stage === 'native_socket_write')?.durationMs
    ).toBe(3.75)
    expect(JSON.stringify(records)).not.toContain('1,2,3')
  })

  it('surfaces a write failure once and makes close idempotent', async () => {
    const native = new FakeNativeTcp()
    const logger = createTestLogger()
    native.writeImplementation = async () => {
      throw new Error('broken pipe')
    }
    const transport = new ExpoTcpTransport(
      { host: 'tablet-host', port: 6666 }, native, logger
    )
    const closeListener = jest.fn()
    transport.onClose(closeListener)
    transport.onClose(() => { throw new Error('write close observer failed') })
    await transport.connect()
    logger.clear()
    native.removeListenerImplementation = () => {
      throw new Error('write subscription removal failed')
    }

    await expect(transport.write(Uint8Array.of(1))).rejects.toThrow('broken pipe')
    await transport.close()
    await transport.close()

    expect(closeListener).toHaveBeenCalledTimes(1)
    expect(closeListener).toHaveBeenCalledWith(expect.objectContaining({
      name: 'E_TCP_WRITE', nativeCode: 'E_TCP_WRITE', message: 'broken pipe'
    }))
    expect(logger.getSnapshot().entries.map(({ event }) => event)).toEqual([
      'transport.tcp.write_failed',
      'transport.tcp.write_cleanup_failed'
    ])
    expect(logger.getSnapshot().entries.at(-1)?.detailsText).toContain(
      'write subscription removal failed'
    )
    expect(logger.getSnapshot().entries.at(-1)?.detailsText).toContain(
      'write close observer failed'
    )
    expect(native.close).toHaveBeenCalledTimes(1)
  })

  it('isolates reconnects by native connection ID and one terminal event each', async () => {
    const native = new FakeNativeTcp()
    const first = new ExpoTcpTransport(
      { host: 'tablet-host', port: 6666 }, native, createTestLogger()
    )
    const second = new ExpoTcpTransport(
      { host: 'tablet-host', port: 6666 }, native, createTestLogger()
    )
    const firstClosed = jest.fn()
    const secondClosed = jest.fn()
    first.onClose(firstClosed)
    second.onClose(secondClosed)
    await first.connect()
    await second.connect()

    native.emitClose({ connectionId: 1, message: 'old peer closed', code: 'ECONNRESET' })
    native.emitClose({ connectionId: 1, message: 'duplicate' })
    expect(firstClosed).toHaveBeenCalledTimes(1)
    expect(firstClosed).toHaveBeenCalledWith(expect.objectContaining({
      name: 'ECONNRESET', nativeCode: 'ECONNRESET', message: 'old peer closed'
    }))
    expect(secondClosed).not.toHaveBeenCalled()

    native.emitClose({ connectionId: 2 })
    expect(secondClosed).toHaveBeenCalledTimes(1)
    expect(secondClosed).toHaveBeenCalledWith(expect.objectContaining({
      name: 'NativeTcpError',
      message: 'TCP connection closed unexpectedly'
    }))
  })

  it('retains a raw message-less native EOF and reports throwing termination cleanup', async () => {
    const native = new FakeNativeTcp()
    const logger = createTestLogger()
    const transport = new ExpoTcpTransport(
      { host: 'tablet-host', port: 6666 },
      native,
      logger,
      { generation: 4, operationId: 'connection-4' }
    )
    transport.onClose(() => { throw new Error('close observer cleanup failed') })
    await transport.connect()
    logger.clear()
    native.removeListenerImplementation = () => {
      throw new Error('native subscription removal failed')
    }

    native.emitClose({ connectionId: 1 })
    native.emitClose({ connectionId: 1 })

    expect(logger.getSnapshot().entries.map(({ event }) => event)).toEqual([
      'transport.tcp.unexpected_close',
      'transport.tcp.close_cleanup_failed'
    ])
    expect(logger.getSnapshot().entries[0]?.details).toMatchObject({
      nativeEvent: { connectionId: 1 },
      error: expect.objectContaining({ name: 'NativeTcpError' })
    })
    expect(logger.getSnapshot().entries[1]?.detailsText).toContain(
      'native subscription removal failed'
    )
    expect(logger.getSnapshot().entries[1]?.detailsText).toContain(
      'close observer cleanup failed'
    )
  })

  it('closes a connection-in-progress once without reporting an explicit close as an error', async () => {
    const native = new FakeNativeTcp()
    let finishOpen!: (connectionId: number) => void
    native.openImplementation = () =>
      new Promise<number>((resolve) => {
        finishOpen = resolve
      })
    const transport = new ExpoTcpTransport(
      { host: 'tablet-host', port: 6666 }, native, createTestLogger()
    )
    const closed = jest.fn()
    transport.onClose(closed)

    const connecting = transport.connect()
    const closing = transport.close()
    finishOpen(1)
    await expect(connecting).rejects.toThrow('closed while connecting')
    await closing

    expect(native.close).toHaveBeenCalledTimes(1)
    expect(native.close).toHaveBeenCalledWith(1)
    expect(closed).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledWith(undefined)
  })

  it('summarizes an already-recorded early native close in the open terminal', async () => {
    const native = new FakeNativeTcp()
    const logger = createTestLogger()
    native.openImplementation = async () => {
      native.emitClose({
        connectionId: 7,
        code: 'ECONNRESET',
        message: 'peer reset during open'
      })
      return 7
    }
    const transport = new ExpoTcpTransport(
      { host: 'tablet-host', port: 6666 },
      native,
      logger
    )

    await expect(transport.connect()).rejects.toMatchObject({
      name: 'ECONNRESET',
      message: 'peer reset during open'
    })

    expect(logger.getSnapshot().entries.map(({ event }) => event)).toEqual([
      'transport.tcp.open.started',
      'transport.tcp.unexpected_close',
      'transport.tcp.open.failed'
    ])
    expect(logger.getSnapshot().entries.at(-1)?.details).toMatchObject({
      error: expect.objectContaining({
        name: 'DiagnosticOriginObserved',
        message: expect.stringContaining('transport.tcp.close')
      }),
      context: expect.objectContaining({
        observedOrigin: 'transport.tcp.close',
        errorName: 'ECONNRESET',
        errorMessage: 'peer reset during open'
      })
    })
  })

  it('closes natively without waiting behind a stalled write', async () => {
    const native = new FakeNativeTcp()
    native.writeImplementation = () => new Promise<void>(() => undefined)
    const transport = new ExpoTcpTransport(
      { host: 'tablet-host', port: 6666 }, native, createTestLogger()
    )
    const closed = jest.fn()
    transport.onClose(closed)
    await transport.connect()

    void transport.write(Uint8Array.of(1, 2, 3))
    await Promise.resolve()
    await transport.close()

    expect(native.close).toHaveBeenCalledTimes(1)
    expect(native.close).toHaveBeenCalledWith(1)
    expect(closed).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledWith(undefined)
  })

  it('validates endpoints before calling native code', () => {
    const native = new FakeNativeTcp()
    expect(() => new ExpoTcpTransport({ host: ' ', port: 6666 }, native)).toThrow('host')
    expect(() => new ExpoTcpTransport({ host: 'host', port: 0 }, native)).toThrow('port')
  })

  it('rolls back partial subscriptions and terminally records synchronous open failures', async () => {
    const subscriptionNative = new FakeNativeTcp()
    const removeData = jest.fn()
    subscriptionNative.addListenerImplementation = (eventName) => {
      if (eventName === 'data') return { remove: removeData }
      throw new Error('close listener registration failed')
    }
    const subscriptionLogger = createTestLogger()
    const subscriptionTransport = new ExpoTcpTransport(
      { host: 'tablet-host', port: 6666 },
      subscriptionNative,
      subscriptionLogger
    )

    await expect(subscriptionTransport.connect()).rejects.toThrow(
      'close listener registration failed'
    )
    expect(removeData).toHaveBeenCalledTimes(1)
    expect(subscriptionLogger.getSnapshot().entries.map(({ event }) => event)).toEqual([
      'transport.tcp.open.started',
      'transport.tcp.open.failed'
    ])

    const openNative = new FakeNativeTcp()
    const nativeFailure = new Error('native open threw synchronously')
    openNative.openSynchronousError = nativeFailure
    const openLogger = createTestLogger()
    const openTransport = new ExpoTcpTransport(
      { host: 'tablet-host', port: 6666 },
      openNative,
      openLogger
    )

    await expect(openTransport.connect()).rejects.toBe(nativeFailure)
    expect(openLogger.getSnapshot().entries.map(({ event }) => event)).toEqual([
      'transport.tcp.open.started',
      'transport.tcp.open.failed'
    ])
    expect(diagnosticOriginOf(nativeFailure)).toBe('transport.tcp.open')
  })

  it('records native close rejection as a partial failure while still closing once', async () => {
    const native = new FakeNativeTcp()
    const logger = createTestLogger()
    const transport = new ExpoTcpTransport(
      { host: 'tablet-host', port: 6666 },
      native,
      logger
    )
    const closed = jest.fn()
    transport.onClose(closed)
    await transport.connect()
    logger.clear()
    const closeFailure = new Error('native close rejected')
    native.close.mockRejectedValueOnce(closeFailure)

    await expect(transport.close()).rejects.toBe(closeFailure)
    await expect(transport.close()).rejects.toBe(closeFailure)

    expect(closed).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledWith(undefined)
    expect(native.close).toHaveBeenCalledTimes(1)
    expect(logger.getSnapshot().entries.map(({ event }) => event)).toEqual([
      'transport.tcp.close.started',
      'transport.tcp.close.partial_failure'
    ])
    expect(logger.getSnapshot().entries.at(-1)).toMatchObject({ level: 'error' })
  })
})
