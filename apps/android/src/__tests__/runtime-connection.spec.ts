import { MessagePackRpcClient } from '@codey/msgpack-rpc'
import { NvimSessionClient } from '@codey/nvim-session'

import { createRuntimeConnection } from '../runtime-connection'
import { ExpoNvimProcessTransport } from '../transport/expo-nvim-process-transport'
import { ExpoTcpTransport } from '../transport/expo-tcp-transport'

jest.mock('../transport/expo-nvim-process-transport', () => ({
  ExpoNvimProcessTransport: jest.fn(() => ({ transportKind: 'local' }))
}))

jest.mock('../transport/expo-tcp-transport', () => ({
  ExpoTcpTransport: jest.fn(() => ({ transportKind: 'remote' }))
}))

jest.mock('@codey/msgpack-rpc', () => ({
  MessagePackRpcClient: jest.fn((transport: unknown) => ({ transport }))
}))

jest.mock('@codey/nvim-session', () => ({
  NvimSessionClient: jest.fn((rpc: unknown) => ({ rpc }))
}))

describe('Android runtime connection selection', () => {
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
})
