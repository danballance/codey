import { MessagePackRpcClient } from '@codey/msgpack-rpc'
import { NvimSessionClient, isRedrawBatch } from '@codey/nvim-session'

import type { ConnectionFactory } from './controller'
import { requireConfigDirectory } from './connection-target'
import { diagnosticLogger } from './diagnostics/logger'
import { diagnosticOriginOf, markDiagnosticOrigin } from './diagnostics/origin'
import { ExpoNvimProcessTransport } from './transport/expo-nvim-process-transport'
import { ExpoTcpTransport } from './transport/expo-tcp-transport'

export const createRuntimeConnection: ConnectionFactory = (target, diagnostics) => {
  const transport = target.kind === 'local'
    ? diagnostics === undefined
      ? new ExpoNvimProcessTransport({
          workspacePath: target.workspacePath,
          configDirectory: requireConfigDirectory(target.configDirectory)
        })
      : new ExpoNvimProcessTransport(
          {
            workspacePath: target.workspacePath,
            configDirectory: requireConfigDirectory(target.configDirectory)
          },
          undefined,
          diagnosticLogger,
          diagnostics
        )
    : diagnostics === undefined
      ? new ExpoTcpTransport({
          host: target.host,
          port: target.port,
          connectTimeoutMs: 8_000
        })
      : new ExpoTcpTransport(
          {
            host: target.host,
            port: target.port,
            connectTimeoutMs: 8_000
          },
          undefined,
          diagnosticLogger,
          diagnostics
        )
  const rpc = new MessagePackRpcClient(transport)
  const observerDisposers: Array<() => void> = []
  let diagnosticsActive = true
  const disposeDiagnostics = (): void => {
    if (!diagnosticsActive) return
    diagnosticsActive = false
    for (const dispose of observerDisposers.splice(0).reverse()) {
      try {
        dispose()
      } catch (reason) {
        diagnosticLogger.warn({
          category: 'rpc',
          event: 'rpc.observer_disposal_failed',
          message: 'Failed to release an RPC diagnostic observer',
          operationId: diagnostics?.operationId,
          details: { ...diagnostics, reason }
        })
      }
    }
  }

  let session: NvimSessionClient
  try {
    if (typeof rpc.onError === 'function') {
      const remove = rpc.onError((error) => {
        if (!diagnosticsActive || diagnosticOriginOf(error) !== undefined) return
        markDiagnosticOrigin(error, 'rpc.client')
        diagnosticLogger.error({
          category: 'rpc',
          event: 'rpc.error',
          message: 'MessagePack-RPC reported an operational error',
          operationId: diagnostics?.operationId,
          details: { ...diagnostics, error }
        })
      })
      if (typeof remove === 'function') observerDisposers.push(remove)
    }
    if (typeof rpc.onNotification === 'function') {
      const remove = rpc.onNotification((method, params) => {
        if (!diagnosticsActive || method !== 'redraw' || isRedrawBatch(params)) return
        diagnosticLogger.error({
          category: 'rpc',
          event: 'rpc.redraw.malformed',
          message: 'Ignored a malformed Neovim redraw notification',
          operationId: diagnostics?.operationId,
          details: { ...diagnostics, method, params }
        })
      })
      if (typeof remove === 'function') observerDisposers.push(remove)
    }
    session = new NvimSessionClient(rpc)
  } catch (reason) {
    disposeDiagnostics()
    const error = reason instanceof Error
      ? reason
      : new Error('Failed to install RPC diagnostics', { cause: reason })
    markDiagnosticOrigin(error, 'rpc.observer.registration')
    diagnosticLogger.error({
      category: 'rpc',
      event: 'rpc.observer_registration_failed',
      message: 'Failed to install RPC diagnostics',
      operationId: diagnostics?.operationId,
      details: { ...diagnostics, error }
    })
    throw error
  }
  return {
    transport,
    session,
    disposeDiagnostics
  }
}
