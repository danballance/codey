import { MessagePackRpcClient } from '@codey/msgpack-rpc'
import { NvimSessionClient } from '@codey/nvim-session'

import type { ConnectionFactory } from './controller'
import { ExpoTcpTransport } from './transport/expo-tcp-transport'

export const createRuntimeConnection: ConnectionFactory = (endpoint) => {
  const transport = new ExpoTcpTransport({
    host: endpoint.host,
    port: endpoint.port,
    connectTimeoutMs: 8_000
  })
  const rpc = new MessagePackRpcClient(transport)
  const session = new NvimSessionClient(rpc)
  return { transport, session }
}
