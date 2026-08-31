package dev.codey.nvim

import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

internal data class NvimLaunchSpec(
  val command: List<String>,
  val workingDirectory: File,
  val environment: Map<String, String>
)

internal fun interface NvimProcessLauncher {
  fun launch(spec: NvimLaunchSpec): Process
}

internal object ProcessBuilderNvimLauncher : NvimProcessLauncher {
  override fun launch(spec: NvimLaunchSpec): Process {
    require(spec.command.isNotEmpty()) { "NeoVim command must not be empty" }
    val builder = ProcessBuilder(spec.command)
      .directory(spec.workingDirectory)
      .redirectErrorStream(false)
    builder.environment().putAll(spec.environment)
    return builder.start()
  }
}

internal interface NvimEventSink {
  fun onData(sessionId: Int, bytes: ByteArray)

  fun onExit(
    sessionId: Int,
    exitCode: Int,
    stderrTail: String? = null,
    code: String? = null,
    message: String? = null
  )
}

/**
 * Owns the one-process NeoVim lifecycle independently from React Native.
 *
 * stdout is reserved for MessagePack-RPC. stderr is drained separately into a
 * bounded diagnostic tail so a noisy child cannot block or exhaust memory.
 */
internal class NvimProcessManager(
  private val eventSink: NvimEventSink,
  private val launchSpecProvider: (String) -> NvimLaunchSpec,
  private val processLauncher: NvimProcessLauncher = ProcessBuilderNvimLauncher,
  private val stopTimeoutMillis: Long = DEFAULT_STOP_TIMEOUT_MILLIS
) {
  private val lifecycleLock = Any()
  private val nextSessionId = AtomicInteger(1)
  private var activeSession: NvimProcessSession? = null
  private var highestAllocatedSessionId = 0
  private var shutDown = false

  val isRunning: Boolean
    get() = synchronized(lifecycleLock) { activeSession != null }

  fun start(cwd: String): Int {
    synchronized(lifecycleLock) {
      check(!shutDown) { "NeoVim process manager is shut down" }
      check(activeSession == null) { "A local NeoVim process is already running" }

      val launchSpec = launchSpecProvider(cwd)
      val process = try {
        processLauncher.launch(launchSpec)
      } catch (error: IOException) {
        throw IOException("Unable to start local NeoVim: ${error.message ?: "process launch failed"}", error)
      }

      val sessionId = allocateSessionId()
      highestAllocatedSessionId = sessionId
      val session = NvimProcessSession(
        sessionId = sessionId,
        process = process,
        eventSink = eventSink,
        stopTimeoutMillis = stopTimeoutMillis,
        onTerminal = { terminalSession ->
          synchronized(lifecycleLock) {
            if (activeSession === terminalSession) activeSession = null
          }
        }
      )
      activeSession = session
      session.startReading()
      return sessionId
    }
  }

  fun write(sessionId: Int, bytes: ByteArray) {
    sessionFor(sessionId).write(bytes)
  }

  /** Idempotent for a session that was already allocated and has since exited. */
  fun stop(sessionId: Int) {
    val session = synchronized(lifecycleLock) {
      val active = activeSession
      when {
        active?.sessionId == sessionId -> active
        sessionId in 1..highestAllocatedSessionId -> null
        else -> throw IllegalStateException("NeoVim session $sessionId was not started by this manager")
      }
    }
    session?.stop()
  }

  fun closeAll() {
    val session = synchronized(lifecycleLock) {
      if (shutDown) return
      shutDown = true
      activeSession
    }
    session?.stop()
  }

  private fun sessionFor(sessionId: Int): NvimProcessSession = synchronized(lifecycleLock) {
    activeSession?.takeIf { it.sessionId == sessionId }
      ?: throw IllegalStateException("NeoVim session $sessionId is not running")
  }

  private fun allocateSessionId(): Int {
    while (true) {
      val candidate = nextSessionId.getAndUpdate { current ->
        if (current == Int.MAX_VALUE) 1 else current + 1
      }
      if (candidate > 0) return candidate
    }
  }

  private companion object {
    const val DEFAULT_STOP_TIMEOUT_MILLIS = 750L
  }
}

private data class NvimTerminalFailure(val code: String, val message: String)

private class NvimProcessSession(
  val sessionId: Int,
  private val process: Process,
  private val eventSink: NvimEventSink,
  private val stopTimeoutMillis: Long,
  private val onTerminal: (NvimProcessSession) -> Unit
) {
  private val terminal = AtomicBoolean(false)
  private val stopping = AtomicBoolean(false)
  private val terminationRequested = AtomicBoolean(false)
  private val writeLock = Any()
  private val terminalFailure = AtomicReference<NvimTerminalFailure?>()
  private val stderrTail = BoundedByteTail(STDERR_TAIL_BYTES)
  private val readersDrained = CountDownLatch(2)
  private val terminalReady = CountDownLatch(1)
  private val stdoutExecutor = Executors.newSingleThreadExecutor(
    namedDaemonThreadFactory("codey-nvim-stdout-$sessionId")
  )
  private val stderrExecutor = Executors.newSingleThreadExecutor(
    namedDaemonThreadFactory("codey-nvim-stderr-$sessionId")
  )
  private val waiterExecutor = Executors.newSingleThreadExecutor(
    namedDaemonThreadFactory("codey-nvim-waiter-$sessionId")
  )
  private val output: OutputStream = process.outputStream

  fun startReading() {
    stdoutExecutor.execute(::drainStdout)
    stderrExecutor.execute(::drainStderr)
    waiterExecutor.execute {
      val exitCode = try {
        process.waitFor()
      } catch (error: InterruptedException) {
        Thread.currentThread().interrupt()
        terminalFailure.compareAndSet(
          null,
          NvimTerminalFailure("E_NVIM_EXIT", "Interrupted while waiting for local NeoVim")
        )
        runCatching { process.destroyForcibly() }
        runCatching { process.waitFor() }.getOrDefault(-1)
      } catch (error: RuntimeException) {
        terminalFailure.compareAndSet(
          null,
          NvimTerminalFailure("E_NVIM_EXIT", error.message ?: "Unable to observe local NeoVim exit")
        )
        -1
      }
      try {
        readersDrained.await(READER_DRAIN_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)
      } catch (error: InterruptedException) {
        Thread.currentThread().interrupt()
      }
      finish(exitCode)
    }
  }

  fun write(bytes: ByteArray) {
    check(!terminal.get() && !stopping.get()) { "NeoVim session $sessionId is closed" }
    if (bytes.isEmpty()) return

    try {
      synchronized(writeLock) {
        check(!terminal.get() && !stopping.get()) { "NeoVim session $sessionId is closed" }
        output.write(bytes)
        output.flush()
      }
    } catch (error: IOException) {
      failAndTerminate("E_NVIM_WRITE", error.message ?: "Unable to write to local NeoVim")
      throw error
    } catch (error: RuntimeException) {
      failAndTerminate("E_NVIM_WRITE", error.message ?: "Unable to write to local NeoVim")
      throw IOException(error.message ?: "Unable to write to local NeoVim", error)
    }
  }

  fun stop() {
    if (terminalReady.count == 0L) return
    if (!terminal.get() && stopping.compareAndSet(false, true)) {
      runCatching { output.close() }
      terminateProcess()
    }

    val stopped = try {
      terminalReady.await(
        stopTimeoutMillis + READER_DRAIN_TIMEOUT_MILLIS + STOP_COMPLETION_MARGIN_MILLIS,
        TimeUnit.MILLISECONDS
      )
    } catch (error: InterruptedException) {
      Thread.currentThread().interrupt()
      throw IllegalStateException("Interrupted while stopping local NeoVim", error)
    }
    check(stopped) { "Timed out waiting for local NeoVim to stop" }
  }

  private fun terminateProcess() {
    if (!terminationRequested.compareAndSet(false, true)) return

    runCatching { process.destroy() }
    val exited = try {
      process.waitFor(stopTimeoutMillis, TimeUnit.MILLISECONDS)
    } catch (error: InterruptedException) {
      Thread.currentThread().interrupt()
      false
    } catch (_: RuntimeException) {
      false
    }
    if (!exited) runCatching { process.destroyForcibly() }
  }

  private fun drainStdout() {
    val buffer = ByteArray(STREAM_BUFFER_BYTES)
    try {
      while (!terminal.get()) {
        val byteCount = process.inputStream.read(buffer)
        if (byteCount < 0) {
          if (!terminal.get() && !stopping.get()) {
            failAndTerminate("E_NVIM_EXIT", "Local NeoVim closed its RPC stream")
          }
          return
        }
        if (byteCount > 0 && !terminal.get()) {
          eventSink.onData(sessionId, buffer.copyOf(byteCount))
        }
      }
    } catch (error: IOException) {
      if (!terminal.get() && !stopping.get()) {
        failAndTerminate("E_NVIM_EXIT", error.message ?: "Unable to read local NeoVim stdout")
      }
    } catch (error: RuntimeException) {
      if (!terminal.get() && !stopping.get()) {
        failAndTerminate("E_NVIM_EXIT", error.message ?: "Unable to read local NeoVim stdout")
      }
    } finally {
      readersDrained.countDown()
    }
  }

  private fun drainStderr() {
    val buffer = ByteArray(STREAM_BUFFER_BYTES)
    try {
      while (!terminal.get()) {
        val byteCount = process.errorStream.read(buffer)
        if (byteCount < 0) return
        if (byteCount > 0) stderrTail.append(buffer, byteCount)
      }
    } catch (error: IOException) {
      if (!terminal.get() && !stopping.get()) {
        failAndTerminate("E_NVIM_EXIT", error.message ?: "Unable to read local NeoVim stderr")
      }
    } catch (error: RuntimeException) {
      if (!terminal.get() && !stopping.get()) {
        failAndTerminate("E_NVIM_EXIT", error.message ?: "Unable to read local NeoVim stderr")
      }
    } finally {
      readersDrained.countDown()
    }
  }

  private fun failAndTerminate(code: String, message: String) {
    terminalFailure.compareAndSet(null, NvimTerminalFailure(code, message))
    terminateProcess()
  }

  private fun finish(exitCode: Int) {
    if (!terminal.compareAndSet(false, true)) return

    runCatching { output.close() }
    runCatching { process.inputStream.close() }
    runCatching { process.errorStream.close() }
    stdoutExecutor.shutdownNow()
    stderrExecutor.shutdownNow()
    waiterExecutor.shutdown()
    try {
      onTerminal(this)
    } finally {
      terminalReady.countDown()
    }

    val failure = terminalFailure.get()
      ?: if (!stopping.get() && exitCode != 0) {
        NvimTerminalFailure("E_NVIM_EXIT", "Local NeoVim exited with status $exitCode")
      } else {
        null
      }
    val stderr = stderrTail.asUtf8String().takeIf(String::isNotBlank)
    eventSink.onExit(
      sessionId = sessionId,
      exitCode = exitCode,
      stderrTail = stderr,
      code = failure?.code,
      message = failure?.message
    )
  }

  private companion object {
    const val STREAM_BUFFER_BYTES = 16 * 1024
    const val STDERR_TAIL_BYTES = 16 * 1024
    const val READER_DRAIN_TIMEOUT_MILLIS = 500L
    const val STOP_COMPLETION_MARGIN_MILLIS = 250L
  }
}

internal class BoundedByteTail(private val capacity: Int) {
  init {
    require(capacity > 0) { "Tail capacity must be positive" }
  }

  private var bytes = ByteArray(capacity)
  private var size = 0

  @Synchronized
  fun append(source: ByteArray, length: Int = source.size) {
    require(length in 0..source.size) { "Tail append length is out of bounds" }
    if (length == 0) return

    if (length >= capacity) {
      source.copyInto(bytes, 0, length - capacity, length)
      size = capacity
      return
    }

    val overflow = (size + length - capacity).coerceAtLeast(0)
    if (overflow > 0) {
      bytes.copyInto(bytes, 0, overflow, size)
      size -= overflow
    }
    source.copyInto(bytes, size, 0, length)
    size += length
  }

  @Synchronized
  fun toByteArray(): ByteArray = bytes.copyOf(size)

  fun asUtf8String(): String = String(toByteArray(), StandardCharsets.UTF_8)
}

private fun namedDaemonThreadFactory(name: String): ThreadFactory = ThreadFactory { runnable ->
  Thread(runnable, name).apply { isDaemon = true }
}
