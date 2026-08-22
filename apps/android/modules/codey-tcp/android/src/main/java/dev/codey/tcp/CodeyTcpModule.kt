package dev.codey.tcp

import android.os.Trace
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

class CodeyTcpModule : Module() {
  private val ioScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val managerDelegate = lazy {
    TcpClientManager(
      eventSink = object : TcpEventSink {
        override fun onData(
          connectionId: Int,
          bytes: ByteArray,
          receivedAtUptimeMs: Double,
          nativeDurationMs: Double
        ) {
          this@CodeyTcpModule.sendEvent(
            "data",
            mapOf(
              "connectionId" to connectionId,
              "bytes" to bytes,
              "receivedAtUptimeMs" to receivedAtUptimeMs,
              "nativeDurationMs" to nativeDurationMs
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
    }.runOnQueue(ioScope)

    AsyncFunction("write") { connectionId: Int, bytes: ByteArray ->
      Trace.beginSection("Codey/TCP/NativeWrite")
      try {
        manager.write(connectionId, bytes)
      } finally {
        Trace.endSection()
      }
    }.runOnQueue(ioScope)

    AsyncFunction("writeMeasured") { connectionId: Int, bytes: ByteArray ->
      val nativeEntryUptimeMs = tcpUptimeMillis()
      Trace.beginSection("Codey/TCP/NativeWriteMeasured")
      try {
        val measurement = manager.writeMeasured(connectionId, bytes, nativeEntryUptimeMs)
        mapOf(
          "nativeEntryUptimeMs" to measurement.nativeEntryUptimeMs,
          "lockWaitStartedAtUptimeMs" to measurement.lockWaitStartedAtUptimeMs,
          "lockWaitDurationMs" to measurement.lockWaitDurationMs,
          "socketWriteStartedAtUptimeMs" to measurement.socketWriteStartedAtUptimeMs,
          "socketWriteDurationMs" to measurement.socketWriteDurationMs
        )
      } finally {
        Trace.endSection()
      }
    }.runOnQueue(ioScope)

    AsyncFunction("close") { connectionId: Int ->
      manager.close(connectionId)
    }

    OnDestroy {
      // Initializing an otherwise-unused manager is intentional: it closes the
      // race where an open coroutine starts just after an isInitialized check.
      manager.closeAll()
      ioScope.cancel()
    }
  }
}
