package dev.codey.nvim

import android.content.Context
import android.os.Build
import android.os.Environment
import android.os.storage.StorageManager
import java.io.File
import java.io.IOException
import java.util.Locale

private val MOUNTED_VOLUME_STATES = setOf(
  Environment.MEDIA_MOUNTED,
  Environment.MEDIA_MOUNTED_READ_ONLY
)

internal data class WorkspaceRoot(
  val label: String,
  val path: String
)

internal data class WorkspaceDirectory(
  val name: String,
  val path: String,
  val writable: Boolean
)

internal data class WorkspaceListing(
  val rootPath: String,
  val path: String,
  val parentPath: String?,
  val writable: Boolean,
  val directories: List<WorkspaceDirectory>
)

internal data class WorkspaceVolume(
  val label: String,
  val directory: File
)

internal data class WorkspaceVolumeCandidate(
  val primary: Boolean,
  val state: String,
  val label: String,
  val directory: File?
)

internal fun selectMountedPrimaryWorkspaceVolume(
  candidates: List<WorkspaceVolumeCandidate>
): WorkspaceVolume {
  val selected = candidates.firstOrNull { candidate ->
    candidate.primary &&
      candidate.directory != null &&
      candidate.state in MOUNTED_VOLUME_STATES
  }
  checkNotNull(selected) { "Mounted primary shared storage is unavailable" }
  return WorkspaceVolume(
    label = selected.label.ifBlank { "Internal shared storage" },
    directory = checkNotNull(selected.directory)
  )
}

internal fun primarySharedStorageVolume(context: Context): WorkspaceVolume {
  check(Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
    "Local workspaces require Android 11 or newer"
  }
  val storageManager = checkNotNull(context.getSystemService(StorageManager::class.java)) {
    "Android storage manager is unavailable"
  }
  return selectMountedPrimaryWorkspaceVolume(
    storageManager.storageVolumes.map { volume ->
      WorkspaceVolumeCandidate(
        primary = volume.isPrimary,
        state = volume.state,
        label = volume.getDescription(context),
        directory = volume.directory
      )
    }
  )
}

internal interface WorkspaceFileAccess {
  @Throws(IOException::class)
  fun canonical(file: File): File

  fun exists(file: File): Boolean
  fun isDirectory(file: File): Boolean
  fun canRead(file: File): Boolean
  fun canWrite(file: File): Boolean
  fun listFiles(file: File): List<File>?
}

private object JavaWorkspaceFileAccess : WorkspaceFileAccess {
  override fun canonical(file: File): File = file.canonicalFile
  override fun exists(file: File): Boolean = file.exists()
  override fun isDirectory(file: File): Boolean = file.isDirectory
  override fun canRead(file: File): Boolean = file.canRead()
  override fun canWrite(file: File): Boolean = file.canWrite()
  override fun listFiles(file: File): List<File>? = file.listFiles()?.toList()
}

internal class WorkspaceDirectoryValidator(
  private val files: WorkspaceFileAccess = JavaWorkspaceFileAccess
) {
  fun requireReadableDirectory(path: String): File =
    requireResolvedDirectory(resolveAbsolute(path), requireWritable = false)

  fun requireWritableDirectory(path: String): File =
    requireResolvedDirectory(resolveAbsolute(path), requireWritable = true)

  fun resolveAbsolute(path: String): File {
    require(path.isNotBlank()) { "Local workspace path must not be empty" }
    val requested = File(path)
    require(requested.isAbsolute) { "Local workspace path must be absolute" }
    return try {
      files.canonical(requested)
    } catch (error: IOException) {
      throw IllegalArgumentException("Unable to resolve local workspace path", error)
    } catch (error: SecurityException) {
      throw IllegalArgumentException("Unable to resolve local workspace path", error)
    }
  }

  fun requireReadableResolvedDirectory(directory: File): File =
    requireResolvedDirectory(directory, requireWritable = false)

  private fun requireResolvedDirectory(directory: File, requireWritable: Boolean): File {
    require(files.exists(directory)) { "Local workspace path does not exist" }
    require(files.isDirectory(directory)) { "Local workspace path is not a directory" }
    require(files.canRead(directory)) { "Local workspace directory is not readable" }
    if (requireWritable) {
      require(files.canWrite(directory)) { "Local workspace directory is not writable" }
    }
    return directory
  }
}

internal class WorkspaceBrowser(
  private val volumeProvider: () -> WorkspaceVolume,
  private val allFilesAccessProvider: () -> Boolean,
  private val files: WorkspaceFileAccess = JavaWorkspaceFileAccess,
  private val directoryValidator: WorkspaceDirectoryValidator = WorkspaceDirectoryValidator(files)
) {
  fun getRoot(): WorkspaceRoot {
    requireAllFilesAccess()
    val resolved = resolveRoot()
    return WorkspaceRoot(resolved.volume.label, resolved.directory.path)
  }

  fun listDirectory(path: String): WorkspaceListing {
    requireAllFilesAccess()
    val resolvedRoot = resolveRoot()
    val directory = directoryValidator.resolveAbsolute(path)
    require(contains(resolvedRoot.directory, directory)) {
      "Local workspace path must be inside primary shared storage"
    }
    directoryValidator.requireReadableResolvedDirectory(directory)
    val children = try {
      files.listFiles(directory)
    } catch (error: SecurityException) {
      throw IllegalStateException("Unable to list local workspace directory", error)
    } ?: throw IllegalStateException("Unable to list local workspace directory")

    val directories = children.mapNotNull { child ->
      val canonicalChild = try {
        files.canonical(child)
      } catch (_: IOException) {
        return@mapNotNull null
      } catch (_: SecurityException) {
        return@mapNotNull null
      }
      if (!contains(resolvedRoot.directory, canonicalChild)) return@mapNotNull null
      if (!files.exists(canonicalChild)) return@mapNotNull null
      if (!files.isDirectory(canonicalChild)) return@mapNotNull null
      if (!files.canRead(canonicalChild)) return@mapNotNull null
      WorkspaceDirectory(
        name = child.name,
        path = canonicalChild.path,
        writable = files.canWrite(canonicalChild)
      )
    }.sortedWith(DIRECTORY_ORDER).distinctBy { directoryEntry -> directoryEntry.path }

    val parentPath = if (directory == resolvedRoot.directory) {
      null
    } else {
      directory.parentFile
        ?.let(files::canonical)
        ?.takeIf { parent -> contains(resolvedRoot.directory, parent) }
        ?.path
    }
    return WorkspaceListing(
      rootPath = resolvedRoot.directory.path,
      path = directory.path,
      parentPath = parentPath,
      writable = files.canWrite(directory),
      directories = directories
    )
  }

  private fun requireAllFilesAccess() {
    check(allFilesAccessProvider()) {
      "All-files access must be granted to browse local workspaces"
    }
  }

  private fun resolveRoot(): ResolvedRoot {
    val volume = volumeProvider()
    val root = try {
      files.canonical(volume.directory)
    } catch (error: IOException) {
      throw IllegalStateException("Unable to resolve primary shared storage", error)
    } catch (error: SecurityException) {
      throw IllegalStateException("Unable to resolve primary shared storage", error)
    }
    check(root.isAbsolute) { "Primary shared storage path is not absolute" }
    check(files.exists(root)) { "Primary shared storage is unavailable" }
    check(files.isDirectory(root)) { "Primary shared storage path is not a directory" }
    check(files.canRead(root)) { "Primary shared storage is not readable" }
    return ResolvedRoot(volume, root)
  }

  private fun contains(root: File, candidate: File): Boolean {
    val rootPath = root.toPath().normalize()
    val candidatePath = candidate.toPath().normalize()
    return candidatePath == rootPath || candidatePath.startsWith(rootPath)
  }

  private data class ResolvedRoot(
    val volume: WorkspaceVolume,
    val directory: File
  )

  private companion object {
    val DIRECTORY_ORDER = compareBy<WorkspaceDirectory>(
      { directoryEntry -> directoryEntry.name.lowercase(Locale.ROOT) },
      { directoryEntry -> directoryEntry.name },
      { directoryEntry -> directoryEntry.path }
    )
  }
}
