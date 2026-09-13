package dev.codey.nvim

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.URI
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes
import java.util.Properties
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal data class RepositoryCloneRuntime(
  val parentDirectory: File,
  val dispatcher: String,
  val gitAlias: String,
  val environment: Map<String, String>
)

internal data class RepositoryCloneResult(
  val status: String,
  val path: String? = null,
  val code: String? = null,
  val message: String? = null
) {
  fun toMap(): Map<String, String> = buildMap {
    put("status", status)
    path?.let { put("path", it) }
    code?.let { put("code", it) }
    message?.let { put("message", it) }
  }
}

internal fun canonicalGitHubRepository(input: String): String {
  val value = input.trim()
  require(value.isNotEmpty() && value.none { it.isISOControl() || it == '\\' }) {
    "Enter a GitHub repository URL or owner/repository"
  }
  val url = if (value.contains("://")) value else "https://github.com/$value"
  val uri = try {
    URI(url)
  } catch (error: Exception) {
    throw IllegalArgumentException("Enter a valid GitHub repository URL", error)
  }
  require(uri.scheme.equals("https", ignoreCase = true) &&
    uri.host.equals("github.com", ignoreCase = true) && uri.port == -1 &&
    uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null) {
    "Use a public GitHub repository URL over HTTPS"
  }
  val path = uri.rawPath.removeSuffix("/")
  val parts = path.removePrefix("/").split('/')
  require(parts.size == 2 && OWNER_PATTERN.matches(parts[0])) {
    "Enter a GitHub repository URL or owner/repository"
  }
  val repository = parts[1].removeSuffix(".git")
  require(REPOSITORY_PATTERN.matches(repository) && repository != "." && repository != "..") {
    "Enter a valid GitHub repository name"
  }
  return "https://github.com/${parts[0]}/$repository.git"
}

internal fun validateCloneDirectoryName(input: String): String {
  val name = input.trim()
  require(name.isNotEmpty() && name.length <= 100 && name != "." && name != ".." &&
    !name.startsWith(STAGING_PREFIX) && name.none { it == '/' || it == '\\' || it.isISOControl() }) {
    "Choose a folder name of 1–100 characters without slashes"
  }
  return name
}

internal fun interface RepositoryCloneLauncher {
  fun launch(command: List<String>, directory: File, environment: Map<String, String>): Process
}

internal object ProcessBuilderRepositoryCloneLauncher : RepositoryCloneLauncher {
  override fun launch(
    command: List<String>,
    directory: File,
    environment: Map<String, String>
  ): Process {
    val builder = ProcessBuilder(command).directory(directory).redirectErrorStream(false)
    // Never inherit Git credentials, askpass, preload, proxy or configuration overrides.
    builder.environment().clear()
    builder.environment().putAll(environment)
    return builder.start()
  }
}

/** A single clone, separate from the editor and cancelled through its supervisor's stdin. */
internal class RepositoryCloneManager(
  private val runtimeProvider: (String) -> RepositoryCloneRuntime,
  private val journalDirectoryProvider: () -> File,
  private val onProgress: (String, String) -> Unit,
  private val lifecycleLock: Any = Any(),
  private val editorRunning: () -> Boolean = { false },
  private val launcher: RepositoryCloneLauncher = ProcessBuilderRepositoryCloneLauncher
) {
  private var active: CloneOperation? = null
  private var closed = false
  private val earlyCancellations = linkedSetOf<String>()

  val isCloning: Boolean
    get() = synchronized(lifecycleLock) { active != null }

  fun recoverInterrupted() = synchronized(lifecycleLock) {
    if (active == null && !closed) {
      runCatching { RepositoryCloneStorage(journalDirectoryProvider()).recoverInterrupted() }
    }
    Unit
  }

  fun cloneRepository(
    operationId: String,
    repositoryUrl: String,
    parentPath: String,
    directoryName: String
  ): RepositoryCloneResult {
    if (!OPERATION_PATTERN.matches(operationId)) {
      return error("E_CLONE_INPUT", "Invalid clone operation identifier")
    }
    val operation = synchronized(lifecycleLock) {
      when {
        closed -> return error("E_CLONE_CLOSED", "Repository cloning is unavailable")
        earlyCancellations.remove(operationId) -> return cancelled()
        active != null -> return error("E_CLONE_BUSY", "A repository is already being cloned")
        editorRunning() -> return error("E_EDITOR_RUNNING", "Stop the editor before cloning a repository")
      }
      CloneOperation(operationId).also { active = it }
    }

    var workspace: RepositoryCloneWorkspace? = null
    var launched = false
    var outputReaders: ExecutorService? = null
    try {
      val url = canonicalGitHubRepository(repositoryUrl)
      val name = validateCloneDirectoryName(directoryName)
      if (operation.cancelled.get()) return cancelled()
      val runtime = runtimeProvider(parentPath)
      val storage = RepositoryCloneStorage(journalDirectoryProvider())
      storage.recoverInterrupted()
      if (operation.cancelled.get()) return cancelled()
      workspace = storage.create(runtime.parentDirectory, name)
      if (operation.cancelled.get()) {
        workspace.markUnstarted("cancelled")
        return cancelled()
      }
      emit(operation, "Cloning repository…")
      val process = launcher.launch(
        listOf(
          runtime.dispatcher, "--codey-clone", runtime.gitAlias,
          workspace.repository.absolutePath, workspace.destination.absolutePath,
          workspace.quiescenceMarker.absolutePath, url
        ),
        runtime.parentDirectory,
        runtime.environment
      )
      launched = true
      operation.attach(process)
      val tail = BoundedByteTail(16 * 1024)
      val readerFailure = AtomicReference<Exception?>()
      val drained = CountDownLatch(2)
      val readers = Executors.newFixedThreadPool(2) { runnable ->
        Thread(runnable, "codey-clone-output").apply { isDaemon = true }
      }
      outputReaders = readers
      readers.execute {
        try {
          process.inputStream.use { input ->
            val buffer = ByteArray(4096)
            while (input.read(buffer) >= 0) { /* Supervisor stdout is reserved. */ }
          }
        } catch (error: Exception) {
          if (!operation.cancelled.get()) {
            readerFailure.compareAndSet(null, error)
            operation.cancel()
          }
        } finally {
          drained.countDown()
        }
      }
      readers.execute {
        try {
          drainCloneProgress(process, tail) { message -> emit(operation, message) }
        } catch (error: Exception) {
          if (!operation.cancelled.get()) {
            readerFailure.compareAndSet(null, error)
            operation.cancel()
          }
        } finally {
          drained.countDown()
        }
      }
      val exitCode = try {
        var interrupted = false
        try {
          // Keep ownership until the supervisor exits, including after caller interruption.
          val result = awaitSupervisor(process) { interrupted = true; operation.cancel() }
          try {
            drained.await(1, TimeUnit.SECONDS)
          } catch (_: InterruptedException) {
            interrupted = true
          }
          result
        } finally {
          if (interrupted) Thread.currentThread().interrupt()
        }
      } finally {
        runCatching { process.outputStream.close() }
        runCatching { process.inputStream.close() }
        runCatching { process.errorStream.close() }
        readers.shutdownNow()
      }
      val marker = workspace.terminalState()
      if (exitCode == 0 && marker == "success") {
        val destination = WorkspaceDirectoryValidator()
          .requireWritableDirectory(workspace.destination.absolutePath)
        return RepositoryCloneResult("success", path = destination.path)
      }
      if (readerFailure.get() != null) {
        return error("E_CLONE_OUTPUT", "Unable to read Git progress; the clone was stopped")
      }
      if (exitCode == 130 && marker == "cancelled") return cancelled()
      val detail = tail.asUtf8String().trim().takeLast(2_000)
      val message = if (marker == null) {
        "Clone interrupted. Partial files were preserved at ${workspace.stage.path}."
      } else {
        detail.ifEmpty { "Unable to clone this public GitHub repository" }
      }
      return error("E_CLONE_FAILED", message)
    } catch (error: Exception) {
      if (!launched) workspace?.markUnstarted(if (operation.cancelled.get()) "cancelled" else "failed")
      if (operation.cancelled.get() && !launched) return cancelled()
      return error(
        if (error is IllegalArgumentException) "E_CLONE_INPUT" else "E_CLONE_FAILED",
        error.message ?: "Unable to clone this public GitHub repository"
      )
    } finally {
      // A failure while setting up readers must still close control and reap the supervisor.
      operation.finishProcess()
      outputReaders?.shutdownNow()
      workspace?.cleanupIfQuiescent()
      synchronized(lifecycleLock) { if (active === operation) active = null }
      operation.completed.countDown()
    }
  }

  fun cancelRepositoryClone(operationId: String) {
    val operation = synchronized(lifecycleLock) {
      active?.takeIf { it.id == operationId } ?: run {
        if (!closed && OPERATION_PATTERN.matches(operationId)) {
          earlyCancellations.add(operationId)
          if (earlyCancellations.size > 64) earlyCancellations.remove(earlyCancellations.first())
        }
        null
      }
    }
    operation?.let {
      it.cancel()
      awaitCloneCompletion(it.completed)
    }
  }

  fun close() {
    val operation = synchronized(lifecycleLock) {
      closed = true
      earlyCancellations.clear()
      active
    }
    operation?.cancel()
  }

  private fun emit(operation: CloneOperation, message: String) {
    if (!operation.cancelled.get()) runCatching { onProgress(operation.id, message) }
  }

  private class CloneOperation(val id: String) {
    val cancelled = AtomicBoolean(false)
    val completed = CountDownLatch(1)
    private val process = AtomicReference<Process?>()

    fun attach(value: Process) {
      process.set(value)
      if (cancelled.get()) runCatching { value.outputStream.close() }
    }

    fun cancel() {
      cancelled.set(true)
      process.get()?.let { runCatching { it.outputStream.close() } }
    }

    fun finishProcess() {
      process.get()?.let { value ->
        if (value.isAlive) cancel()
        runCatching { value.outputStream.close() }
        runCatching { value.inputStream.close() }
        runCatching { value.errorStream.close() }
        var interrupted = false
        try {
          awaitSupervisor(value) { interrupted = true; cancel() }
        } finally {
          if (interrupted) Thread.currentThread().interrupt()
        }
      }
    }
  }

  private fun error(code: String, message: String) =
    RepositoryCloneResult("error", code = code, message = message)

  private fun cancelled() = RepositoryCloneResult("cancelled", message = "Clone cancelled")
}

/** Private journals authorize cleanup only for the random staging container they created. */
internal class RepositoryCloneStorage(private val journalRoot: File) {
  fun create(parent: File, directoryName: String): RepositoryCloneWorkspace {
    val canonicalParent = WorkspaceDirectoryValidator().requireWritableDirectory(parent.path)
    val destination = File(canonicalParent, validateCloneDirectoryName(directoryName))
    require(!Files.exists(destination.toPath(), NOFOLLOW_LINKS)) { "The destination folder already exists" }
    check(journalRoot.isDirectory || journalRoot.mkdirs()) { "Unable to prepare clone journal" }
    val token = UUID.randomUUID().toString()
    val stage = File(canonicalParent, "$STAGING_PREFIX$token")
    val journal = File(journalRoot, token)
    check(journal.mkdir()) { "Unable to create clone journal" }
    val workspace = RepositoryCloneWorkspace(stage, destination, journal, token)
    try {
      val metadata = Properties().apply {
        setProperty("parent", canonicalParent.path)
        setProperty("destination", destination.name)
        setProperty("token", token)
      }
      FileOutputStream(File(journal, JOURNAL_FILE)).use { output ->
        metadata.store(output, null)
        output.fd.sync()
      }
      check(stage.mkdir()) { "Unable to create repository staging folder" }
      File(stage, OWNERSHIP_FILE).writeText(token)
      return workspace
    } catch (error: Exception) {
      workspace.markUnstarted("failed")
      workspace.cleanupIfQuiescent()
      throw error
    }
  }

  fun recoverInterrupted() {
    journalRoot.listFiles()?.forEach { journal ->
      runCatching {
        if (!journal.isDirectory || Files.isSymbolicLink(journal.toPath())) return@runCatching
        val metadata = Properties().apply {
          File(journal, JOURNAL_FILE).inputStream().use(::load)
        }
        val token = metadata.getProperty("token") ?: return@runCatching
        if (!UUID_PATTERN.matches(token) || journal.name != token) return@runCatching
        val parent = File(metadata.getProperty("parent") ?: return@runCatching)
        if (!parent.isAbsolute || parent.canonicalFile != parent) return@runCatching
        val destination = File(parent, validateCloneDirectoryName(metadata.getProperty("destination") ?: ""))
        RepositoryCloneWorkspace(File(parent, "$STAGING_PREFIX$token"), destination, journal, token)
          .cleanupIfQuiescent()
      }
    }
  }
}

internal class RepositoryCloneWorkspace(
  val stage: File,
  val destination: File,
  private val journal: File,
  private val token: String
) {
  val repository: File = File(stage, "repository")
  val quiescenceMarker: File = File(journal, "quiescent")

  fun terminalState(): String? = runCatching {
    if (Files.isSymbolicLink(quiescenceMarker.toPath())) return@runCatching null
    quiescenceMarker.readText().trim().takeIf { it in TERMINAL_STATES }
  }.getOrNull()

  fun markUnstarted(state: String) {
    require(state in TERMINAL_STATES)
    runCatching { quiescenceMarker.writeText(state) }
  }

  fun cleanupIfQuiescent(): Boolean = runCatching {
    if (terminalState() == null) return@runCatching false
    if (Files.exists(stage.toPath(), NOFOLLOW_LINKS)) {
      if (Files.isSymbolicLink(stage.toPath()) || stage.canonicalFile != stage ||
        stage.name != "$STAGING_PREFIX$token") return@runCatching false
      val ownership = File(stage, OWNERSHIP_FILE)
      if (Files.isSymbolicLink(ownership.toPath()) || ownership.length() > 128 ||
        ownership.readText() != token) return@runCatching false
      deleteCloneTree(stage.toPath())
    } else if (!Files.notExists(stage.toPath(), NOFOLLOW_LINKS)) {
      // exists=false may mean permission loss; keep the journal until absence is certain.
      return@runCatching false
    }
    deleteCloneTree(journal.toPath())
    true
  }.getOrDefault(false)
}

private fun deleteCloneTree(path: Path) {
  // The default visitor never follows symlinks checked out by the repository.
  Files.walkFileTree(path, object : SimpleFileVisitor<Path>() {
    override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
      Files.delete(file)
      return FileVisitResult.CONTINUE
    }

    override fun postVisitDirectory(directory: Path, error: IOException?): FileVisitResult {
      if (error != null) throw error
      Files.delete(directory)
      return FileVisitResult.CONTINUE
    }
  })
}

private fun awaitSupervisor(process: Process, interrupted: () -> Unit): Int {
  while (true) {
    try {
      return process.waitFor()
    } catch (_: InterruptedException) {
      interrupted()
    }
  }
}

private fun awaitCloneCompletion(completed: CountDownLatch) {
  var interrupted = false
  try {
    while (true) {
      try {
        completed.await()
        return
      } catch (_: InterruptedException) {
        interrupted = true
      }
    }
  } finally {
    if (interrupted) Thread.currentThread().interrupt()
  }
}

private fun drainCloneProgress(process: Process, tail: BoundedByteTail, emit: (String) -> Unit) {
  var lastEmission = 0L
  var pending = ""
  val line = StringBuilder()
  fun flushLine() {
    val message = line.toString().replace(ANSI_PATTERN, "").filter { !it.isISOControl() }.trim()
    line.setLength(0)
    if (message.isEmpty()) return
    tail.append((message + "\n").toByteArray(Charsets.UTF_8))
    pending = message.takeLast(500)
    val now = System.nanoTime()
    if (now - lastEmission >= TimeUnit.MILLISECONDS.toNanos(100)) {
      emit(pending)
      pending = ""
      lastEmission = now
    }
  }
  process.errorStream.reader(Charsets.UTF_8).use { reader ->
    val buffer = CharArray(4096)
    while (true) {
      val count = reader.read(buffer)
      if (count < 0) break
      for (index in 0 until count) {
        val character = buffer[index]
        if (character == '\r' || character == '\n') flushLine() else {
          if (line.length == 4096) line.delete(0, 2048)
          line.append(character)
        }
      }
    }
  }
  flushLine()
  if (pending.isNotEmpty()) emit(pending)
}

private const val STAGING_PREFIX = ".codey-clone-"
private const val JOURNAL_FILE = "operation.properties"
private const val OWNERSHIP_FILE = ".codey-owner"
private val TERMINAL_STATES = setOf("success", "cancelled", "failed")
private val OPERATION_PATTERN = Regex("^[A-Za-z0-9_-]{1,128}$")
private val UUID_PATTERN = Regex("^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
private val OWNER_PATTERN = Regex("^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$")
private val REPOSITORY_PATTERN = Regex("^[A-Za-z0-9._-]{1,100}$")
private val ANSI_PATTERN = Regex("\u001B\\[[0-?]*[ -/]*[@-~]")
