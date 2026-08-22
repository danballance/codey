import type { RedrawBatch } from '@codey/nvim-session'
import type { DuplexTransport } from '@codey/transport'

import {
  TabletClientController,
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

describe('TabletClientController', () => {
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

  it('publishes a renderer snapshot only after a redraw flush', async () => {
    const double = connectionDouble()
    const controller = new TabletClientController(() => double)
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
    expect(controller.getState().snapshot?.grid?.cells.map((cell) => cell.text)).toEqual([
      'A',
      '界'
    ])
    expect(listener).toHaveBeenCalledTimes(1)
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
