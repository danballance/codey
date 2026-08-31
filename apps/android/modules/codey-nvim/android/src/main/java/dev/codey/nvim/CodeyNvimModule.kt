package dev.codey.nvim

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

class CodeyNvimModule : Module() {
  private val ioScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val nvimRuntimeDelegate = lazy {
    val context = checkNotNull(appContext.reactContext) {
      "CodeyNvim requires an attached Android application context"
    }
    AndroidNvimRuntime(context)
  }
  private val nvimRuntime by nvimRuntimeDelegate
  private val managerDelegate = lazy {
    NvimProcessManager(
      eventSink = object : NvimEventSink {
        override fun onData(sessionId: Int, bytes: ByteArray) {
          this@CodeyNvimModule.sendEvent(
            "data",
            mapOf("sessionId" to sessionId, "bytes" to bytes)
          )
        }

        override fun onExit(
          sessionId: Int,
          exitCode: Int,
          stderrTail: String?,
          code: String?,
          message: String?
        ) {
          val payload = mutableMapOf<String, Any>(
            "sessionId" to sessionId,
            "exitCode" to exitCode
          )
          if (stderrTail != null) payload["stderrTail"] = stderrTail
          if (code != null) payload["code"] = code
          if (message != null) payload["message"] = message
          this@CodeyNvimModule.sendEvent("exit", payload)
        }
      },
      // Keep runtime/context resolution deferred so an otherwise-unused module
      // can still be destroyed safely after React context teardown.
      launchSpecProvider = { cwd -> nvimRuntime.prepare(cwd) }
    )
  }
  private val manager by managerDelegate

  override fun definition() = ModuleDefinition {
    Name("CodeyNvim")

    Events("data", "exit")

    AsyncFunction("getStatus") {
      val status = nvimRuntime.status(managerDelegate.value.isRunning)
      buildMap<String, Any> {
        put("supported", status.supported)
        put("running", status.running)
        put("allFilesAccess", status.allFilesAccess)
        status.unavailableReason?.let { put("unavailableReason", it) }
      }
    }.runOnQueue(ioScope)

    AsyncFunction("openAllFilesSettings") {
      nvimRuntime.openAllFilesSettings()
    }

    AsyncFunction("start") { cwd: String ->
      manager.start(cwd)
    }.runOnQueue(ioScope)

    AsyncFunction("write") { sessionId: Int, bytes: ByteArray ->
      manager.write(sessionId, bytes)
    }.runOnQueue(ioScope)

    AsyncFunction("stop") { sessionId: Int ->
      manager.stop(sessionId)
    }.runOnQueue(ioScope)

    OnDestroy {
      // Instantiate the manager to close the race with an already queued start.
      manager.closeAll()
      ioScope.cancel()
    }
  }
}
