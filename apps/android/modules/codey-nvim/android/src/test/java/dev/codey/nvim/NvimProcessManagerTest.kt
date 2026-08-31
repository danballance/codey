package dev.codey.nvim

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NvimProcessManagerTest {
  private val managers = mutableListOf<NvimProcessManager>()
  private val processes = mutableListOf<FakeProcess>()

  @After
  fun tearDown() {
    managers.forEach(NvimProcessManager::closeAll)
    processes.forEach { process -> if (process.isAlive) process.complete(137) }
  }

  @Test
  fun `moves arbitrary binary bytes over process streams`() {
    val process = FakeProcess().also(processes::add)
    val sink = RecordingSink(expectedBytes = 6)
    val manager = manager(sink) { process }
    val response = byteArrayOf(0, -1, 1, -128, 42, 7)
    val request = byteArrayOf(-1, 0, 127, -128, 13, 10)

    val sessionId = manager.start("/workspace")
    manager.write(sessionId, request)
    process.emitStdout(response.copyOfRange(0, 2))
    process.emitStdout(response.copyOfRange(2, response.size))

    assertTrue("stdout was not delivered", sink.dataReady.await(2, TimeUnit.SECONDS))
    assertArrayEquals(request, process.stdinBytes())
    assertArrayEquals(response, sink.receivedBytes())
    assertEquals(sessionId, sink.dataEvents.first().sessionId)

    manager.stop(sessionId)
    assertTrue("exit was not delivered", sink.exitReady.await(2, TimeUnit.SECONDS))
    assertNull(sink.exitEvents.single().code)
  }

  @Test
  fun `allows exactly one process and rejects stale writes`() {
    val first = FakeProcess().also(processes::add)
    val second = FakeProcess().also(processes::add)
    val launches = AtomicInteger(0)
    val sink = RecordingSink()
    val manager = manager(sink) {
      if (launches.getAndIncrement() == 0) first else second
    }

    val firstId = manager.start("/one")
    assertTrue(manager.isRunning)
    assertTrue(runCatching { manager.start("/two") }.isFailure)

    manager.stop(firstId)
    assertFalse(manager.isRunning)
    assertTrue(sink.exitReady.await(2, TimeUnit.SECONDS))
    manager.stop(firstId)
    assertTrue(runCatching { manager.write(firstId, byteArrayOf(1)) }.isFailure)

    val secondId = manager.start("/two")
    assertTrue(secondId > firstId)
    assertTrue(runCatching { manager.write(firstId, byteArrayOf(1)) }.isFailure)
    manager.stop(secondId)
  }

  @Test
  fun `keeps the final sixteen kibibytes of stderr`() {
    val process = FakeProcess().also(processes::add)
    val sink = RecordingSink()
    val manager = manager(sink) { process }
    val stderr = ByteArray(20 * 1024) { index -> ('a'.code + index % 26).toByte() }

    manager.start("/workspace")
    process.emitStderr(stderr)
    process.complete(23)

    assertTrue(sink.exitReady.await(2, TimeUnit.SECONDS))
    val event = sink.exitEvents.single()
    val expected = stderr.copyOfRange(stderr.size - 16 * 1024, stderr.size).toString(Charsets.UTF_8)
    assertEquals(expected, event.stderrTail)
    assertEquals("E_NVIM_EXIT", event.code)
    assertEquals(23, event.exitCode)
  }

  @Test
  fun `a write failure terminates the process with a stable code`() {
    val process = FakeProcess(
      ignoreGracefulDestroy = true,
      stdinFailure = IOException("synthetic broken pipe")
    )
      .also(processes::add)
    val sink = RecordingSink()
    val manager = manager(sink) { process }
    val sessionId = manager.start("/workspace")

    val error = runCatching { manager.write(sessionId, byteArrayOf(1)) }.exceptionOrNull()

    assertTrue(error is IOException)
    assertEquals("synthetic broken pipe", error?.message)
    assertTrue(sink.exitReady.await(2, TimeUnit.SECONDS))
    assertEquals("E_NVIM_WRITE", sink.exitEvents.single().code)
    assertEquals(1, process.destroyCalls.get())
    assertEquals(1, process.forceDestroyCalls.get())
  }

  @Test
  fun `stop escalates to forced termination and remains idempotent`() {
    val process = FakeProcess(ignoreGracefulDestroy = true).also(processes::add)
    val sink = RecordingSink()
    val manager = manager(sink, stopTimeoutMillis = 10) { process }
    val sessionId = manager.start("/workspace")

    manager.stop(sessionId)
    manager.stop(sessionId)

    assertTrue(sink.exitReady.await(2, TimeUnit.SECONDS))
    assertEquals(1, process.destroyCalls.get())
    assertEquals(1, process.forceDestroyCalls.get())
    assertNull(sink.exitEvents.single().code)
  }

  @Test
  fun `unexpected rpc eof is terminal even when process has not exited`() {
    val process = FakeProcess().also(processes::add)
    val sink = RecordingSink()
    val manager = manager(sink) { process }

    manager.start("/workspace")
    process.closeStdout()

    assertTrue(sink.exitReady.await(2, TimeUnit.SECONDS))
    assertEquals("E_NVIM_EXIT", sink.exitEvents.single().code)
    assertEquals("Local NeoVim closed its RPC stream", sink.exitEvents.single().message)
  }

  @Test
  fun `shutdown prevents future starts`() {
    val process = FakeProcess().also(processes::add)
    val manager = manager(RecordingSink()) { process }
    val sessionId = manager.start("/workspace")

    manager.closeAll()
    manager.closeAll()

    assertTrue(runCatching { manager.start("/workspace") }.isFailure)
    assertTrue(runCatching { manager.write(sessionId, byteArrayOf(1)) }.isFailure)
  }

  private fun manager(
    sink: RecordingSink,
    stopTimeoutMillis: Long = 50,
    launcher: () -> FakeProcess
  ): NvimProcessManager = NvimProcessManager(
    eventSink = sink,
    launchSpecProvider = { cwd -> NvimLaunchSpec(listOf("nvim"), java.io.File(cwd), emptyMap()) },
    processLauncher = NvimProcessLauncher { launcher() },
    stopTimeoutMillis = stopTimeoutMillis
  ).also(managers::add)

  private class RecordingSink(expectedBytes: Int = 0) : NvimEventSink {
    val dataEvents = CopyOnWriteArrayList<DataEvent>()
    val exitEvents = CopyOnWriteArrayList<ExitEvent>()
    val dataReady = CountDownLatch(if (expectedBytes > 0) 1 else 0)
    val exitReady = CountDownLatch(1)
    private val expectedByteCount = expectedBytes
    private val byteCount = AtomicInteger(0)

    override fun onData(sessionId: Int, bytes: ByteArray) {
      dataEvents += DataEvent(sessionId, bytes)
      if (byteCount.addAndGet(bytes.size) >= expectedByteCount) dataReady.countDown()
    }

    override fun onExit(
      sessionId: Int,
      exitCode: Int,
      stderrTail: String?,
      code: String?,
      message: String?
    ) {
      exitEvents += ExitEvent(sessionId, exitCode, stderrTail, code, message)
      exitReady.countDown()
    }

    fun receivedBytes(): ByteArray = ByteArrayOutputStream().also { output ->
      dataEvents.forEach { output.write(it.bytes) }
    }.toByteArray()
  }

  private data class DataEvent(val sessionId: Int, val bytes: ByteArray)

  private data class ExitEvent(
    val sessionId: Int,
    val exitCode: Int,
    val stderrTail: String?,
    val code: String?,
    val message: String?
  )

  private class FakeProcess(
    private val ignoreGracefulDestroy: Boolean = false,
    stdinFailure: IOException? = null
  ) : Process() {
    private val stdoutInput = PipedInputStream(64 * 1024)
    private val stdoutOutput = PipedOutputStream(stdoutInput)
    private val stderrInput = PipedInputStream(64 * 1024)
    private val stderrOutput = PipedOutputStream(stderrInput)
    private val stdin = RecordingOutputStream(stdinFailure)
    private val completed = CountDownLatch(1)
    private val completedFlag = AtomicBoolean(false)
    private val exitCode = AtomicInteger(Int.MIN_VALUE)
    val destroyCalls = AtomicInteger(0)
    val forceDestroyCalls = AtomicInteger(0)

    override fun getOutputStream(): OutputStream = stdin

    override fun getInputStream(): InputStream = stdoutInput

    override fun getErrorStream(): InputStream = stderrInput

    override fun waitFor(): Int {
      completed.await()
      return exitCode.get()
    }

    override fun waitFor(timeout: Long, unit: TimeUnit): Boolean = completed.await(timeout, unit)

    override fun exitValue(): Int {
      if (completed.count > 0) throw IllegalThreadStateException("still running")
      return exitCode.get()
    }

    override fun destroy() {
      destroyCalls.incrementAndGet()
      if (!ignoreGracefulDestroy) complete(143)
    }

    override fun destroyForcibly(): Process {
      forceDestroyCalls.incrementAndGet()
      complete(137)
      return this
    }

    override fun isAlive(): Boolean = completed.count > 0

    fun emitStdout(bytes: ByteArray) {
      stdoutOutput.write(bytes)
      stdoutOutput.flush()
    }

    fun closeStdout() {
      stdoutOutput.close()
    }

    fun emitStderr(bytes: ByteArray) {
      stderrOutput.write(bytes)
      stderrOutput.flush()
    }

    fun stdinBytes(): ByteArray = stdin.toByteArray()

    fun complete(code: Int) {
      if (!completedFlag.compareAndSet(false, true)) return
      exitCode.set(code)
      runCatching { stdoutOutput.close() }
      runCatching { stderrOutput.close() }
      completed.countDown()
    }
  }

  private class RecordingOutputStream(private val failure: IOException?) : OutputStream() {
    private val output = ByteArrayOutputStream()

    @Synchronized
    override fun write(value: Int) {
      failure?.let { throw it }
      output.write(value)
    }

    @Synchronized
    override fun write(bytes: ByteArray, offset: Int, length: Int) {
      failure?.let { throw it }
      output.write(bytes, offset, length)
    }

    @Synchronized
    fun toByteArray(): ByteArray = output.toByteArray()
  }
}
