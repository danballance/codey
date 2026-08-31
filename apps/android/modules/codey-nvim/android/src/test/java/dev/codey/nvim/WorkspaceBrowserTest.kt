package dev.codey.nvim

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkspaceBrowserTest {
  @Test
  fun `root requires all-files access before resolving the volume`() {
    var volumeRequests = 0
    val browser = WorkspaceBrowser(
      volumeProvider = {
        volumeRequests += 1
        WorkspaceVolume("Internal storage", File(ROOT))
      },
      allFilesAccessProvider = { false },
      files = FakeWorkspaceFiles(mapOf(ROOT to directory()))
    )

    val error = assertThrows(IllegalStateException::class.java) { browser.getRoot() }

    assertEquals("All-files access must be granted to browse local workspaces", error.message)
    assertEquals(0, volumeRequests)
  }

  @Test
  fun `root returns the mounted volume label and canonical path`() {
    val files = FakeWorkspaceFiles(
      nodes = mapOf(ROOT to directory()),
      canonicalAliases = mapOf("/storage/self/primary" to ROOT)
    )
    val browser = browser(files, root = "/storage/self/primary", label = "Tablet storage")

    assertEquals(WorkspaceRoot("Tablet storage", ROOT), browser.getRoot())
  }

  @Test
  fun `containment rejects traversal sibling-prefix and symlink escapes`() {
    val files = FakeWorkspaceFiles(
      nodes = mapOf(
        ROOT to directory(),
        "$ROOT/project" to directory()
      ),
      canonicalAliases = mapOf("$ROOT/link-out" to "/storage/emulated/outside")
    )
    val browser = browser(files)

    listOf(
      "$ROOT/../secret",
      "/storage/emulated/01/project",
      "$ROOT/link-out"
    ).forEach { unsafePath ->
      val error = assertThrows(IllegalArgumentException::class.java) {
        browser.listDirectory(unsafePath)
      }
      assertEquals("Local workspace path must be inside primary shared storage", error.message)
    }
  }

  @Test
  fun `directory validation distinguishes missing files unreadable and unwritable paths`() {
    val files = FakeWorkspaceFiles(
      nodes = mapOf(
        ROOT to directory(),
        "$ROOT/file.txt" to node(directory = false),
        "$ROOT/unreadable" to directory(readable = false),
        "$ROOT/read-only" to directory(writable = false)
      )
    )
    val browser = browser(files)

    assertFailure("Local workspace path does not exist") {
      browser.listDirectory("$ROOT/missing")
    }
    assertFailure("Local workspace path is not a directory") {
      browser.listDirectory("$ROOT/file.txt")
    }
    assertFailure("Local workspace directory is not readable") {
      browser.listDirectory("$ROOT/unreadable")
    }
    assertFailure("Local workspace directory is not writable") {
      WorkspaceDirectoryValidator(files).requireWritableDirectory("$ROOT/read-only")
    }
  }

  @Test
  fun `listing includes hidden readable directories filters unsafe entries and sorts stably`() {
    val files = FakeWorkspaceFiles(
      nodes = mapOf(
        ROOT to directory(children = listOf(
          "$ROOT/Beta",
          "$ROOT/file.txt",
          "$ROOT/.hidden",
          "$ROOT/blocked",
          "$ROOT/alpha",
          "$ROOT/link-out"
        )),
        "$ROOT/Beta" to directory(writable = true),
        "$ROOT/file.txt" to node(directory = false),
        "$ROOT/.hidden" to directory(writable = false),
        "$ROOT/blocked" to directory(readable = false),
        "$ROOT/alpha" to directory(writable = false)
      ),
      canonicalAliases = mapOf("$ROOT/link-out" to "/outside/project")
    )

    val listing = browser(files).listDirectory(ROOT)

    assertEquals(ROOT, listing.rootPath)
    assertEquals(ROOT, listing.path)
    assertNull(listing.parentPath)
    assertTrue(listing.writable)
    assertEquals(listOf(".hidden", "alpha", "Beta"), listing.directories.map { it.name })
    assertEquals(listOf(false, false, true), listing.directories.map { it.writable })
    assertEquals(listOf(ROOT), files.listRequests)
  }

  @Test
  fun `nested listing reports the canonical parent while root has no parent`() {
    val projects = "$ROOT/projects"
    val files = FakeWorkspaceFiles(
      nodes = mapOf(
        ROOT to directory(children = listOf(projects)),
        projects to directory(writable = false)
      )
    )
    val browser = browser(files)

    val rootListing = browser.listDirectory(ROOT)
    val nestedListing = browser.listDirectory("$projects/.")

    assertNull(rootListing.parentPath)
    assertEquals(ROOT, nestedListing.rootPath)
    assertEquals(projects, nestedListing.path)
    assertEquals(ROOT, nestedListing.parentPath)
    assertFalse(nestedListing.writable)
  }

  @Test
  fun `listing deduplicates canonical paths after deterministic name sorting`() {
    val project = "$ROOT/project"
    val alias = "$ROOT/Alias"
    val files = FakeWorkspaceFiles(
      nodes = mapOf(
        ROOT to directory(children = listOf(project, alias)),
        project to directory()
      ),
      canonicalAliases = mapOf(alias to project)
    )

    val listing = browser(files).listDirectory(ROOT)

    assertEquals(1, listing.directories.size)
    assertEquals("Alias", listing.directories.single().name)
    assertEquals(project, listing.directories.single().path)
  }

  @Test
  fun `generic runtime validation accepts a canonical writable directory outside the browse root`() {
    val project = "/data/local/project"
    val files = FakeWorkspaceFiles(
      nodes = mapOf(project to directory()),
      canonicalAliases = mapOf("/manual/project-alias" to project)
    )

    assertEquals(
      File(project),
      WorkspaceDirectoryValidator(files).requireWritableDirectory("/manual/project-alias")
    )
  }

  @Test
  fun `volume selection accepts only a mounted primary shared-storage volume`() {
    val selected = selectMountedPrimaryWorkspaceVolume(listOf(
      WorkspaceVolumeCandidate(
        primary = false,
        state = "mounted",
        label = "SD card",
        directory = File("/storage/1234-5678")
      ),
      WorkspaceVolumeCandidate(
        primary = true,
        state = "unmounted",
        label = "Unavailable primary",
        directory = File(ROOT)
      ),
      WorkspaceVolumeCandidate(
        primary = true,
        state = "mounted_ro",
        label = "",
        directory = File(ROOT)
      )
    ))

    assertEquals("Internal shared storage", selected.label)
    assertEquals(File(ROOT), selected.directory)
  }

  @Test
  fun `volume selection rejects missing mounted primary storage`() {
    val error = assertThrows(IllegalStateException::class.java) {
      selectMountedPrimaryWorkspaceVolume(listOf(
        WorkspaceVolumeCandidate(
          primary = false,
          state = "mounted",
          label = "SD card",
          directory = File("/storage/1234-5678")
        )
      ))
    }

    assertEquals("Mounted primary shared storage is unavailable", error.message)
  }

  private fun browser(
    files: WorkspaceFileAccess,
    root: String = ROOT,
    label: String = "Internal storage"
  ): WorkspaceBrowser = WorkspaceBrowser(
    volumeProvider = { WorkspaceVolume(label, File(root)) },
    allFilesAccessProvider = { true },
    files = files
  )

  private fun assertFailure(message: String, block: () -> Unit) {
    val error = assertThrows(IllegalArgumentException::class.java) { block() }
    assertEquals(message, error.message)
  }

  private data class FakeNode(
    val exists: Boolean = true,
    val directory: Boolean = true,
    val readable: Boolean = true,
    val writable: Boolean = true,
    val children: List<String> = emptyList()
  )

  private class FakeWorkspaceFiles(
    nodes: Map<String, FakeNode>,
    canonicalAliases: Map<String, String> = emptyMap()
  ) : WorkspaceFileAccess {
    private val nodes = nodes.mapKeys { (path, _) -> normalize(path) }
    private val canonicalAliases = canonicalAliases
      .mapKeys { (path, _) -> normalize(path) }
      .mapValues { (_, path) -> normalize(path) }
    val listRequests = mutableListOf<String>()

    override fun canonical(file: File): File {
      val normalized = normalize(file.path)
      return File(canonicalAliases[normalized] ?: normalized)
    }

    override fun exists(file: File): Boolean = node(file)?.exists == true
    override fun isDirectory(file: File): Boolean = node(file)?.directory == true
    override fun canRead(file: File): Boolean = node(file)?.readable == true
    override fun canWrite(file: File): Boolean = node(file)?.writable == true

    override fun listFiles(file: File): List<File>? {
      val path = normalize(file.path)
      listRequests += path
      return node(file)?.children?.map(::File)
    }

    private fun node(file: File): FakeNode? = nodes[normalize(file.path)]

    private companion object {
      fun normalize(path: String): String = File(path).absoluteFile.normalize().path
    }
  }

  private companion object {
    const val ROOT = "/storage/emulated/0"

    fun directory(
      readable: Boolean = true,
      writable: Boolean = true,
      children: List<String> = emptyList()
    ) = FakeNode(
      directory = true,
      readable = readable,
      writable = writable,
      children = children
    )

    fun node(directory: Boolean) = FakeNode(directory = directory)
  }
}
