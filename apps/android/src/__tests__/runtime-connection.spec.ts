import { MessagePackRpcClient } from '@codey/msgpack-rpc'
import { NvimSessionClient } from '@codey/nvim-session'

import { createRuntimeConnection } from '../runtime-connection'
import { diagnosticLogger } from '../diagnostics/logger'
import { attachDiagnosticCause, markDiagnosticOrigin } from '../diagnostics/origin'
import { ExpoNvimProcessTransport } from '../transport/expo-nvim-process-transport'

jest.mock('../transport/expo-nvim-process-transport', () => ({
  ExpoNvimProcessTransport: jest.fn(() => ({ transportKind: 'local' }))
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

describe('Android local runtime connection', () => {
  beforeEach(() => {
    diagnosticLogger.clear()
    mockRpcErrorListener = undefined
    mockRpcNotificationListener = undefined
    mockNotificationRegistrationFailure = undefined
  })

  it('builds the shared RPC/session stack over the local process transport', () => {
    const resources = createRuntimeConnection({
      version: 1,
      workspacePath: '/storage/emulated/0/Code',
      configDirectory: '/storage/emulated/0/Codey'
    })

    expect(ExpoNvimProcessTransport).toHaveBeenCalledWith({
      workspacePath: '/storage/emulated/0/Code',
      configDirectory: '/storage/emulated/0/Codey'
    })
    expect(MessagePackRpcClient).toHaveBeenCalledWith(resources.transport)
    expect(NvimSessionClient).toHaveBeenCalledWith(expect.objectContaining({
      transport: resources.transport
    }))
  })

  it('rejects a local runtime connection without a config folder', () => {
    expect(() => createRuntimeConnection({
      version: 1,
      workspacePath: '/storage/emulated/0/Code',
      configDirectory: null
    })).toThrow('Choose a Neovim config folder')
    expect(ExpoNvimProcessTransport).not.toHaveBeenCalled()
  })

  it('records RPC and malformed-redraw failures, skips transport-origin duplicates, and disposes once', () => {
    const resources = createRuntimeConnection({
      version: 1,
      workspacePath: '/storage/emulated/0/Code',
      configDirectory: '/storage/emulated/0/Codey'
    }, { generation: 4, operationId: 'connection-4' })

    const rpcFailure = new Error('RPC parser failed')
    mockRpcErrorListener?.(rpcFailure)
    mockRpcNotificationListener?.('redraw', 'valid-redraw')
    mockRpcNotificationListener?.('redraw', ['private-redraw-text', 42])
    mockRpcNotificationListener?.('unrelated', { raw: true })

    const transportFailure = new Error('process pipe failed')
    markDiagnosticOrigin(transportFailure, 'transport.local.write')
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
      parameterCount: 2
    })
    expect(JSON.stringify(diagnosticLogger.getSnapshot())).not.toContain('private-redraw-text')

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
      version: 1,
      workspacePath: '/storage/emulated/0/Code',
      configDirectory: '/storage/emulated/0/Codey'
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
