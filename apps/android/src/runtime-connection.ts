import { MessagePackRpcClient } from '@codey/msgpack-rpc'
import { NvimSessionClient } from '@codey/nvim-session'

import type { ConnectionFactory } from './controller'
import { ExpoNvimProcessTransport } from './transport/expo-nvim-process-transport'
import { ExpoTcpTransport } from './transport/expo-tcp-transport'

export const createRuntimeConnection: ConnectionFactory = (target) => {
  const transport = target.kind === 'local'
    ? new ExpoNvimProcessTransport({ workspacePath: target.workspacePath })
    : new ExpoTcpTransport({
        host: target.host,
        port: target.port,
        connectTimeoutMs: 8_000
      })
  const rpc = new MessagePackRpcClient(transport)
  const session = new NvimSessionClient(rpc)
  return { transport, session }
}
