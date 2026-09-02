import type { HostDocument, HostDocumentWrite, RedrawBatch } from '@codey/nvim-session'
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
import { createDiagnosticLogger } from '../diagnostics/logger'
import type { LocalConnectionSettings } from '../local-connection-settings'

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
    readHostDocument: jest.fn(async (path: string): Promise<HostDocument> => ({ path, text: null })),
    writeHostDocument: jest.fn(async (_request: HostDocumentWrite): Promise<void> => undefined),
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
    processClose(error?: Error) {
      closeListener?.(error)
    }
  }
}

const target: LocalConnectionSettings = {
  version: 1,
  workspacePath: '/storage/emulated/0/Code',
  configDirectory: '/storage/emulated/0/Codey'
}
const secondTarget: LocalConnectionSettings = {
  version: 1,
  workspacePath: '/storage/emulated/0/Second',
  configDirectory: '/storage/emulated/0/SecondConfig'
}
const thirdTarget: LocalConnectionSettings = {
  version: 1,
  workspacePath: '/storage/emulated/0/Third',
  configDirectory: '/storage/emulated/0/ThirdConfig'
}

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

  it('connects with local settings and derives the fixed Action Pad path', async () => {
    const double = connectionDouble()
    const factory = jest.fn((_settings: LocalConnectionSettings) => double)
    const controller = new TabletClientController(factory)

    await controller.connect(target)

    expect(factory).toHaveBeenCalledWith(target, {
      generation: 1,
      operationId: expect.any(String)
    })
    expect(controller.getState()).toMatchObject({
      phase: 'connected',
      message: 'Running in /storage/emulated/0/Code'
    })
    await expect(controller.readActionPad()).resolves.toEqual({
      path: '/storage/emulated/0/Codey/action-pad.yaml',
      text: null
    })
    expect(double.session.readHostDocument).toHaveBeenCalledWith(
      '/storage/emulated/0/Codey/action-pad.yaml'
    )
    await controller.dispose()
  })

  it('requires a ready local process for Action Pad access and keeps document errors nonfatal', async () => {
    const double = connectionDouble()
    const controller = new TabletClientController(() => double)
    await expect(controller.readActionPad()).rejects.toThrow('Start local Neovim')
    await controller.connect(target)
    double.session.readHostDocument.mockRejectedValueOnce(new Error('Permission denied'))
    await expect(controller.readActionPad()).rejects.toThrow('Permission denied')
    expect(controller.getState().phase).toBe('connected')
    expect(double.session.close).not.toHaveBeenCalled()
    await controller.writeActionPad('version: 1\n')
    expect(double.session.writeHostDocument).toHaveBeenCalledWith({
      path: '/storage/emulated/0/Codey/action-pad.yaml', text: 'version: 1\n'
    })
    expect(double.session.input).not.toHaveBeenCalled()
    await controller.dispose()
  })

  it('rejects Action Pad responses from an old connection generation', async () => {
    const first = connectionDouble()
    const second = connectionDouble()
    const factory = jest.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const controller = new TabletClientController(factory)
    let finish!: (document: HostDocument) => void
    first.session.readHostDocument.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    await controller.connect(target)
    const reading = controller.readActionPad()
    await controller.connect(secondTarget)
    finish({ path: '/storage/emulated/0/Codey/action-pad.yaml', text: 'old' })
    await expect(reading).rejects.toThrow('process changed')
    expect(controller.getState().phase).toBe('connected')
    await controller.dispose()
  })

  it('keeps awaiting a document response beyond 15 seconds without closing or replaying a write', async () => {
    jest.useFakeTimers()
    const double = connectionDouble()
    const controller = new TabletClientController(() => double)
    try {
      await controller.connect(target)
      let finish!: () => void
      double.session.writeHostDocument.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
      const saving = controller.writeActionPad('version: 1\n')
      await jest.advanceTimersByTimeAsync(15_000)
      expect(double.session.writeHostDocument).toHaveBeenCalledTimes(1)
      expect(controller.getState().phase).toBe('connected')
      finish()
      await expect(saving).resolves.toBeUndefined()
      expect(double.session.writeHostDocument).toHaveBeenCalledTimes(1)
      expect(controller.getState().phase).toBe('connected')
    } finally {
      await controller.dispose()
      jest.useRealTimers()
    }
  })

  it('connects one session, attaches the current grid, sends input, and resizes', async () => {
    const double = connectionDouble()
    const factory = jest.fn((_settings: LocalConnectionSettings) => double)
    const controller = new TabletClientController(factory)
    controller.setGridSize({ columns: 100, rows: 30 })

    await controller.connect(target)
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

    await controller.connect(target)
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
    await controller.connect(target)

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
    await controller.connect(target)
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
    await controller.connect(target)
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
    await controller.connect(target)

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

  it('cancels pending frames for disconnect, reconnect, process exit, and disposal', async () => {
    const scenarios = ['disconnect', 'reconnect', 'process-exit', 'dispose'] as const

    for (const scenario of scenarios) {
      const first = connectionDouble()
      const second = connectionDouble()
      const doubles = [first, second]
      const frames = frameSchedulerDouble()
      const controller = new TabletClientController(() => doubles.shift()!, frames.scheduler)
      await controller.connect(target)
      first.redraw([
        ['grid_resize', [1, 1, 1]],
        ['grid_line', [1, 0, 0, [['A', 0]]]],
        ['flush', []]
      ])
      const canceledHandle = frames.lastHandle

      if (scenario === 'disconnect') await controller.disconnect()
      if (scenario === 'reconnect') {
        await controller.connect(secondTarget)
      }
      if (scenario === 'process-exit') first.processClose(new Error('closed'))
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
    await controller.connect(target)

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

  it('does not retain typed input when an RPC write fails', async () => {
    const double = connectionDouble()
    double.session.input.mockRejectedValueOnce(new Error('write failed'))
    const sink = jest.fn()
    const logger = createDiagnosticLogger({
      console: { debug: sink, error: sink, info: sink, warn: sink }
    })
    const controller = new TabletClientController(
      () => double,
      frameSchedulerDouble().scheduler,
      logger
    )
    await controller.connect(target)

    await controller.input('private-typed-text-✓')

    const serialized = JSON.stringify(logger.getSnapshot())
    expect(serialized).not.toContain('private-typed-text')
    expect(logger.getSnapshot().entries.find(({ event }) => event === 'input.write_failed'))
      .toMatchObject({
        details: expect.objectContaining({
          generation: 1,
          inputLength: 20,
          byteLength: 22
        })
      })
  })

  it('correlates every pending input to its next flush and coalesced snapshot', async () => {
    configurePerformanceDiagnostics({ enabled: true, log: false, build: 'release' })
    const double = connectionDouble()
    const frames = frameSchedulerDouble()
    const controller = new TabletClientController(() => double, frames.scheduler)
    await controller.connect(target)
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
    await controller.connect(target)

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
    await controller.connect(target)
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
    const factory = jest.fn((_settings: LocalConnectionSettings) => doubles.shift()!)
    const controller = new TabletClientController(factory)

    await controller.connect(target)
    await controller.connect(secondTarget)
    first.redraw([['flush', []]])
    first.processClose(new Error('old process'))

    expect(first.session.close).toHaveBeenCalledTimes(1)
    expect(controller.getState()).toMatchObject({
      phase: 'connected',
      snapshot: null,
      message: 'Running in /storage/emulated/0/Second'
    })
  })

  it('lets only the latest simultaneous connect construct a session', async () => {
    const created: ReturnType<typeof connectionDouble>[] = []
    const factory = jest.fn((_settings: LocalConnectionSettings) => {
      const double = connectionDouble()
      created.push(double)
      return double
    })
    const controller = new TabletClientController(factory)

    const first = controller.connect(target)
    const second = controller.connect(secondTarget)
    await Promise.all([first, second])

    expect(factory).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledWith(
      secondTarget,
      { generation: 2, operationId: expect.any(String) }
    )
    expect(created).toHaveLength(1)
    expect(created[0]!.session.attach).toHaveBeenCalledTimes(1)
    expect(controller.getState().message).toBe('Running in /storage/emulated/0/Second')
  })

  it('waits for the old session to finish closing before constructing a reconnect', async () => {
    const first = connectionDouble()
    const latest = connectionDouble()
    const closeGate = deferredVoid()
    first.session.close.mockImplementationOnce(async () => closeGate.promise)
    const factory = jest
      .fn((_settings: LocalConnectionSettings) => first)
      .mockImplementationOnce((_settings: LocalConnectionSettings) => first)
      .mockImplementationOnce((_settings: LocalConnectionSettings) => latest)
    const controller = new TabletClientController(factory)
    await controller.connect(target)

    const supersededReconnect = controller.connect(secondTarget)
    const latestReconnect = controller.connect(thirdTarget)
    await Promise.resolve()

    expect(factory).toHaveBeenCalledTimes(1)
    closeGate.resolve()
    await Promise.all([supersededReconnect, latestReconnect])

    expect(factory).toHaveBeenCalledTimes(2)
    expect(factory).toHaveBeenLastCalledWith(
      thirdTarget,
      { generation: 3, operationId: expect.any(String) }
    )
    expect(latest.session.connect).toHaveBeenCalledTimes(1)
    expect(controller.getState().message).toBe('Running in /storage/emulated/0/Third')
  })

  it('serializes rapid resizes and coalesces pending bounds to the latest grid', async () => {
    const double = connectionDouble()
    const firstResize = deferredVoid()
    const latestResize = deferredVoid()
    double.session.resize
      .mockImplementationOnce(async () => firstResize.promise)
      .mockImplementationOnce(async () => latestResize.promise)
    const controller = new TabletClientController(() => double)
    await controller.connect(target)

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

  it('reports an unexpected process exit as an error and tears down idempotently', async () => {
    const double = connectionDouble()
    const controller = new TabletClientController(() => double)
    await controller.connect(target)

    double.processClose(new Error('process exited'))
    expect(controller.getState()).toMatchObject({
      phase: 'error',
      message: 'Neovim process stopped: process exited'
    })
    double.processClose(new Error('duplicate'))
    await controller.disconnect()
    await controller.disconnect()

    expect(double.session.close).toHaveBeenCalledTimes(1)
    expect(double.removeClose).toHaveBeenCalledTimes(1)
    expect(double.removeRedraw).toHaveBeenCalledTimes(1)
    expect(controller.getState().phase).toBe('disconnected')
  })

  it.each(['E_NVIM_START', 'E_NVIM_EXIT', 'E_NVIM_WRITE'])('preserves native process failure %s in controller state', async (code) => {
    const double = connectionDouble()
    const controller = new TabletClientController(() => double)
    await controller.connect(target)
    const failure = new Error('native process detail')
    failure.name = code

    double.processClose(failure)

    expect(controller.getState().connectionFailure).toEqual({
      code,
      nativeCode: code,
      message: 'native process detail',
      nativeMessage: 'native process detail'
    })
    await controller.dispose()
  })

  it('disposes an active session when the supported subtree unmounts', async () => {
    const double = connectionDouble()
    const controller = new TabletClientController(() => double)
    await controller.connect(target)

    await controller.dispose()
    await controller.dispose()

    expect(double.session.close).toHaveBeenCalledTimes(1)
    await expect(controller.connect(target)).rejects.toThrow('disposed')
  })
})
