import type {
  NativeSubscription,
  NativeTcpCloseEvent,
  NativeTcpDataEvent,
  NativeTcpModule
} from '../native/tcp'
import { ExpoTcpTransport } from '../transport/expo-tcp-transport'

class FakeNativeTcp implements NativeTcpModule {
  readonly writes: Array<{ connectionId: number; bytes: number[] }> = []
  nextConnectionId = 1
  openError: Error | undefined
  openImplementation: (() => Promise<number>) | undefined
  writeImplementation: ((connectionId: number, bytes: Uint8Array) => Promise<void>) | undefined
  readonly close = jest.fn(async (_connectionId: number) => undefined)

  readonly #dataListeners = new Set<(event: NativeTcpDataEvent) => void>()
  readonly #closeListeners = new Set<(event: NativeTcpCloseEvent) => void>()

  async open(_host: string, _port: number, _timeoutMs: number): Promise<number> {
    if (this.openError !== undefined) throw this.openError
    if (this.openImplementation !== undefined) return this.openImplementation()
    return this.nextConnectionId++
  }

  async write(connectionId: number, bytes: Uint8Array): Promise<void> {
    this.writes.push({ connectionId, bytes: [...bytes] })
    await this.writeImplementation?.(connectionId, bytes)
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
    const listeners = eventName === 'data' ? this.#dataListeners : this.#closeListeners
    listeners.add(listener as never)
    return { remove: () => listeners.delete(listener as never) }
  }

  emitData(event: NativeTcpDataEvent): void {
    for (const listener of [...this.#dataListeners]) listener(event)
  }

  emitClose(event: NativeTcpCloseEvent): void {
    for (const listener of [...this.#closeListeners]) listener(event)
  }
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
  it('forwards split binary data only for its connection ID', async () => {
    const native = new FakeNativeTcp()
    const transport = new ExpoTcpTransport({ host: '192.168.0.20', port: 6666 }, native)
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
    const transport = new ExpoTcpTransport({ host: 'tablet-host', port: 6666 }, native)
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
  })

  it('surfaces a write failure once and makes close idempotent', async () => {
    const native = new FakeNativeTcp()
    native.writeImplementation = async () => {
      throw new Error('broken pipe')
    }
    const transport = new ExpoTcpTransport({ host: 'tablet-host', port: 6666 }, native)
    const closeListener = jest.fn()
    transport.onClose(closeListener)
    await transport.connect()

    await expect(transport.write(Uint8Array.of(1))).rejects.toThrow('broken pipe')
    await transport.close()
    await transport.close()

    expect(closeListener).toHaveBeenCalledTimes(1)
    expect(closeListener).toHaveBeenCalledWith(expect.objectContaining({ message: 'broken pipe' }))
    expect(native.close).toHaveBeenCalledTimes(1)
  })

  it('isolates reconnects by native connection ID and one terminal event each', async () => {
    const native = new FakeNativeTcp()
    const first = new ExpoTcpTransport({ host: 'tablet-host', port: 6666 }, native)
    const second = new ExpoTcpTransport({ host: 'tablet-host', port: 6666 }, native)
    const firstClosed = jest.fn()
    const secondClosed = jest.fn()
    first.onClose(firstClosed)
    second.onClose(secondClosed)
    await first.connect()
    await second.connect()

    native.emitClose({ connectionId: 1, message: 'old peer closed', code: 'ECONNRESET' })
    native.emitClose({ connectionId: 1, message: 'duplicate' })
    expect(firstClosed).toHaveBeenCalledTimes(1)
    expect(secondClosed).not.toHaveBeenCalled()

    native.emitClose({ connectionId: 2 })
    expect(secondClosed).toHaveBeenCalledTimes(1)
  })

  it('closes a connection-in-progress once without reporting an explicit close as an error', async () => {
    const native = new FakeNativeTcp()
    let finishOpen!: (connectionId: number) => void
    native.openImplementation = () =>
      new Promise<number>((resolve) => {
        finishOpen = resolve
      })
    const transport = new ExpoTcpTransport({ host: 'tablet-host', port: 6666 }, native)
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

  it('closes natively without waiting behind a stalled write', async () => {
    const native = new FakeNativeTcp()
    native.writeImplementation = () => new Promise<void>(() => undefined)
    const transport = new ExpoTcpTransport({ host: 'tablet-host', port: 6666 }, native)
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
})
