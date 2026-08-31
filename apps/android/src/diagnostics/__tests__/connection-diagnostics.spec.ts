import type { HostDocument, HostDocumentWrite, MouseInput, RedrawBatch } from '@codey/nvim-session'
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
  type ConnectionDiagnosticContext,
  type ConnectionFactory,
  type FrameScheduler,
  type MobileSession
} from '../../controller'
import type { ConnectionTarget } from '../../connection-target'
import {
  createDiagnosticLogger,
  type DiagnosticConsole,
  type DiagnosticLogger
} from '../logger'

const target = Object.freeze({
  kind: 'remote',
  host: 'nvim.test',
  port: 7777
}) satisfies ConnectionTarget

function createConsole(): jest.Mocked<DiagnosticConsole> {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}

function createLogger(): DiagnosticLogger {
  let id = 0
  return createDiagnosticLogger({
    console: createConsole(),
    now: () => 1_700_000_000_000,
    elapsedNow: () => 100,
    idGenerator: () => `diagnostic-${id++}`
  })
}

function connectionDouble() {
  let redrawListener: ((batch: RedrawBatch) => void) | undefined
  let closeListener: ((error?: Error) => void) | undefined
  const removeRedraw = jest.fn()
  const removeClose = jest.fn()
  const disposeDiagnostics = jest.fn()
  const session = {
    connect: jest.fn(async () => undefined),
    attach: jest.fn(async (_width: number, _height: number) => undefined),
    input: jest.fn(async (_keys: string) => undefined),
    inputMouse: jest.fn(async (_mouse: MouseInput) => undefined),
    resize: jest.fn(async (_width: number, _height: number) => undefined),
    defaultActionPadPath: jest.fn(async () => '/tmp/action-pad.yaml'),
    readHostDocument: jest.fn(async (path: string): Promise<HostDocument> => ({
      path,
      resolvedPath: path,
      text: null,
      revision: null
    })),
    writeHostDocument: jest.fn(async (request: HostDocumentWrite): Promise<HostDocument> => ({
      path: request.path,
      resolvedPath: request.path,
      text: request.text,
      revision: 'saved'
    })),
    onRedraw: jest.fn((listener: (batch: RedrawBatch) => void) => {
      redrawListener = listener
      return removeRedraw
    }),
    close: jest.fn(async () => undefined)
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
    resources: { transport, session, disposeDiagnostics },
    transport,
    session,
    removeRedraw,
    removeClose,
    disposeDiagnostics,
    redraw(batch: RedrawBatch) {
      redrawListener?.(batch)
    },
    remoteClose(error?: Error) {
      closeListener?.(error)
    }
  }
}

function frameSchedulerDouble() {
  let nextHandle = 1
  const pending = new Map<number, (timestampMs: number) => void>()
  const scheduler = {
    request: jest.fn((callback: (timestampMs: number) => void) => {
      const handle = nextHandle++
      pending.set(handle, callback)
      return handle
    }),
    cancel: jest.fn((handle: number) => {
      pending.delete(handle)
    })
  } satisfies FrameScheduler

  return {
    scheduler,
    advance(timestampMs = 16) {
      const callbacks = Array.from(pending.values())
      pending.clear()
      for (const callback of callbacks) callback(timestampMs)
    }
  }
}

function factoryFor(
  double: ReturnType<typeof connectionDouble>,
  contexts: ConnectionDiagnosticContext[]
): ConnectionFactory {
  return (_target, diagnostics) => {
    if (diagnostics !== undefined) contexts.push(diagnostics)
    return double.resources
  }
}

describe('connection operational diagnostics', () => {
  afterEach(() => {
    configurePerformanceDiagnostics({ enabled: false })
    clearPerformanceRecords()
  })

  it('passes generation and operation identity to the factory and correlates successful lifecycle entries', async () => {
    const logger = createLogger()
    const double = connectionDouble()
    const contexts: ConnectionDiagnosticContext[] = []
    const factory = jest.fn(factoryFor(double, contexts))
    const frames = frameSchedulerDouble()
    const controller = new TabletClientController(factory, frames.scheduler, logger)

    await controller.connect(target)

    expect(contexts).toHaveLength(1)
    expect(contexts[0]).toEqual({
      generation: 1,
      operationId: expect.any(String)
    })
    expect(factory).toHaveBeenCalledWith(target, contexts[0])
    const operationId = contexts[0]?.operationId
    const connectionEntries = logger.getSnapshot().entries
    expect(connectionEntries.map((entry) => entry.event)).toEqual([
      'connection.connect.started',
      'connection.resources.created',
      'connection.session.connected',
      'connection.session.attached',
      'connection.connect.succeeded'
    ])
    expect(connectionEntries.every((entry) => entry.operationId === operationId)).toBe(true)
    expect(connectionEntries[0]?.detailsText).toContain('"generation": 1')
    expect(connectionEntries.at(-1)).toMatchObject({
      level: 'info',
      operationId
    })

    await controller.disconnect()
    expect(double.removeRedraw).toHaveBeenCalledTimes(1)
    expect(double.removeClose).toHaveBeenCalledTimes(1)
    expect(double.disposeDiagnostics).toHaveBeenCalledTimes(1)
    await controller.dispose()
    expect(double.disposeDiagnostics).toHaveBeenCalledTimes(1)
  })

  it('correlates connection failure and releases diagnostic observers while detaching', async () => {
    const logger = createLogger()
    const double = connectionDouble()
    const failure = new Error('attach rejected')
    double.session.attach.mockRejectedValueOnce(failure)
    const contexts: ConnectionDiagnosticContext[] = []
    const controller = new TabletClientController(
      factoryFor(double, contexts),
      frameSchedulerDouble().scheduler,
      logger
    )

    await controller.connect(target)

    const operationId = contexts[0]?.operationId
    expect(logger.getSnapshot().entries.map((entry) => entry.event)).toEqual([
      'connection.connect.started',
      'connection.resources.created',
      'connection.session.connected',
      'connection.connect.failed'
    ])
    expect(logger.getSnapshot().entries.every((entry) => entry.operationId === operationId)).toBe(true)
    expect(logger.getSnapshot().entries.at(-1)).toMatchObject({
      level: 'error',
      operationId
    })
    expect(logger.getSnapshot().entries.at(-1)?.detailsText).toContain('attach rejected')
    expect(controller.getState().phase).toBe('error')
    expect(double.disposeDiagnostics).toHaveBeenCalledTimes(1)
    await controller.dispose()
  })

  it('keeps successful input, mouse, redraw, renderer, and performance traffic out of the operational ring', async () => {
    configurePerformanceDiagnostics({ enabled: true, capacity: 32, log: false })
    const logger = createLogger()
    const double = connectionDouble()
    const contexts: ConnectionDiagnosticContext[] = []
    const frames = frameSchedulerDouble()
    const controller = new TabletClientController(
      factoryFor(double, contexts),
      frames.scheduler,
      logger
    )
    await controller.connect(target)
    const lifecycleSnapshot = logger.getSnapshot()
    const inputSample = createPerformanceInputSample(10)

    await withPerformanceTags(
      { ...inputSample, source: 'hardware' },
      () => controller.input('ihello<Esc>')
    )
    await controller.inputMouse({
      button: 'left',
      action: 'press',
      modifier: '',
      gridId: 1,
      row: 0,
      column: 0
    })
    double.redraw([
      ['grid_resize', [1, 2, 1]],
      ['grid_line', [1, 0, 0, [['A', 0], ['B', 0]]]],
      ['flush', []]
    ])
    frames.advance()

    expect(double.session.input).toHaveBeenCalledWith('ihello<Esc>')
    expect(double.session.inputMouse).toHaveBeenCalledTimes(1)
    expect(controller.getState().snapshot?.flushCount).toBe(1)
    expect(getPerformanceRecords().length).toBeGreaterThan(0)
    expect(logger.getSnapshot()).toBe(lifecycleSnapshot)

    double.session.input.mockRejectedValueOnce(new Error('input transport rejected'))
    await controller.input('x')
    const failureEntry = logger.getSnapshot().entries.at(-1)
    expect(failureEntry).toMatchObject({
      level: 'error',
      category: 'ime',
      event: 'input.write_failed',
      operationId: contexts[0]?.operationId
    })
    expect(failureEntry?.detailsText).toContain('input transport rejected')
    expect(logger.getSnapshot().entries).toHaveLength(lifecycleSnapshot.entries.length + 1)
    await controller.dispose()
  })

  it('records mouse-write failure without logging successful mouse traffic', async () => {
    const logger = createLogger()
    const double = connectionDouble()
    const contexts: ConnectionDiagnosticContext[] = []
    const controller = new TabletClientController(
      factoryFor(double, contexts),
      frameSchedulerDouble().scheduler,
      logger
    )
    await controller.connect(target)
    const lifecycleCount = logger.getSnapshot().entries.length

    await controller.inputMouse({ button: 'left', action: 'press', row: 1, column: 1 })
    expect(logger.getSnapshot().entries).toHaveLength(lifecycleCount)
    double.session.inputMouse.mockRejectedValueOnce(new Error('mouse transport rejected'))
    await controller.inputMouse({ button: 'right', action: 'press', row: 2, column: 2 })

    expect(logger.getSnapshot().entries).toHaveLength(lifecycleCount + 1)
    expect(logger.getSnapshot().entries.at(-1)).toMatchObject({
      level: 'error',
      category: 'ime',
      event: 'mouse.write_failed',
      operationId: contexts[0]?.operationId
    })
    await controller.dispose()
  })

  it.each(['redraw', 'transport-close'] as const)(
    'fails connection setup and releases partial resources when %s observer registration throws',
    async (observer) => {
      const logger = createLogger()
      const double = connectionDouble()
      const registrationFailure = new Error(`${observer} registration failed`)
      if (observer === 'redraw') {
        double.session.onRedraw.mockImplementationOnce(() => { throw registrationFailure })
      } else {
        double.transport.onClose.mockImplementationOnce(() => { throw registrationFailure })
      }
      const controller = new TabletClientController(
        () => double.resources,
        frameSchedulerDouble().scheduler,
        logger
      )

      await expect(controller.connect(target)).resolves.toBeUndefined()

      expect(controller.getState()).toMatchObject({
        phase: 'error',
        message: `${observer} registration failed`
      })
      expect(double.session.connect).not.toHaveBeenCalled()
      expect(double.session.close).toHaveBeenCalledTimes(1)
      expect(double.disposeDiagnostics).toHaveBeenCalledTimes(1)
      expect(double.removeRedraw).toHaveBeenCalledTimes(observer === 'redraw' ? 0 : 1)
      expect(double.removeClose).not.toHaveBeenCalled()
      expect(logger.getSnapshot().entries.filter(
        (entry) => entry.event === 'connection.connect.failed'
      )).toHaveLength(1)
      expect(logger.getSnapshot().entries.some(
        (entry) => entry.event === 'connection.connect.succeeded'
      )).toBe(false)
      await controller.dispose()
    }
  )

  it('continues setup-failure cleanup when releasing a diagnostic observer also throws', async () => {
    const logger = createLogger()
    const double = connectionDouble()
    double.transport.onClose.mockImplementationOnce(() => {
      throw new Error('close observer registration failed')
    })
    double.disposeDiagnostics.mockImplementationOnce(() => {
      throw new Error('diagnostic observer release failed')
    })
    const controller = new TabletClientController(
      () => double.resources,
      frameSchedulerDouble().scheduler,
      logger
    )

    await controller.connect(target)

    expect(double.removeRedraw).toHaveBeenCalledTimes(1)
    expect(double.session.close).toHaveBeenCalledTimes(1)
    expect(logger.getSnapshot().entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'connection.connect.failed', level: 'error' }),
      expect.objectContaining({ event: 'connection.observer_detach_failed', level: 'warn' })
    ]))
    expect(controller.getState().phase).toBe('error')
    await controller.dispose()
  })

  it.each(['disconnect', 'dispose'] as const)(
    'reports %s as failed when session cleanup rejects while leaving a safe terminal state',
    async (action) => {
      const logger = createLogger()
      const double = connectionDouble()
      const controller = new TabletClientController(
        () => double.resources,
        frameSchedulerDouble().scheduler,
        logger
      )
      await controller.connect(target)
      double.session.close.mockRejectedValueOnce(new Error('session cleanup rejected'))

      await expect(action === 'disconnect' ? controller.disconnect() : controller.dispose())
        .resolves.toBeUndefined()

      const operationEvent = action === 'disconnect'
        ? 'connection.disconnect'
        : 'connection.controller_dispose'
      expect(logger.getSnapshot().entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: 'connection.cleanup_failed', level: 'warn' }),
        expect.objectContaining({ event: `${operationEvent}.failed`, level: 'error' })
      ]))
      expect(logger.getSnapshot().entries.some(
        (entry) => entry.event === `${operationEvent}.succeeded`
      )).toBe(false)
      expect(controller.getState()).toMatchObject({
        phase: 'disconnected',
        message: action === 'disconnect' ? 'Disconnected' : 'Disposed',
        snapshot: null
      })
      expect(double.removeRedraw).toHaveBeenCalledTimes(1)
      expect(double.removeClose).toHaveBeenCalledTimes(1)
      expect(double.disposeDiagnostics).toHaveBeenCalledTimes(1)
      if (action === 'disconnect') await controller.dispose()
    }
  )

  it('fails a reconnect before constructing resources when prior session cleanup is unsafe', async () => {
    const logger = createLogger()
    const first = connectionDouble()
    const second = connectionDouble()
    const factory = jest.fn()
      .mockReturnValueOnce(first.resources)
      .mockReturnValueOnce(second.resources)
    const controller = new TabletClientController(
      factory,
      frameSchedulerDouble().scheduler,
      logger
    )
    await controller.connect(target)
    first.session.close.mockRejectedValueOnce(new Error('old session cleanup rejected'))

    await expect(controller.connect({ ...target, port: 8888 })).resolves.toBeUndefined()

    expect(factory).toHaveBeenCalledTimes(1)
    expect(second.session.connect).not.toHaveBeenCalled()
    expect(controller.getState()).toMatchObject({
      phase: 'error',
      message: 'old session cleanup rejected'
    })
    expect(logger.getSnapshot().entries.filter(
      (entry) => entry.event === 'connection.connect.started'
    )).toHaveLength(2)
    expect(logger.getSnapshot().entries.filter(
      (entry) => entry.event === 'connection.connect.failed'
    )).toHaveLength(1)
    expect(logger.getSnapshot().entries.at(-1)).toMatchObject({
      event: 'connection.connect.failed',
      level: 'error'
    })
    await controller.dispose()
  })
})
