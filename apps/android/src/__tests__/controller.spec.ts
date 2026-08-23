import type { RedrawBatch } from '@codey/nvim-session'
import {
  clearPerformanceRecords,
  configurePerformanceDiagnostics,
  createPerformanceInputSample,
  getPerformanceRecords,
  withPerformanceTags
} from '@codey/perf'
import type { DuplexTransport } from '@codey/transport'

import {
  TabletClientController,
  type FrameScheduler,
  type MobileSession
} from '../controller'
import type { Endpoint } from '../endpoint'

function connectionDouble() {
  let redrawListener: ((batch: RedrawBatch) => void) | undefined
  let closeListener: ((error?: Error) => void) | undefined
  const removeRedraw = jest.fn()
  const removeClose = jest.fn()
  const session = {
    connect: jest.fn(async () => undefined),
    attach: jest.fn(async (_width: number, _height: number) => undefined),
    input: jest.fn(async (_keys: string) => undefined),
    inputMouse: jest.fn(async () => undefined),
    resize: jest.fn(async (_width: number, _height: number): Promise<void> => undefined),
    onRedraw: jest.fn((listener: (batch: RedrawBatch) => void) => {
      redrawListener = listener
      return removeRedraw
    }),
    close: jest.fn(async (): Promise<void> => undefined)
  } satisfies MobileSession
  const transport = {
    connect: jest.fn(async () => undefined),
    write: jest.fn(async (_data: Uint8Array) => undefined),
    onData: jest.fn((_listener: (chunk: Uint8Array) => void) => jest.fn()),
    onClose: jest.fn((listener: (error?: Error) => void) => {
      closeListener = listener
      return removeClose
    }),
    close: jest.fn(async () => undefined)
  } satisfies DuplexTransport
  return {
    transport,
    session,
    removeRedraw,
    removeClose,
    redraw(batch: RedrawBatch) {
      redrawListener?.(batch)
    },
    remoteClose(error?: Error) {
      closeListener?.(error)
    }
  }
}

const endpoint = { host: '192.168.0.20', port: 6666 }

function deferredVoid() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function frameSchedulerDouble() {
  let nextHandle = 1
  const pending = new Map<number, (timestampMs: number) => void>()
  const allCallbacks = new Map<number, (timestampMs: number) => void>()
  const scheduler = {
    request: jest.fn((callback: (timestampMs: number) => void) => {
      const handle = nextHandle++
      pending.set(handle, callback)
      allCallbacks.set(handle, callback)
      return handle
    }),
    cancel: jest.fn((handle: number) => {
      pending.delete(handle)
    })
  } satisfies FrameScheduler

  return {
    scheduler,
    get pendingCount() {
      return pending.size
    },
    get lastHandle() {
      return nextHandle - 1
    },
    advance(timestampMs = 16) {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const callback of callbacks) callback(timestampMs)
    },
    forceRun(handle: number, timestampMs = 16) {
      allCallbacks.get(handle)?.(timestampMs)
    }
  }
}

describe('TabletClientController', () => {
  afterEach(() => {
    configurePerformanceDiagnostics({ enabled: false })
    clearPerformanceRecords()
  })

  it('connects one session, attaches the current grid, sends input, and resizes', async () => {
    const double = connectionDouble()
    const factory = jest.fn((_endpoint: Endpoint) => double)
    const controller = new TabletClientController(factory)
    controller.setGridSize({ columns: 100, rows: 30 })

    await controller.connect(endpoint)
    await controller.input('ihello<Esc>')
    controller.setGridSize({ columns: 110, rows: 35 })
    await Promise.resolve()

    expect(factory).toHaveBeenCalledTimes(1)
    expect(double.session.connect).toHaveBeenCalledTimes(1)
    expect(double.session.attach).toHaveBeenCalledWith(100, 30)
    expect(double.session.input).toHaveBeenCalledWith('ihello<Esc>')
    expect(double.session.resize).toHaveBeenCalledWith(110, 35)
    expect(controller.getState().phase).toBe('connected')
  })

  it('forwards mouse input only to the ready connection', async () => {
    const double = connectionDouble()
    const controller = new TabletClientController(() => double)
    const mouse = {
      button: 'left',
      action: 'press',
      modifier: '',
      gridId: 0,
      row: 3,
      column: 5
    }

    await controller.inputMouse(mouse)
    expect(double.session.inputMouse).not.toHaveBeenCalled()

    await controller.connect(endpoint)
    await controller.inputMouse(mouse)
    expect(double.session.inputMouse).toHaveBeenCalledWith(mouse)

    await controller.disconnect()
    await controller.inputMouse(mouse)
    expect(double.session.inputMouse).toHaveBeenCalledTimes(1)
  })

  it('fails the current connection when mouse RPC input fails', async () => {
    const double = connectionDouble()
    double.session.inputMouse.mockRejectedValueOnce(new Error('mouse rejected'))
    const controller = new TabletClientController(() => double)
    await controller.connect(endpoint)

    await controller.inputMouse({
      button: 'left',
      action: 'press',
      row: 0,
      column: 0
    })

    expect(double.session.close).toHaveBeenCalledTimes(1)
    expect(controller.getState()).toMatchObject({
      phase: 'error',
      message: 'mouse rejected'
    })
  })

  it('publishes a renderer snapshot only after a redraw flush', async () => {
    const double = connectionDouble()
    const frames = frameSchedulerDouble()
    const controller = new TabletClientController(() => double, frames.scheduler)
    const listener = jest.fn()
    controller.subscribe(listener)
    await controller.connect(endpoint)
    listener.mockClear()

    double.redraw([
      ['grid_resize', [1, 2, 1]],
      ['grid_line', [1, 0, 0, [['A', 0], ['界']]]]
    ])
    expect(controller.getState().snapshot).toBeNull()
    expect(listener).not.toHaveBeenCalled()

    double.redraw([['flush', []]])
    expect(controller.getState().snapshot).toBeNull()
    expect(listener).not.toHaveBeenCalled()
    expect(frames.pendingCount).toBe(1)

    frames.advance()
    expect(controller.getState().snapshot?.grid?.cells.map((cell) => cell.text)).toEqual([
      'A',
      '界'
    ])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('coalesces multiple flushes to the latest snapshot in one scheduled frame', async () => {
    const double = connectionDouble()
    const frames = frameSchedulerDouble()
    const controller = new TabletClientController(() => double, frames.scheduler)
    const listener = jest.fn()
    controller.subscribe(listener)
    await controller.connect(endpoint)
    listener.mockClear()

    double.redraw([
      ['grid_resize', [1, 1, 1]],
      ['grid_line', [1, 0, 0, [['A', 0]]]],
      ['flush', []]
    ])
    double.redraw([
      ['grid_line', [1, 0, 0, [['B', 0]]]],
      ['flush', []]
    ])
    double.redraw([
      ['grid_line', [1, 0, 0, [['C', 0]]]],
      ['flush', []]
    ])

    expect(frames.scheduler.request).toHaveBeenCalledTimes(1)
    expect(listener).not.toHaveBeenCalled()
    frames.advance()

    expect(controller.getState().snapshot?.grid?.cells[0]?.text).toBe('C')
    expect(controller.getState().snapshot?.flushCount).toBe(3)
    expect(listener).toHaveBeenCalledTimes(1)

    double.redraw([['flush', []]])
    expect(frames.scheduler.request).toHaveBeenCalledTimes(2)
    frames.advance()
    expect(controller.getState().snapshot?.flushCount).toBe(4)
  })

  it('does not leak post-flush, unflushed mutations into a pending snapshot', async () => {
    const double = connectionDouble()
    const frames = frameSchedulerDouble()
    const controller = new TabletClientController(() => double, frames.scheduler)
    await controller.connect(endpoint)

    double.redraw([
      ['grid_resize', [1, 1, 1]],
      ['grid_line', [1, 0, 0, [['A', 0]]]],
      ['flush', []]
    ])
    double.redraw([['grid_line', [1, 0, 0, [['B', 0]]]]])
    frames.advance()

    expect(controller.getState().snapshot?.grid?.cells[0]?.text).toBe('A')
    expect(controller.getState().snapshot?.flushCount).toBe(1)
  })

  it('cancels pending frames for disconnect, reconnect, remote close, and disposal', async () => {
    const scenarios = ['disconnect', 'reconnect', 'remote-close', 'dispose'] as const

    for (const scenario of scenarios) {
      const first = connectionDouble()
      const second = connectionDouble()
      const doubles = [first, second]
      const frames = frameSchedulerDouble()
      const controller = new TabletClientController(() => doubles.shift()!, frames.scheduler)
      await controller.connect(endpoint)
      first.redraw([
        ['grid_resize', [1, 1, 1]],
        ['grid_line', [1, 0, 0, [['A', 0]]]],
        ['flush', []]
      ])
      const canceledHandle = frames.lastHandle

      if (scenario === 'disconnect') await controller.disconnect()
      if (scenario === 'reconnect') {
        await controller.connect({ host: '192.168.0.21', port: 7777 })
      }
      if (scenario === 'remote-close') first.remoteClose(new Error('closed'))
      if (scenario === 'dispose') await controller.dispose()

      expect(frames.scheduler.cancel).toHaveBeenCalledWith(canceledHandle)
      expect(frames.pendingCount).toBe(0)
      frames.forceRun(canceledHandle)
      expect(controller.getState().snapshot).toBeNull()
    }
  })

  it('records sanitized controller, redraw, and publication diagnostics', async () => {
    configurePerformanceDiagnostics({ enabled: true, log: false, build: 'release' })
    const double = connectionDouble()
    const frames = frameSchedulerDouble()
    const controller = new TabletClientController(() => double, frames.scheduler)
    await controller.connect(endpoint)

    await withPerformanceTags(
      { source: 'ime', firstKeyAfterFocus: true },
      () => controller.input('private-text')
    )
    double.redraw([
      ['grid_resize', [1, 1, 1]],
      ['flush', []]
    ])
    frames.advance()

    const records = getPerformanceRecords()
    expect(records.map((record) => record.stage)).toEqual(
      expect.arrayContaining([
        'controller_input',
        'redraw_reduction',
        'redraw_processing',
        'snapshot_publication'
      ])
    )
    expect(records.find((record) => record.stage === 'controller_input')?.tags).toMatchObject({
      source: 'ime',
      inputLength: 12,
      connectionGeneration: 1,
      firstKeyAfterFocus: true,
      build: 'release'
    })
    expect(JSON.stringify(records)).not.toContain('private-text')
  })

  it('correlates every pending input to its next flush and coalesced snapshot', async () => {
    configurePerformanceDiagnostics({ enabled: true, log: false, build: 'release' })
    const double = connectionDouble()
    const frames = frameSchedulerDouble()
    const controller = new TabletClientController(() => double, frames.scheduler)
    await controller.connect(endpoint)
    const first = createPerformanceInputSample()
    const second = createPerformanceInputSample()
    const third = createPerformanceInputSample()

    await withPerformanceTags({ ...first, source: 'ime' }, () => controller.input('a'))
    await withPerformanceTags({ ...second, source: 'hardware' }, () => controller.input('b'))
    double.redraw([
      ['grid_resize', [1, 1, 1]],
      ['grid_line', [1, 0, 0, [['B', 0]]]],
      ['flush', []]
    ])
    await withPerformanceTags({ ...third, source: 'action-pad' }, () => controller.input('c'))
    double.redraw([
      ['grid_line', [1, 0, 0, [['C', 0]]]],
      ['flush', []]
    ])

    expect(controller.getState().performanceSamples).toEqual([])
    expect(frames.scheduler.request).toHaveBeenCalledTimes(1)
    frames.advance()

    expect(controller.getState().performanceSamples.map((sample) => ({
      sampleId: sample.sampleId,
      flushCount: sample.flushCount
    }))).toEqual([
      { sampleId: first.sampleId, flushCount: 1 },
      { sampleId: second.sampleId, flushCount: 1 },
      { sampleId: third.sampleId, flushCount: 2 }
    ])
    const records = getPerformanceRecords()
    expect(records.filter((record) => record.stage === 'input_to_redraw').map((record) => ({
      sampleId: record.tags.sampleId,
      flushCount: record.tags.flushCount
    }))).toEqual([
      { sampleId: first.sampleId, flushCount: 1 },
      { sampleId: second.sampleId, flushCount: 1 },
      { sampleId: third.sampleId, flushCount: 2 }
    ])
    expect(records.filter((record) => record.stage === 'input_to_snapshot').map(
      (record) => record.tags.sampleId
    )).toEqual([first.sampleId, second.sampleId, third.sampleId])
  })

  it('bounds pending samples and records dropped and unmatched inputs on close', async () => {
    configurePerformanceDiagnostics({ enabled: true, capacity: 4_096, log: false })
    const double = connectionDouble()
    const controller = new TabletClientController(() => double)
    await controller.connect(endpoint)

    for (let index = 0; index < 257; index += 1) {
      const sample = createPerformanceInputSample()
      await withPerformanceTags({ ...sample, source: 'ime' }, () => controller.input('x'))
    }
    await controller.disconnect()

    const records = getPerformanceRecords()
    expect(records.filter((record) => record.stage === 'input_sample_dropped')).toHaveLength(1)
    expect(records.filter((record) => record.stage === 'input_sample_unmatched')).toHaveLength(256)
  })

  it('records flushed samples as unpublished when a pending frame is canceled', async () => {
    configurePerformanceDiagnostics({ enabled: true, log: false })
    const double = connectionDouble()
    const frames = frameSchedulerDouble()
    const controller = new TabletClientController(() => double, frames.scheduler)
    await controller.connect(endpoint)
    const sample = createPerformanceInputSample()

    await withPerformanceTags({ ...sample, source: 'ime' }, () => controller.input('x'))
    double.redraw([['flush', []]])
    await controller.disconnect()

    expect(getPerformanceRecords().filter(
      (record) => record.stage === 'input_sample_unpublished'
    ).map((record) => record.tags.sampleId)).toEqual([sample.sampleId])
    frames.forceRun(frames.lastHandle)
    expect(controller.getState().performanceSamples).toEqual([])
  })

  it('isolates stale redraw and close events after reconnecting', async () => {
    const first = connectionDouble()
    const second = connectionDouble()
    const doubles = [first, second]
    const factory = jest.fn((_endpoint: Endpoint) => doubles.shift()!)
    const controller = new TabletClientController(factory)

    await controller.connect(endpoint)
    await controller.connect({ host: '192.168.0.21', port: 7777 })
    first.redraw([['flush', []]])
    first.remoteClose(new Error('old socket'))

    expect(first.session.close).toHaveBeenCalledTimes(1)
    expect(controller.getState()).toMatchObject({
      phase: 'connected',
      snapshot: null,
      message: 'Connected to 192.168.0.21:7777'
    })
  })

  it('lets only the latest simultaneous connect construct a session', async () => {
    const created: ReturnType<typeof connectionDouble>[] = []
    const factory = jest.fn((_endpoint: Endpoint) => {
      const double = connectionDouble()
      created.push(double)
      return double
    })
    const controller = new TabletClientController(factory)

    const first = controller.connect({ host: '192.168.0.20', port: 6666 })
    const second = controller.connect({ host: '192.168.0.21', port: 7777 })
    await Promise.all([first, second])

    expect(factory).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledWith({ host: '192.168.0.21', port: 7777 })
    expect(created).toHaveLength(1)
    expect(created[0]!.session.attach).toHaveBeenCalledTimes(1)
    expect(controller.getState().message).toBe('Connected to 192.168.0.21:7777')
  })

  it('waits for the old session to finish closing before constructing a reconnect', async () => {
    const first = connectionDouble()
    const latest = connectionDouble()
    const closeGate = deferredVoid()
    first.session.close.mockImplementationOnce(async () => closeGate.promise)
    const factory = jest
      .fn((_endpoint: Endpoint) => first)
      .mockImplementationOnce((_endpoint: Endpoint) => first)
      .mockImplementationOnce((_endpoint: Endpoint) => latest)
    const controller = new TabletClientController(factory)
    await controller.connect(endpoint)

    const supersededReconnect = controller.connect({ host: '192.168.0.21', port: 7777 })
    const latestReconnect = controller.connect({ host: '192.168.0.22', port: 8888 })
    await Promise.resolve()

    expect(factory).toHaveBeenCalledTimes(1)
    closeGate.resolve()
    await Promise.all([supersededReconnect, latestReconnect])

    expect(factory).toHaveBeenCalledTimes(2)
    expect(factory).toHaveBeenLastCalledWith({ host: '192.168.0.22', port: 8888 })
    expect(latest.session.connect).toHaveBeenCalledTimes(1)
    expect(controller.getState().message).toBe('Connected to 192.168.0.22:8888')
  })

  it('serializes rapid resizes and coalesces pending bounds to the latest grid', async () => {
    const double = connectionDouble()
    const firstResize = deferredVoid()
    const latestResize = deferredVoid()
    double.session.resize
      .mockImplementationOnce(async () => firstResize.promise)
      .mockImplementationOnce(async () => latestResize.promise)
    const controller = new TabletClientController(() => double)
    await controller.connect(endpoint)

    controller.setGridSize({ columns: 90, rows: 28 })
    controller.setGridSize({ columns: 100, rows: 30 })
    controller.setGridSize({ columns: 110, rows: 32 })
    await Promise.resolve()
    expect(double.session.resize).toHaveBeenCalledTimes(1)
    expect(double.session.resize).toHaveBeenNthCalledWith(1, 90, 28)

    firstResize.resolve()
    await firstResize.promise
    await Promise.resolve()
    expect(double.session.resize).toHaveBeenCalledTimes(2)
    expect(double.session.resize).toHaveBeenNthCalledWith(2, 110, 32)

    latestResize.resolve()
    await latestResize.promise
  })

  it('reports remote closure as an error and tears down idempotently', async () => {
    const double = connectionDouble()
    const controller = new TabletClientController(() => double)
    await controller.connect(endpoint)

    double.remoteClose(new Error('reset by peer'))
    expect(controller.getState()).toMatchObject({
      phase: 'error',
      message: 'Neovim connection closed: reset by peer'
    })
    double.remoteClose(new Error('duplicate'))
    await controller.disconnect()
    await controller.disconnect()

    expect(double.session.close).toHaveBeenCalledTimes(1)
    expect(double.removeClose).toHaveBeenCalledTimes(1)
    expect(double.removeRedraw).toHaveBeenCalledTimes(1)
    expect(controller.getState().phase).toBe('disconnected')
  })

  it('disposes an active session when the supported subtree unmounts', async () => {
    const double = connectionDouble()
    const controller = new TabletClientController(() => double)
    await controller.connect(endpoint)

    await controller.dispose()
    await controller.dispose()

    expect(double.session.close).toHaveBeenCalledTimes(1)
    await expect(controller.connect(endpoint)).rejects.toThrow('disposed')
  })
})
