package dev.codey.tcp

import android.os.Trace
import android.os.SystemClock
import java.io.IOException
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ThreadFactory
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

internal interface TcpEventSink {
  fun onData(
    connectionId: Int,
    bytes: ByteArray,
    receivedAtUptimeMs: Double,
    nativeDurationMs: Double
  )

  fun onClose(connectionId: Int, code: String? = null, message: String? = null)
}

internal data class TcpWriteMeasurement(
  val nativeEntryUptimeMs: Double,
  val lockWaitStartedAtUptimeMs: Double,
  val lockWaitDurationMs: Double,
  val socketWriteStartedAtUptimeMs: Double,
  val socketWriteDurationMs: Double
)

/**
 * Owns the socket lifecycle independently of React Native. Keeping the transport
 * here makes the concurrency and close semantics testable with ordinary JVM tests.
 */
internal class TcpClientManager(
  private val eventSink: TcpEventSink,
  private val uptimeMillis: () -> Double = ::tcpUptimeMillis,
  private val socketFactory: () -> Socket = { Socket() }
) {
  private val lifecycleLock = Any()
  private val connections = ConcurrentHashMap<Int, TcpConnection>()
  private val pendingSockets = mutableSetOf<Socket>()
  private val nextConnectionId = AtomicInteger(1)
  private val shutDown = AtomicBoolean(false)

  fun open(host: String, port: Int, timeoutMs: Int): Int {
    val normalizedHost = host.trim()
    require(normalizedHost.isNotEmpty()) { "TCP host must not be empty" }
    require(port in 1..65_535) { "TCP port must be between 1 and 65535" }
    require(timeoutMs >= 0) { "TCP timeout must be non-negative" }

    check(!shutDown.get()) { "TCP manager is shut down" }

    val socket = socketFactory()
    synchronized(lifecycleLock) {
      if (shutDown.get()) {
        runCatching { socket.close() }
        throw IllegalStateException("TCP manager is shut down")
      }
      pendingSockets += socket
    }

    val connectionId = allocateConnectionId()
    var registeredConnection: TcpConnection? = null
    try {
      socket.connect(InetSocketAddress(normalizedHost, port), timeoutMs)
      socket.tcpNoDelay = true

      val connection = TcpConnection(
        connectionId = connectionId,
        socket = socket,
        eventSink = eventSink,
        uptimeMillis = uptimeMillis,
        onTerminal = { terminalConnection ->
          connections.remove(terminalConnection.connectionId, terminalConnection)
        }
      )
      synchronized(lifecycleLock) {
        check(!shutDown.get()) { "TCP manager is shut down" }
        check(connections.putIfAbsent(connectionId, connection) == null) {
          "TCP connection ID collision"
        }
        registeredConnection = connection
        pendingSockets -= socket
        connection.startReading()
      }
      return connectionId
    } catch (error: Throwable) {
      synchronized(lifecycleLock) {
        pendingSockets -= socket
        registeredConnection?.let { connections.remove(connectionId, it) }
      }
      runCatching { socket.close() }
      throw error
    }
  }

  fun write(connectionId: Int, bytes: ByteArray) {
    val connection = connections[connectionId]
      ?: throw IllegalStateException("TCP connection $connectionId is not open")
    connection.write(bytes)
  }

  fun writeMeasured(
    connectionId: Int,
    bytes: ByteArray,
    nativeEntryUptimeMs: Double
  ): TcpWriteMeasurement {
    val connection = connections[connectionId]
      ?: throw IllegalStateException("TCP connection $connectionId is not open")
    return connection.writeMeasured(bytes, nativeEntryUptimeMs)
  }

  fun close(connectionId: Int) {
    connections[connectionId]?.close()
  }

  fun closeAll() {
    val socketsToClose: List<Socket>
    val connectionsToClose: List<TcpConnection>
    synchronized(lifecycleLock) {
      if (!shutDown.compareAndSet(false, true)) return
      socketsToClose = pendingSockets.toList()
      pendingSockets.clear()
      connectionsToClose = connections.values.toList()
    }

    socketsToClose.forEach { socket -> runCatching { socket.close() } }
    connectionsToClose.forEach(TcpConnection::close)
  }

  private fun allocateConnectionId(): Int {
    while (true) {
      val candidate = nextConnectionId.getAndUpdate { current ->
        if (current == Int.MAX_VALUE) 1 else current + 1
      }
      if (!connections.containsKey(candidate)) return candidate
    }
  }
}

private class TcpConnection(
  val connectionId: Int,
  private val socket: Socket,
  private val eventSink: TcpEventSink,
  private val uptimeMillis: () -> Double,
  private val onTerminal: (TcpConnection) -> Unit
) {
  private val terminal = AtomicBoolean(false)
  private val writeLock = Any()
  private val output: OutputStream = socket.getOutputStream()
  private val readerExecutor = Executors.newSingleThreadExecutor(
    namedDaemonThreadFactory("codey-tcp-reader-$connectionId")
  )

  fun startReading() {
    readerExecutor.execute {
      val buffer = ByteArray(16 * 1024)
      try {
        val input = socket.getInputStream()
        while (!terminal.get()) {
          val readStartedAtUptimeMs = uptimeMillis()
          val byteCount = traceSection("Codey/TCP/SocketRead") { input.read(buffer) }
          val readFinishedAtUptimeMs = uptimeMillis()
          if (byteCount < 0) {
            finish()
            return@execute
          }
          if (byteCount > 0 && !terminal.get()) {
            eventSink.onData(
              connectionId = connectionId,
              bytes = buffer.copyOf(byteCount),
              receivedAtUptimeMs = readFinishedAtUptimeMs,
              nativeDurationMs =
                (readFinishedAtUptimeMs - readStartedAtUptimeMs).coerceAtLeast(0.0)
            )
          }
        }
      } catch (error: SocketException) {
        if (!terminal.get()) finish("E_TCP_READ", error.message ?: "TCP socket closed unexpectedly")
      } catch (error: IOException) {
        finish("E_TCP_READ", error.message ?: "TCP read failed")
      } catch (error: RuntimeException) {
        finish("E_TCP_READ", error.message ?: "TCP read failed")
      }
    }
  }

  fun write(bytes: ByteArray) {
    check(!terminal.get()) { "TCP connection $connectionId is closed" }
    if (bytes.isEmpty()) return

    try {
      synchronized(writeLock) {
        check(!terminal.get()) { "TCP connection $connectionId is closed" }
        traceSection("Codey/TCP/SocketWrite") {
          output.apply {
            write(bytes)
            flush()
          }
        }
      }
    } catch (error: IOException) {
      if (!terminal.get()) {
        finish("E_TCP_WRITE", error.message ?: "TCP write failed")
      }
      throw error
    } catch (error: RuntimeException) {
      if (!terminal.get()) {
        finish("E_TCP_WRITE", error.message ?: "TCP write failed")
      }
      throw IOException(error.message ?: "TCP write failed", error)
    }
  }

  /** Diagnostics-only twin of [write]; ordinary writes avoid every clock read. */
  fun writeMeasured(
    bytes: ByteArray,
    nativeEntryUptimeMs: Double
  ): TcpWriteMeasurement {
    check(!terminal.get()) { "TCP connection $connectionId is closed" }
    if (bytes.isEmpty()) {
      val now = uptimeMillis()
      return TcpWriteMeasurement(nativeEntryUptimeMs, now, 0.0, now, 0.0)
    }

    val lockWaitStartedAtUptimeMs = uptimeMillis()
    try {
      synchronized(writeLock) {
        val lockAcquiredAtUptimeMs = uptimeMillis()
        check(!terminal.get()) { "TCP connection $connectionId is closed" }
        val socketWriteStartedAtUptimeMs = uptimeMillis()
        traceSection("Codey/TCP/SocketWrite") {
          output.apply {
            write(bytes)
            flush()
          }
        }
        val socketWriteFinishedAtUptimeMs = uptimeMillis()
        return TcpWriteMeasurement(
          nativeEntryUptimeMs = nativeEntryUptimeMs,
          lockWaitStartedAtUptimeMs = lockWaitStartedAtUptimeMs,
          lockWaitDurationMs =
            (lockAcquiredAtUptimeMs - lockWaitStartedAtUptimeMs).coerceAtLeast(0.0),
          socketWriteStartedAtUptimeMs = socketWriteStartedAtUptimeMs,
          socketWriteDurationMs =
            (socketWriteFinishedAtUptimeMs - socketWriteStartedAtUptimeMs).coerceAtLeast(0.0)
        )
      }
    } catch (error: IOException) {
      if (!terminal.get()) {
        finish("E_TCP_WRITE", error.message ?: "TCP write failed")
      }
      throw error
    } catch (error: RuntimeException) {
      if (!terminal.get()) {
        finish("E_TCP_WRITE", error.message ?: "TCP write failed")
      }
      throw IOException(error.message ?: "TCP write failed", error)
    }
  }

  fun close() {
    finish()
  }

  private fun finish(code: String? = null, message: String? = null) {
    if (!terminal.compareAndSet(false, true)) return

    runCatching { socket.close() }
    readerExecutor.shutdownNow()
    onTerminal(this)
    eventSink.onClose(connectionId, code, message)
  }
}

private fun namedDaemonThreadFactory(name: String): ThreadFactory = ThreadFactory { runnable ->
  Thread(runnable, name).apply { isDaemon = true }
}

/** Android performance.now() uses the uptime timebase, which excludes deep sleep. */
internal fun tcpUptimeMillis(
  androidUptimeMillis: () -> Long = { SystemClock.uptimeMillis() },
  fallbackNanos: () -> Long = { System.nanoTime() }
): Double = runCatching { androidUptimeMillis().toDouble() }
  .getOrElse { fallbackNanos() / 1_000_000.0 }

private inline fun <T> traceSection(name: String, callback: () -> T): T {
  val tracing = runCatching { Trace.beginSection(name) }.isSuccess
  return try {
    callback()
  } finally {
    if (tracing) runCatching { Trace.endSection() }
  }
}
