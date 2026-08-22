package dev.codey.tcp

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

class CodeyTcpModule : Module() {
  private val openScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val writeScope = CoroutineScope(
    SupervisorJob() + Dispatchers.IO.limitedParallelism(1)
  )
  private val managerDelegate = lazy {
    TcpClientManager(
      eventSink = object : TcpEventSink {
        override fun onData(connectionId: Int, bytes: ByteArray) {
          this@CodeyTcpModule.sendEvent(
            "data",
            mapOf(
              "connectionId" to connectionId,
              "bytes" to bytes
            )
          )
        }

        override fun onClose(connectionId: Int, code: String?, message: String?) {
          val payload = mutableMapOf<String, Any>("connectionId" to connectionId)
          if (code != null) payload["code"] = code
          if (message != null) payload["message"] = message
          this@CodeyTcpModule.sendEvent("close", payload)
        }
      }
    )
  }
  private val manager by managerDelegate

  override fun definition() = ModuleDefinition {
    Name("CodeyTcp")

    Events("data", "close")

    AsyncFunction("open") { host: String, port: Int, timeoutMs: Int ->
      manager.open(host, port, timeoutMs)
    }.runOnQueue(openScope)

    AsyncFunction("write") { connectionId: Int, bytes: ByteArray ->
      manager.write(connectionId, bytes)
    }.runOnQueue(writeScope)

    AsyncFunction("close") { connectionId: Int ->
      manager.close(connectionId)
    }

    OnDestroy {
      // Initializing an otherwise-unused manager is intentional: it closes the
      // race where an open coroutine starts just after an isInitialized check.
      manager.closeAll()
      openScope.cancel()
      writeScope.cancel()
    }
  }
}
