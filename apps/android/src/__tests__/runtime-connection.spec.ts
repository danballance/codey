import { MessagePackRpcClient } from '@codey/msgpack-rpc'
import { NvimSessionClient } from '@codey/nvim-session'

import { createRuntimeConnection } from '../runtime-connection'
import { diagnosticLogger } from '../diagnostics/logger'
import { attachDiagnosticCause, markDiagnosticOrigin } from '../diagnostics/origin'
import { ExpoNvimProcessTransport } from '../transport/expo-nvim-process-transport'
import { ExpoTcpTransport } from '../transport/expo-tcp-transport'

jest.mock('../transport/expo-nvim-process-transport', () => ({
  ExpoNvimProcessTransport: jest.fn(() => ({ transportKind: 'local' }))
}))

jest.mock('../transport/expo-tcp-transport', () => ({
  ExpoTcpTransport: jest.fn(() => ({ transportKind: 'remote' }))
}))

let mockRpcErrorListener: ((error: Error) => void) | undefined
let mockRpcNotificationListener: ((method: string, params: unknown) => void) | undefined
const mockRemoveRpcError = jest.fn()
const mockRemoveRpcNotification = jest.fn()
let mockNotificationRegistrationFailure: Error | undefined

jest.mock('@codey/msgpack-rpc', () => ({
  MessagePackRpcClient: jest.fn((transport: unknown) => ({
    transport,
    onError: jest.fn((listener: (error: Error) => void) => {
      mockRpcErrorListener = listener
      return mockRemoveRpcError
    }),
    onNotification: jest.fn((listener: (method: string, params: unknown) => void) => {
      if (mockNotificationRegistrationFailure !== undefined) {
        throw mockNotificationRegistrationFailure
      }
      mockRpcNotificationListener = listener
      return mockRemoveRpcNotification
    })
  }))
}))

jest.mock('@codey/nvim-session', () => ({
  NvimSessionClient: jest.fn((rpc: unknown) => ({ rpc })),
  isRedrawBatch: jest.fn((params: unknown) => params === 'valid-redraw')
}))

describe('Android runtime connection selection', () => {
  beforeEach(() => {
    diagnosticLogger.clear()
    mockRpcErrorListener = undefined
    mockRpcNotificationListener = undefined
    mockNotificationRegistrationFailure = undefined
  })

  it('builds the shared RPC/session stack over the local process transport', () => {
    const resources = createRuntimeConnection({
      kind: 'local',
      workspacePath: '/storage/emulated/0/Code'
    })

    expect(ExpoNvimProcessTransport).toHaveBeenCalledWith({
      workspacePath: '/storage/emulated/0/Code'
    })
    expect(ExpoTcpTransport).not.toHaveBeenCalled()
    expect(MessagePackRpcClient).toHaveBeenCalledWith(resources.transport)
    expect(NvimSessionClient).toHaveBeenCalledWith(expect.objectContaining({
      transport: resources.transport
    }))
  })

  it('keeps remote targets on the TCP transport', () => {
    const resources = createRuntimeConnection({
      kind: 'remote',
      host: 'nvim.test',
      port: 7777
    })

    expect(ExpoTcpTransport).toHaveBeenCalledWith({
      host: 'nvim.test',
      port: 7777,
      connectTimeoutMs: 8_000
    })
    expect(ExpoNvimProcessTransport).not.toHaveBeenCalled()
    expect(MessagePackRpcClient).toHaveBeenCalledWith(resources.transport)
  })

  it('records RPC and malformed-redraw failures, skips transport-origin duplicates, and disposes once', () => {
    const resources = createRuntimeConnection({
      kind: 'remote',
      host: 'nvim.test',
      port: 7777
    }, { generation: 4, operationId: 'connection-4' })

    const rpcFailure = new Error('RPC parser failed')
    mockRpcErrorListener?.(rpcFailure)
    mockRpcNotificationListener?.('redraw', 'valid-redraw')
    mockRpcNotificationListener?.('redraw', { raw: ['malformed', 42] })
    mockRpcNotificationListener?.('unrelated', { raw: true })

    const transportFailure = new Error('socket failed')
    markDiagnosticOrigin(transportFailure, 'transport.tcp.write')
    const wrapped = attachDiagnosticCause(new Error('RPC wrapped transport failure'), transportFailure)
    mockRpcErrorListener?.(wrapped)

    expect(diagnosticLogger.getSnapshot().entries.map(({ event }) => event)).toEqual([
      'rpc.error',
      'rpc.redraw.malformed'
    ])
    expect(diagnosticLogger.getSnapshot().entries[0]).toMatchObject({
      operationId: 'connection-4',
      details: expect.objectContaining({
        generation: 4,
        error: expect.objectContaining({ message: 'RPC parser failed' })
      })
    })
    expect(diagnosticLogger.getSnapshot().entries[1]?.details).toMatchObject({
      params: { raw: ['malformed', 42] }
    })

    resources.disposeDiagnostics?.()
    resources.disposeDiagnostics?.()
    expect(mockRemoveRpcError).toHaveBeenCalledTimes(1)
    expect(mockRemoveRpcNotification).toHaveBeenCalledTimes(1)

    mockRpcErrorListener?.(new Error('late RPC failure'))
    mockRpcNotificationListener?.('redraw', { late: true })
    expect(diagnosticLogger.getSnapshot().entries).toHaveLength(2)
  })

  it('rolls back an earlier RPC observer when later registration fails', () => {
    mockNotificationRegistrationFailure = new Error('notification observer unavailable')

    expect(() => createRuntimeConnection({
      kind: 'remote',
      host: 'nvim.test',
      port: 7777
    }, { generation: 2, operationId: 'connection-2' })).toThrow(
      'notification observer unavailable'
    )

    expect(mockRemoveRpcError).toHaveBeenCalledTimes(1)
    expect(mockRemoveRpcNotification).not.toHaveBeenCalled()
    expect(diagnosticLogger.getSnapshot().entries.at(-1)).toMatchObject({
      category: 'rpc',
      event: 'rpc.observer_registration_failed',
      operationId: 'connection-2'
    })
  })
})
