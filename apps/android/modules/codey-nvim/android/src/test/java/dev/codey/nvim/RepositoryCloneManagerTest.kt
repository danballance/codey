package dev.codey.nvim

import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.nio.file.Files
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.io.path.createTempDirectory
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class RepositoryCloneManagerTest {
  private val root = createTempDirectory("codey-clone-test-").toFile().canonicalFile
  private val parent = File(root, "shared/Projects with spaces").apply { mkdirs() }
  private val journal = File(root, "private/journal")
  private val managers = mutableListOf<RepositoryCloneManager>()
  private val progress = CopyOnWriteArrayList<Pair<String, String>>()

  @After
  fun tearDown() {
    managers.forEach(RepositoryCloneManager::close)
    root.deleteRecursively()
  }

  @Test
  fun `normalizes only public GitHub repository inputs`() {
    listOf(
      "owner/project", "https://github.com/owner/project", "https://github.com/owner/project.git/",
      "  HTTPS://GITHUB.COM/owner/project/  "
    ).forEach { assertEquals("https://github.com/owner/project.git", canonicalGitHubRepository(it)) }
    listOf(
      "", "git@github.com:owner/project.git", "http://github.com/owner/project",
      "https://user:secret@github.com/owner/project", "https://github.com:443/owner/project",
      "https://github.com/owner/project?token=secret", "https://github.com/owner/project#branch",
      "https://github.com/owner/project/tree/main", "https://elsewhere.test/owner/project",
      "https://github.com/owner/%2E%2E", "owner/..", "../project", "-owner/project",
      "owner-/project", "owner/project\nignored", "owner\\project"
    ).forEach { value -> assertThrows(value, IllegalArgumentException::class.java) { canonicalGitHubRepository(value) } }
  }

  @Test
  fun `directory names cannot escape destination or impersonate staging`() {
    assertEquals("My project", validateCloneDirectoryName(" My project "))
    listOf("", ".", "..", "../escape", "a/b", "a\\b", "a\u0000b", ".codey-clone-owned", "x".repeat(101))
      .forEach { value -> assertThrows(IllegalArgumentException::class.java) { validateCloneDirectoryName(value) } }
  }

  @Test
  fun `successful clone preserves command alias and promotes only workspace`() {
    var command: List<String>? = null
    val manager = manager { args, directory, environment ->
      command = args
      assertEquals(parent, directory)
      assertEquals(mapOf("GIT_ALLOW_PROTOCOL" to "https"), environment)
      val repository = File(args[3]).apply { mkdirs() }
      File(repository, "README.md").writeText("cloned")
      Files.move(repository.toPath(), File(args[4]).toPath())
      File(args[5]).writeText("success")
      FakeProcess().apply { complete(0) }
    }

    val result = manager.cloneRepository("success", "owner/repo", parent.path, "My repo")

    assertEquals("success", result.status)
    assertEquals(File(parent, "My repo").path, result.path)
    assertEquals("cloned", File(result.path, "README.md").readText())
    assertEquals("/native/libcodey_exec_dispatcher.so", command!![0])
    assertEquals("--codey-clone", command!![1])
    assertEquals("/private/commands/git", command!![2])
    assertEquals("https://github.com/owner/repo.git", command!![6])
    assertFalse(manager.isCloning)
    assertTrue(journal.listFiles().orEmpty().isEmpty())
    assertEquals(listOf("My repo"), parent.listFiles().orEmpty().map { it.name })
  }

  @Test
  fun `existing destinations and invalid URLs never launch`() {
    val destination = File(parent, "repo").apply { mkdir() }
    File(destination, "keep").writeText("original")
    val manager = manager { _, _, _ -> throw AssertionError("Must not launch") }

    assertEquals("E_CLONE_INPUT", manager.cloneRepository("exists", "owner/repo", parent.path, "repo").code)
    assertEquals("E_CLONE_INPUT", manager.cloneRepository("url", "file:///tmp/repo", parent.path, "new").code)
    assertEquals("original", File(destination, "keep").readText())
    assertFalse(File(parent, "new").exists())
  }

  @Test
  fun `cancellation arriving before registration prevents a clone`() {
    val manager = manager { _, _, _ -> throw AssertionError("Must not launch") }
    manager.cancelRepositoryClone("early")

    assertEquals("cancelled", manager.cloneRepository("early", "owner/repo", parent.path, "repo").status)
    assertFalse(manager.isCloning)
    assertFalse(journal.exists())
  }

  @Test
  fun `cancellation racing process attachment closes control pipe and cleans after marker`() {
    val launching = CountDownLatch(1)
    val attach = CountDownLatch(1)
    lateinit var process: FakeProcess
    val manager = manager { args, _, _ ->
      process = FakeProcess().apply {
        onControlClosed = {
          File(args[5]).writeText("cancelled")
          complete(130)
        }
      }
      File(args[3]).mkdirs()
      launching.countDown()
      assertTrue(attach.await(3, TimeUnit.SECONDS))
      process
    }
    val result = CompletableFuture.supplyAsync {
      manager.cloneRepository("race", "owner/repo", parent.path, "repo")
    }
    assertTrue(launching.await(3, TimeUnit.SECONDS))
    val cancellation = CompletableFuture.runAsync { manager.cancelRepositoryClone("race") }
    assertFalse(cancellation.isDone)
    attach.countDown()

    assertEquals("cancelled", result.get(3, TimeUnit.SECONDS).status)
    cancellation.get(3, TimeUnit.SECONDS)
    assertTrue(process.controlClosed.get())
    assertFalse(manager.isCloning)
    assertTrue(parent.listFiles().orEmpty().isEmpty())
    assertTrue(journal.listFiles().orEmpty().isEmpty())
  }

  @Test
  fun `only one clone runs and module destruction cancels its helpers through supervisor`() {
    val started = CountDownLatch(1)
    val manager = manager { args, _, _ ->
      FakeProcess().apply {
        onControlClosed = {
          File(args[5]).writeText("cancelled")
          complete(130)
        }
        started.countDown()
      }
    }
    val pending = CompletableFuture.supplyAsync {
      manager.cloneRepository("first", "owner/repo", parent.path, "repo")
    }
    assertTrue(started.await(3, TimeUnit.SECONDS))
    assertTrue(manager.isCloning)
    assertEquals("E_CLONE_BUSY", manager.cloneRepository("second", "owner/two", parent.path, "two").code)
    manager.close()

    assertEquals("cancelled", pending.get(3, TimeUnit.SECONDS).status)
    assertEquals("E_CLONE_CLOSED", manager.cloneRepository("third", "owner/three", parent.path, "three").code)
  }

  @Test
  fun `cancel waits for supervisor exit and staging cleanup`() {
    val started = CountDownLatch(1)
    val controlClosed = CountDownLatch(1)
    lateinit var process: FakeProcess
    lateinit var marker: File
    val manager = manager { args, _, _ ->
      marker = File(args[5])
      process = FakeProcess().apply { onControlClosed = { controlClosed.countDown() } }
      started.countDown()
      process
    }
    val result = CompletableFuture.supplyAsync {
      manager.cloneRepository("wait-cancel", "owner/repo", parent.path, "repo")
    }
    assertTrue(started.await(3, TimeUnit.SECONDS))
    val cancelled = CompletableFuture.runAsync { manager.cancelRepositoryClone("wait-cancel") }
    assertTrue(controlClosed.await(3, TimeUnit.SECONDS))
    assertFalse(cancelled.isDone)
    assertTrue(manager.isCloning)
    marker.writeText("cancelled")
    process.complete(130)

    cancelled.get(3, TimeUnit.SECONDS)
    assertEquals("cancelled", result.get(3, TimeUnit.SECONDS).status)
    assertFalse(manager.isCloning)
    assertTrue(parent.listFiles().orEmpty().isEmpty())
    assertTrue(journal.listFiles().orEmpty().isEmpty())
  }

  @Test
  fun `running editor prevents native clone registration`() {
    val manager = manager(editorRunning = { true }) { _, _, _ -> throw AssertionError("Must not launch") }
    assertEquals("E_EDITOR_RUNNING", manager.cloneRepository("busy", "owner/repo", parent.path, "repo").code)
    assertFalse(manager.isCloning)
    assertFalse(journal.exists())
  }

  @Test
  fun `launch failure cleans its owned unstarted staging`() {
    val manager = manager { _, _, _ -> throw IOException("Unable to launch bundled Git") }
    val result = manager.cloneRepository("launch", "owner/repo", parent.path, "repo")

    assertEquals("error", result.status)
    assertEquals("Unable to launch bundled Git", result.message)
    assertTrue(parent.listFiles().orEmpty().isEmpty())
    assertTrue(journal.listFiles().orEmpty().isEmpty())
  }

  @Test
  fun `failure drains bounded diagnostics and emits bounded operation progress`() {
    val manager = manager { args, _, _ ->
      File(args[3]).mkdirs()
      File(args[5]).writeText("failed")
      FakeProcess(("x".repeat(40_000) + "\rReceiving objects: 80%\rfatal: repository not found\n")).apply { complete(128) }
    }
    val result = manager.cloneRepository("failure", "owner/repo", parent.path, "repo")

    assertEquals("error", result.status)
    assertTrue(result.message!!.length <= 2_000)
    assertTrue(result.message!!.endsWith("fatal: repository not found"))
    assertTrue(progress.all { it.first == "failure" && it.second.length <= 500 })
    assertTrue(progress.any { it.second == "fatal: repository not found" })
    assertTrue(parent.listFiles().orEmpty().isEmpty())
  }

  @Test
  fun `unmarked supervisor death preserves staging and journal even after restart`() {
    val manager = manager { args, _, _ ->
      File(args[3]).mkdirs()
      FakeProcess().apply { complete(137) }
    }
    val result = manager.cloneRepository("abnormal", "owner/repo", parent.path, "repo")

    assertEquals("error", result.status)
    assertTrue(result.message!!.contains("preserved"))
    assertEquals(1, parent.listFiles().orEmpty().size)
    assertEquals(1, journal.listFiles().orEmpty().size)
    manager.recoverInterrupted()
    assertEquals(1, parent.listFiles().orEmpty().size)
    assertEquals(1, journal.listFiles().orEmpty().size)
    assertFalse(File(parent, "repo").exists())
  }

  @Test
  fun `exit zero alone cannot select an incomplete workspace`() {
    val manager = manager { _, _, _ -> FakeProcess().apply { complete(0) } }
    assertEquals("error", manager.cloneRepository("false-success", "owner/repo", parent.path, "repo").status)
    assertFalse(File(parent, "repo").exists())
  }

  @Test
  fun `a broken progress reader stops supervisor before releasing clone ownership`() {
    val manager = manager { args, _, _ ->
      object : FakeProcess() {
        override fun getErrorStream(): ByteArrayInputStream = throw IOException("reader failed")
      }.apply {
        onControlClosed = {
          File(args[5]).writeText("cancelled")
          complete(130)
        }
      }
    }

    val result = manager.cloneRepository("broken-reader", "owner/repo", parent.path, "repo")

    assertEquals("E_CLONE_OUTPUT", result.code)
    assertFalse(manager.isCloning)
    assertTrue(parent.listFiles().orEmpty().isEmpty())
  }

  @Test
  fun `recovery removes only owned quiescent staging without following repository symlinks`() {
    val storage = RepositoryCloneStorage(journal)
    val workspace = storage.create(parent, "repo")
    val outside = File(root, "outside").apply { mkdir() }
    File(outside, "keep").writeText("safe")
    workspace.repository.mkdir()
    Files.createSymbolicLink(File(workspace.repository, "escape").toPath(), outside.toPath())
    workspace.quiescenceMarker.writeText("cancelled")

    storage.recoverInterrupted()

    assertEquals("safe", File(outside, "keep").readText())
    assertFalse(workspace.stage.exists())
    assertTrue(journal.listFiles().orEmpty().isEmpty())
  }

  @Test
  fun `recovery does not delete staging with changed ownership or a promoted repository`() {
    val storage = RepositoryCloneStorage(journal)
    val changed = storage.create(parent, "changed")
    File(changed.stage, ".codey-owner").writeText("other owner")
    changed.quiescenceMarker.writeText("failed")
    val completed = storage.create(parent, "completed")
    completed.repository.mkdir()
    File(completed.repository, "keep").writeText("completed")
    Files.move(completed.repository.toPath(), completed.destination.toPath())
    completed.quiescenceMarker.writeText("success")

    storage.recoverInterrupted()

    assertTrue(changed.stage.exists())
    assertFalse(completed.stage.exists())
    assertEquals("completed", File(completed.destination, "keep").readText())
  }

  private fun manager(
    editorRunning: () -> Boolean = { false },
    launcher: (List<String>, File, Map<String, String>) -> Process
  ): RepositoryCloneManager = RepositoryCloneManager(
    runtimeProvider = { path ->
      assertEquals(parent.path, path)
      RepositoryCloneRuntime(parent, "/native/libcodey_exec_dispatcher.so", "/private/commands/git", mapOf("GIT_ALLOW_PROTOCOL" to "https"))
    },
    journalDirectoryProvider = { journal },
    onProgress = { operationId, message -> progress.add(operationId to message) },
    editorRunning = editorRunning,
    launcher = RepositoryCloneLauncher(launcher)
  ).also(managers::add)

  private open class FakeProcess(stderr: String = "") : Process() {
    private val exited = CountDownLatch(1)
    private val code = AtomicInteger(0)
    val controlClosed = AtomicBoolean(false)
    var onControlClosed: () -> Unit = {}
    private val stdout = ByteArrayInputStream(byteArrayOf())
    private val errors = ByteArrayInputStream(stderr.toByteArray(Charsets.UTF_8))
    private val input = object : OutputStream() {
      override fun write(value: Int) = Unit
      override fun close() {
        if (controlClosed.compareAndSet(false, true) && isAlive) onControlClosed()
      }
    }

    fun complete(exitCode: Int) {
      code.set(exitCode)
      exited.countDown()
    }

    override fun getInputStream() = stdout
    override fun getErrorStream() = errors
    override fun getOutputStream() = input
    override fun waitFor(): Int { exited.await(); return code.get() }
    override fun waitFor(timeout: Long, unit: TimeUnit): Boolean = exited.await(timeout, unit)
    override fun exitValue(): Int {
      if (isAlive) throw IllegalThreadStateException("still running")
      return code.get()
    }
    override fun isAlive(): Boolean = exited.count > 0
    override fun destroy() { throw AssertionError("Use supervisor control pipe, never destroy its process") }
    override fun destroyForcibly(): Process { throw AssertionError("Never force-kill supervisor") }
  }
}
