import {
  getNativeNvimStatus,
  openNativeNvimAllFilesSettings,
  type NativeNvimDataEvent,
  type NativeNvimExitEvent,
  type NativeNvimModule,
  type NativeNvimStatus,
  type NativeSubscription
} from '../native/nvim'
import { ExpoNvimProcessTransport } from '../transport/expo-nvim-process-transport'

class FakeNativeNvim implements NativeNvimModule {
  status: NativeNvimStatus = {
    supported: true,
    running: false,
    allFilesAccess: true
  }
  readonly starts: string[] = []
  readonly writes: Array<{ sessionId: number; bytes: number[] }> = []
  nextSessionId = 1
  startImplementation: ((cwd: string) => Promise<number>) | undefined
  writeImplementation: ((sessionId: number, bytes: Uint8Array) => Promise<void>) | undefined
  stopImplementation: ((sessionId: number) => Promise<void>) | undefined
  readonly getStatus = jest.fn(async () => this.status)
  readonly openAllFilesSettings = jest.fn(async () => undefined)
  readonly stop = jest.fn(async (sessionId: number) => this.stopImplementation?.(sessionId))

  readonly #dataListeners = new Set<(event: NativeNvimDataEvent) => void>()
  readonly #exitListeners = new Set<(event: NativeNvimExitEvent) => void>()

  async start(cwd: string): Promise<number> {
    this.starts.push(cwd)
    if (this.startImplementation !== undefined) return this.startImplementation(cwd)
    return this.nextSessionId++
  }

  async write(sessionId: number, bytes: Uint8Array): Promise<void> {
    this.writes.push({ sessionId, bytes: [...bytes] })
    await this.writeImplementation?.(sessionId, bytes)
  }

  addListener(
    eventName: 'data',
    listener: (event: NativeNvimDataEvent) => void
  ): NativeSubscription
  addListener(
    eventName: 'exit',
    listener: (event: NativeNvimExitEvent) => void
  ): NativeSubscription
  addListener(
    eventName: 'data' | 'exit',
    listener: ((event: NativeNvimDataEvent) => void) | ((event: NativeNvimExitEvent) => void)
  ): NativeSubscription {
    const listeners = eventName === 'data' ? this.#dataListeners : this.#exitListeners
    listeners.add(listener as never)
    return { remove: () => listeners.delete(listener as never) }
  }

  emitData(event: NativeNvimDataEvent): void {
    for (const listener of [...this.#dataListeners]) listener(event)
  }

  emitExit(event: NativeNvimExitEvent): void {
    for (const listener of [...this.#exitListeners]) listener(event)
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('native NeoVim wrapper', () => {
  it('forwards status and all-files settings calls', async () => {
    const native = new FakeNativeNvim()
    native.status = {
      supported: false,
      running: false,
      allFilesAccess: false,
      unavailableReason: 'unsupported_abi'
    }

    await expect(getNativeNvimStatus(native)).resolves.toEqual(native.status)
    await openNativeNvimAllFilesSettings(native)

    expect(native.getStatus).toHaveBeenCalledTimes(1)
    expect(native.openAllFilesSettings).toHaveBeenCalledTimes(1)
  })
})

describe('ExpoNvimProcessTransport', () => {
  it('starts in a trimmed workspace and forwards data only for its session', async () => {
    const native = new FakeNativeNvim()
    const transport = new ExpoNvimProcessTransport(
      { workspacePath: '  /storage/emulated/0/Code  ' },
      native
    )
    const chunks: number[][] = []
    transport.onData((chunk) => chunks.push([...chunk]))
    await transport.connect()

    native.emitData({ sessionId: 99, bytes: [8] })
    native.emitData({ sessionId: 1, bytes: Uint8Array.of(1, 2) })
    native.emitData({ sessionId: 1, bytes: [3, 4] })
    native.emitData({ sessionId: 1, bytes: [] })

    expect(native.starts).toEqual(['/storage/emulated/0/Code'])
    expect(chunks).toEqual([[1, 2], [3, 4]])
  })

  it('drains data emitted before native start resolves', async () => {
    const native = new FakeNativeNvim()
    native.startImplementation = async () => {
      native.emitData({ sessionId: 8, bytes: [1, 2] })
      native.emitData({ sessionId: 7, bytes: [9] })
      return 8
    }
    const transport = new ExpoNvimProcessTransport({ workspacePath: '/workspace' }, native)
    const chunks: number[][] = []
    transport.onData((chunk) => chunks.push([...chunk]))

    await transport.connect()

    expect(chunks).toEqual([[1, 2]])
  })

  it('serializes writes, copies caller-owned bytes, and preserves order', async () => {
    const native = new FakeNativeNvim()
    const gates = [deferred<void>(), deferred<void>()]
    let writeIndex = 0
    native.writeImplementation = async () => gates[writeIndex++]!.promise
    const transport = new ExpoNvimProcessTransport({ workspacePath: '/workspace' }, native)
    await transport.connect()

    const source = Uint8Array.of(1, 2)
    const first = transport.write(source)
    source[0] = 9
    const second = transport.write(Uint8Array.of(3, 4))
    await Promise.resolve()
    expect(native.writes).toEqual([{ sessionId: 1, bytes: [1, 2] }])

    gates[0]!.resolve()
    await first
    await Promise.resolve()
    expect(native.writes).toEqual([
      { sessionId: 1, bytes: [1, 2] },
      { sessionId: 1, bytes: [3, 4] }
    ])
    gates[1]!.resolve()
    await second
  })

  it('reports an unexpected exit once with native diagnostics', async () => {
    const native = new FakeNativeNvim()
    const transport = new ExpoNvimProcessTransport({ workspacePath: '/workspace' }, native)
    const closed = jest.fn()
    transport.onClose(closed)
    await transport.connect()

    native.emitExit({ sessionId: 99, exitCode: 2, message: 'stale process' })
    native.emitExit({
      sessionId: 1,
      exitCode: 17,
      code: 'E_NVIM_READ',
      message: 'NeoVim stdout failed',
      stderrTail: 'fatal detail\n'
    })
    native.emitExit({ sessionId: 1, exitCode: 17, message: 'duplicate' })

    expect(closed).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledWith(expect.objectContaining({
      name: 'E_NVIM_READ',
      code: 'E_NVIM_READ',
      nativeCode: 'E_NVIM_READ',
      exitCode: 17,
      stderrTail: 'fatal detail',
      message: 'NeoVim stdout failed\nfatal detail'
    }))
  })

  it('turns an exit emitted during start into a rejected connection', async () => {
    const native = new FakeNativeNvim()
    native.startImplementation = async () => {
      native.emitExit({ sessionId: 4, exitCode: 127, stderrTail: 'linker failure' })
      return 4
    }
    const transport = new ExpoNvimProcessTransport({ workspacePath: '/workspace' }, native)
    const closed = jest.fn()
    transport.onClose(closed)

    await expect(transport.connect()).rejects.toMatchObject({
      name: 'E_NVIM_EXIT',
      nativeCode: 'E_NVIM_EXIT',
      exitCode: 127
    })
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('preserves a native write code, terminates once, and stops the process', async () => {
    const native = new FakeNativeNvim()
    native.writeImplementation = async () => {
      throw Object.assign(new Error('stdin broke'), { code: 'E_NVIM_STDIN' })
    }
    const transport = new ExpoNvimProcessTransport({ workspacePath: '/workspace' }, native)
    const closed = jest.fn()
    transport.onClose(closed)
    await transport.connect()

    await expect(transport.write(Uint8Array.of(1))).rejects.toMatchObject({
      name: 'E_NVIM_STDIN',
      code: 'E_NVIM_STDIN',
      nativeCode: 'E_NVIM_STDIN',
      message: 'stdin broke'
    })
    await Promise.resolve()
    await transport.close()

    expect(closed).toHaveBeenCalledTimes(1)
    expect(native.stop).toHaveBeenCalledTimes(1)
    expect(native.stop).toHaveBeenCalledWith(1)
  })

  it('joins native termination after an error-triggered close', async () => {
    const native = new FakeNativeNvim()
    const stopped = deferred<void>()
    native.writeImplementation = async () => { throw new Error('stdin broke') }
    native.stopImplementation = () => stopped.promise
    const transport = new ExpoNvimProcessTransport({ workspacePath: '/workspace' }, native)
    await transport.connect()

    await expect(transport.write(Uint8Array.of(1))).rejects.toThrow('stdin broke')
    const closing = transport.close()
    let didClose = false
    void closing.then(() => { didClose = true })
    await Promise.resolve()
    expect(didClose).toBe(false)

    stopped.resolve()
    await closing
    expect(native.stop).toHaveBeenCalledTimes(1)
  })

  it('closes a process-in-progress without reporting an explicit close as an error', async () => {
    const native = new FakeNativeNvim()
    const started = deferred<number>()
    native.startImplementation = () => started.promise
    const transport = new ExpoNvimProcessTransport({ workspacePath: '/workspace' }, native)
    const closed = jest.fn()
    transport.onClose(closed)

    const connecting = transport.connect()
    const closing = transport.close()
    started.resolve(12)
    await expect(connecting).rejects.toMatchObject({ nativeCode: 'E_NVIM_CLOSED' })
    await closing

    expect(native.stop).toHaveBeenCalledTimes(1)
    expect(native.stop).toHaveBeenCalledWith(12)
    expect(closed).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledWith(undefined)
  })

  it('stops natively without waiting behind a stalled write and makes close idempotent', async () => {
    const native = new FakeNativeNvim()
    native.writeImplementation = () => new Promise<void>(() => undefined)
    const transport = new ExpoNvimProcessTransport({ workspacePath: '/workspace' }, native)
    const closed = jest.fn()
    transport.onClose(closed)
    await transport.connect()

    void transport.write(Uint8Array.of(1, 2, 3))
    await Promise.resolve()
    await transport.close()
    await transport.close()

    expect(native.stop).toHaveBeenCalledTimes(1)
    expect(native.stop).toHaveBeenCalledWith(1)
    expect(closed).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledWith(undefined)
  })

  it('validates the workspace before calling native code', () => {
    const native = new FakeNativeNvim()
    expect(() => new ExpoNvimProcessTransport({ workspacePath: '  ' }, native)).toThrow(
      'workspace path'
    )
    expect(native.starts).toEqual([])
  })
})
