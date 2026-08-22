package dev.codey.tcp

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketAddress
import java.net.SocketException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class TcpClientManagerTest {
  private val managers = mutableListOf<TcpClientManager>()
  private val servers = mutableListOf<ServerSocket>()

  @After
  fun tearDown() {
    managers.forEach(TcpClientManager::closeAll)
    servers.forEach { runCatching { it.close() } }
  }

  @Test
  fun `moves arbitrary binary bytes in both directions`() {
    val server = ServerSocket(0).also(servers::add)
    val receivedByServer = ByteArrayOutputStream()
    val serverDone = CountDownLatch(1)
    val response = byteArrayOf(0, -1, 1, -128, 42, 0, 7)
    val request = byteArrayOf(-1, 0, 127, -128, 13, 10)

    daemonThread("codey-tcp-test-binary") {
      server.accept().use { socket ->
        val input = socket.getInputStream()
        while (receivedByServer.size() < request.size) {
          val next = input.read()
          if (next < 0) break
          receivedByServer.write(next)
        }
        socket.getOutputStream().apply {
          write(response, 0, 3)
          flush()
          write(response, 3, response.size - 3)
          flush()
        }
      }
      serverDone.countDown()
    }

    val sink = RecordingSink(expectedBytes = response.size)
    val manager = TcpClientManager(sink).also(managers::add)
    val connectionId = manager.open("127.0.0.1", server.localPort, 2_000)

    manager.write(connectionId, request)

    assertTrue("server did not finish", serverDone.await(2, TimeUnit.SECONDS))
    assertTrue("client did not receive response", sink.dataReady.await(2, TimeUnit.SECONDS))
    assertTrue("client did not observe remote close", sink.closeReady.await(2, TimeUnit.SECONDS))
    assertArrayEquals(request, receivedByServer.toByteArray())
    assertArrayEquals(response, sink.receivedBytes())
    assertEquals(connectionId, sink.dataEvents.first().first)
    assertEquals(1, sink.closeEvents.size)
  }

  @Test
  fun `read delivery timing uses the injected uptime clock`() {
    val payload = byteArrayOf(7, 8, 9)
    val socket = SingleReadSocket(payload)
    val times = doubleArrayOf(100.0, 103.5, 104.0, 104.0)
    val clockIndex = AtomicInteger(0)
    val sink = RecordingSink(expectedBytes = payload.size)
    val manager = TcpClientManager(
      eventSink = sink,
      uptimeMillis = { times[clockIndex.getAndIncrement().coerceAtMost(times.lastIndex)] },
      socketFactory = { socket }
    ).also(managers::add)

    manager.open("127.0.0.1", 1, 2_000)

    assertTrue("client did not receive payload", sink.dataReady.await(2, TimeUnit.SECONDS))
    assertEquals(103.5, sink.dataTimings.single().first, 0.0)
    assertEquals(3.5, sink.dataTimings.single().second, 0.0)
  }

  @Test
  fun `uptime helper uses Android uptime and converts its JVM fallback`() {
    assertEquals(
      42.0,
      tcpUptimeMillis(androidUptimeMillis = { 42L }, fallbackNanos = { error("unused") }),
      0.0
    )
    assertEquals(
      7.5,
      tcpUptimeMillis(
        androidUptimeMillis = { error("Android clock unavailable") },
        fallbackNanos = { 7_500_000L }
      ),
      0.0
    )
  }

  @Test
  fun `writes are observed in invocation order`() {
    val server = ServerSocket(0).also(servers::add)
    val received = ByteArrayOutputStream()
    val serverDone = CountDownLatch(1)
    val expected = ByteArray(100) { it.toByte() }

    daemonThread("codey-tcp-test-order") {
      server.accept().use { socket ->
        repeat(expected.size) { received.write(socket.getInputStream().read()) }
      }
      serverDone.countDown()
    }

    val manager = TcpClientManager(RecordingSink()).also(managers::add)
    val connectionId = manager.open("127.0.0.1", server.localPort, 2_000)
    expected.forEach { byte -> manager.write(connectionId, byteArrayOf(byte)) }

    assertTrue("server did not receive writes", serverDone.await(2, TimeUnit.SECONDS))
    assertArrayEquals(expected, received.toByteArray())
  }

  @Test
  fun `write stays on its caller thread reuses the stream and does not copy payload`() {
    val socket = InspectableWriteSocket()
    val manager = TcpClientManager(RecordingSink()) { socket }.also(managers::add)
    val connectionId = manager.open("127.0.0.1", 1, 2_000)
    val payload = byteArrayOf(1, 2, 3, 4)
    val callingThread = Thread.currentThread()

    manager.write(connectionId, payload)
    manager.write(connectionId, byteArrayOf(5))

    assertSame(payload, socket.firstPayload.get())
    assertSame(callingThread, socket.writeThread.get())
    assertEquals(1, socket.outputStreamRequests.get())
  }

  @Test
  fun `measured write separates native entry lock wait and socket write timing`() {
    val socket = InspectableWriteSocket()
    val writeTimes = doubleArrayOf(11.0, 13.0, 17.0, 22.0)
    val writeClockIndex = AtomicInteger(0)
    val manager = TcpClientManager(
      eventSink = RecordingSink(),
      uptimeMillis = {
        if (Thread.currentThread().name.startsWith("codey-tcp-reader")) 1.0
        else writeTimes[writeClockIndex.getAndIncrement()]
      },
      socketFactory = { socket }
    ).also(managers::add)
    val connectionId = manager.open("127.0.0.1", 1, 2_000)
    val payload = byteArrayOf(1, 2, 3)

    val measurement = manager.writeMeasured(
      connectionId = connectionId,
      bytes = payload,
      nativeEntryUptimeMs = 7.0
    )
    // The ordinary path must continue to perform no diagnostic clock reads.
    manager.write(connectionId, byteArrayOf(4))

    assertSame(payload, socket.firstPayload.get())
    assertEquals(4, writeClockIndex.get())
    assertEquals(7.0, measurement.nativeEntryUptimeMs, 0.0)
    assertEquals(11.0, measurement.lockWaitStartedAtUptimeMs, 0.0)
    assertEquals(2.0, measurement.lockWaitDurationMs, 0.0)
    assertEquals(17.0, measurement.socketWriteStartedAtUptimeMs, 0.0)
    assertEquals(5.0, measurement.socketWriteDurationMs, 0.0)
  }

  @Test
  fun `write failure emits one terminal close and preserves its error`() {
    val socket = InspectableWriteSocket(IOException("synthetic broken pipe"))
    val sink = RecordingSink()
    val manager = TcpClientManager(sink) { socket }.also(managers::add)
    val connectionId = manager.open("127.0.0.1", 1, 2_000)

    val failure = runCatching { manager.write(connectionId, byteArrayOf(1)) }.exceptionOrNull()
    manager.close(connectionId)

    assertTrue(failure is IOException)
    assertEquals("synthetic broken pipe", failure?.message)
    assertTrue(sink.closeReady.await(2, TimeUnit.SECONDS))
    assertEquals(1, sink.closeEvents.size)
    assertEquals("E_TCP_WRITE", sink.closeEvents.single().code)
  }

  @Test
  fun `read failure emits one terminal close`() {
    val socket = FailingReadSocket()
    val sink = RecordingSink()
    val manager = TcpClientManager(sink) { socket }.also(managers::add)
    val connectionId = manager.open("127.0.0.1", 1, 2_000)

    assertTrue(sink.closeReady.await(2, TimeUnit.SECONDS))
    manager.close(connectionId)

    assertEquals(1, sink.closeEvents.size)
    assertEquals("E_TCP_READ", sink.closeEvents.single().code)
  }

  @Test
  fun `close is idempotent and emits one clean terminal event`() {
    val server = ServerSocket(0).also(servers::add)
    val accepted = CountDownLatch(1)
    daemonThread("codey-tcp-test-close") {
      server.accept().use { socket ->
        accepted.countDown()
        while (socket.getInputStream().read() >= 0) Unit
      }
    }

    val sink = RecordingSink()
    val manager = TcpClientManager(sink).also(managers::add)
    val connectionId = manager.open("127.0.0.1", server.localPort, 2_000)
    assertTrue(accepted.await(2, TimeUnit.SECONDS))

    manager.close(connectionId)
    manager.close(connectionId)
    manager.close(connectionId + 10_000)

    assertTrue(sink.closeReady.await(2, TimeUnit.SECONDS))
    assertEquals(1, sink.closeEvents.size)
    assertEquals(connectionId, sink.closeEvents.single().connectionId)
    assertNull(sink.closeEvents.single().code)
    assertNull(sink.closeEvents.single().message)
  }

  @Test
  fun `close interrupts a stalled write and still emits one terminal event`() {
    val socket = BlockingWriteSocket()
    val sink = RecordingSink()
    val manager = TcpClientManager(sink) { socket }.also(managers::add)
    val connectionId = manager.open("127.0.0.1", 1, 2_000)
    val writeDone = CountDownLatch(1)
    val writeError = AtomicReference<Throwable?>()

    daemonThread("codey-tcp-test-stalled-write") {
      try {
        manager.write(connectionId, byteArrayOf(1, 2, 3))
      } catch (error: Throwable) {
        writeError.set(error)
      } finally {
        writeDone.countDown()
      }
    }

    assertTrue("write did not stall", socket.writeStarted.await(2, TimeUnit.SECONDS))
    manager.close(connectionId)

    assertTrue("close event was not emitted", sink.closeReady.await(2, TimeUnit.SECONDS))
    assertTrue("stalled write was not interrupted", writeDone.await(2, TimeUnit.SECONDS))
    assertTrue("stalled write unexpectedly succeeded", writeError.get() != null)
    assertEquals(1, sink.closeEvents.size)
  }

  @Test
  fun `shutdown closes a pending connect and prevents late registration`() {
    val socket = BlockingConnectSocket()
    val sink = RecordingSink()
    val manager = TcpClientManager(sink) { socket }.also(managers::add)
    val openDone = CountDownLatch(1)
    val openError = AtomicReference<Throwable?>()

    daemonThread("codey-tcp-test-pending-open") {
      try {
        manager.open("127.0.0.1", 1, 60_000)
      } catch (error: Throwable) {
        openError.set(error)
      } finally {
        openDone.countDown()
      }
    }

    assertTrue("connect did not start", socket.connectStarted.await(2, TimeUnit.SECONDS))
    manager.closeAll()

    assertTrue("pending socket was not closed", socket.closed.await(2, TimeUnit.SECONDS))
    assertTrue("pending open did not terminate", openDone.await(2, TimeUnit.SECONDS))
    assertTrue("pending open unexpectedly succeeded", openError.get() != null)
    assertTrue("an unpublished connection emitted close", sink.closeEvents.isEmpty())
    assertTrue(
      "manager accepted an open after shutdown",
      runCatching { manager.open("127.0.0.1", 1, 1) }.isFailure
    )
  }

  private class RecordingSink(expectedBytes: Int = 0) : TcpEventSink {
    val dataEvents = CopyOnWriteArrayList<Pair<Int, ByteArray>>()
    val dataTimings = CopyOnWriteArrayList<Pair<Double, Double>>()
    val closeEvents = CopyOnWriteArrayList<CloseEvent>()
    val dataReady = CountDownLatch(if (expectedBytes > 0) 1 else 0)
    val closeReady = CountDownLatch(1)
    private val byteCount = java.util.concurrent.atomic.AtomicInteger(0)
    private val expectedByteCount = expectedBytes

    override fun onData(
      connectionId: Int,
      bytes: ByteArray,
      receivedAtUptimeMs: Double,
      nativeDurationMs: Double
    ) {
      dataEvents += connectionId to bytes
      dataTimings += receivedAtUptimeMs to nativeDurationMs
      if (byteCount.addAndGet(bytes.size) >= expectedByteCount) dataReady.countDown()
    }

    override fun onClose(connectionId: Int, code: String?, message: String?) {
      closeEvents += CloseEvent(connectionId, code, message)
      closeReady.countDown()
    }

    fun receivedBytes(): ByteArray = ByteArrayOutputStream().also { output ->
      dataEvents.forEach { output.write(it.second) }
    }.toByteArray()
  }

  private data class CloseEvent(
    val connectionId: Int,
    val code: String?,
    val message: String?
  )

  private class BlockingWriteSocket : Socket() {
    val writeStarted = CountDownLatch(1)
    private val closed = CountDownLatch(1)
    private val terminal = AtomicBoolean(false)

    override fun connect(endpoint: SocketAddress, timeout: Int) = Unit

    override fun setTcpNoDelay(on: Boolean) = Unit

    override fun getInputStream(): InputStream = object : InputStream() {
      override fun read(): Int {
        awaitTerminal()
        throw SocketException("socket closed")
      }
    }

    override fun getOutputStream(): OutputStream = object : OutputStream() {
      override fun write(value: Int) {
        blockWrite()
      }

      override fun write(bytes: ByteArray, offset: Int, length: Int) {
        blockWrite()
      }
    }

    override fun close() {
      if (terminal.compareAndSet(false, true)) closed.countDown()
    }

    private fun blockWrite() {
      writeStarted.countDown()
      awaitTerminal()
      throw SocketException("socket closed")
    }

    private fun awaitTerminal() {
      try {
        closed.await()
      } catch (error: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    }
  }

  private class BlockingConnectSocket : Socket() {
    val connectStarted = CountDownLatch(1)
    val closed = CountDownLatch(1)

    override fun connect(endpoint: SocketAddress, timeout: Int) {
      connectStarted.countDown()
      try {
        closed.await()
      } catch (error: InterruptedException) {
        Thread.currentThread().interrupt()
      }
      throw SocketException("socket closed")
    }

    override fun close() {
      closed.countDown()
    }
  }

  private class InspectableWriteSocket(
    private val writeFailure: IOException? = null
  ) : Socket() {
    val outputStreamRequests = AtomicInteger(0)
    val firstPayload = AtomicReference<ByteArray?>()
    val writeThread = AtomicReference<Thread?>()
    private val closed = CountDownLatch(1)
    private val terminal = AtomicBoolean(false)
    private val output = object : OutputStream() {
      override fun write(value: Int) {
        write(byteArrayOf(value.toByte()), 0, 1)
      }

      override fun write(bytes: ByteArray, offset: Int, length: Int) {
        firstPayload.compareAndSet(null, bytes)
        writeThread.compareAndSet(null, Thread.currentThread())
        writeFailure?.let { throw it }
      }
    }

    override fun connect(endpoint: SocketAddress, timeout: Int) = Unit

    override fun setTcpNoDelay(on: Boolean) = Unit

    override fun getInputStream(): InputStream = object : InputStream() {
      override fun read(): Int {
        awaitClose()
        return -1
      }
    }

    override fun getOutputStream(): OutputStream {
      outputStreamRequests.incrementAndGet()
      return output
    }

    override fun close() {
      if (terminal.compareAndSet(false, true)) closed.countDown()
    }

    private fun awaitClose() {
      try {
        closed.await()
      } catch (error: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    }
  }

  private class FailingReadSocket : Socket() {
    override fun connect(endpoint: SocketAddress, timeout: Int) = Unit

    override fun setTcpNoDelay(on: Boolean) = Unit

    override fun getInputStream(): InputStream = object : InputStream() {
      override fun read(): Int = throw IOException("synthetic read failure")
    }

    override fun getOutputStream(): OutputStream = ByteArrayOutputStream()
  }

  private class SingleReadSocket(private val payload: ByteArray) : Socket() {
    private val read = AtomicBoolean(false)

    override fun connect(endpoint: SocketAddress, timeout: Int) = Unit

    override fun setTcpNoDelay(on: Boolean) = Unit

    override fun getInputStream(): InputStream = object : InputStream() {
      override fun read(): Int = -1

      override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
        if (!read.compareAndSet(false, true)) return -1
        payload.copyInto(bytes, destinationOffset = offset)
        return payload.size
      }
    }

    override fun getOutputStream(): OutputStream = ByteArrayOutputStream()
  }

  private fun daemonThread(name: String, block: () -> Unit) {
    Thread({ block() }, name).apply {
      isDaemon = true
      start()
    }
  }
}
