package dev.codey.nvim

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.Properties
import java.util.UUID
import java.util.zip.ZipInputStream

internal data class NvimRuntimeStatus(
  val supported: Boolean,
  val running: Boolean,
  val allFilesAccess: Boolean,
  val unavailableReason: String? = null
)

/** Resolves only immutable packaged code plus private, non-executable runtime data. */
internal class AndroidNvimRuntime(private val context: Context) {
  private val applicationContext = context.applicationContext
  private val installer = NvimRuntimeInstaller(applicationContext)

  fun status(running: Boolean): NvimRuntimeStatus {
    val reason = when {
      Build.VERSION.SDK_INT < Build.VERSION_CODES.R ->
        "Local NeoVim requires Android 11 or newer"
      Build.SUPPORTED_ABIS.none { it == SUPPORTED_ABI } ->
        "Local NeoVim is currently available only on arm64-v8a devices"
      !nativeExecutable().isFile ->
        "The local NeoVim executable is not bundled in this APK"
      !nativeExecutable().canExecute() ->
        "Android did not extract the local NeoVim executable"
      !nativePreloadLibrary().isFile ->
        "The bundled LuaJIT preload library is missing"
      !installer.isBundlePresent() ->
        "The bundled NeoVim runtime is missing"
      else -> null
    }
    return NvimRuntimeStatus(
      supported = reason == null,
      running = running,
      allFilesAccess = hasAllFilesAccess(),
      unavailableReason = reason
    )
  }

  fun hasAllFilesAccess(): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager()

  fun openAllFilesSettings() {
    require(Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      "All-files access requires Android 11 or newer"
    }
    val packageSettings = Intent(
      android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
      Uri.parse("package:${applicationContext.packageName}")
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      applicationContext.startActivity(packageSettings)
    } catch (_: ActivityNotFoundException) {
      applicationContext.startActivity(
        Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      )
    }
  }

  fun prepare(cwd: String): NvimLaunchSpec {
    val runtimeStatus = status(running = false)
    check(runtimeStatus.supported) {
      runtimeStatus.unavailableReason ?: "Local NeoVim is unavailable"
    }
    check(runtimeStatus.allFilesAccess) {
      "All-files access must be granted before starting local NeoVim"
    }

    val workspace = validateWorkspace(cwd)
    val runtime = installer.installIfNeeded()
    val privateRoot = File(applicationContext.filesDir, PRIVATE_ROOT).ensureDirectory()
    val home = File(privateRoot, "home").ensureDirectory()
    val xdgRoot = File(privateRoot, "xdg").ensureDirectory()
    val xdgConfig = File(xdgRoot, "config").ensureDirectory()
    val xdgData = File(xdgRoot, "data").ensureDirectory()
    val xdgState = File(xdgRoot, "state").ensureDirectory()
    val xdgCache = File(xdgRoot, "cache").ensureDirectory()
    val xdgRuntime = File(applicationContext.cacheDir, "$PRIVATE_ROOT/xdg-runtime").ensureDirectory()
    val temp = File(applicationContext.cacheDir, "$PRIVATE_ROOT/tmp").ensureDirectory()
    val nativeDirectory = File(applicationContext.applicationInfo.nativeLibraryDir).canonicalFile

    return NvimLaunchSpec(
      command = listOf(nativeExecutable().canonicalPath, "--clean", "--embed"),
      workingDirectory = workspace,
      environment = mapOf(
        "HOME" to home.canonicalPath,
        "XDG_CONFIG_HOME" to xdgConfig.canonicalPath,
        "XDG_DATA_HOME" to xdgData.canonicalPath,
        "XDG_STATE_HOME" to xdgState.canonicalPath,
        "XDG_CACHE_HOME" to xdgCache.canonicalPath,
        "XDG_RUNTIME_DIR" to xdgRuntime.canonicalPath,
        "TMPDIR" to temp.canonicalPath,
        "VIMRUNTIME" to runtime.canonicalPath,
        "SHELL" to "/system/bin/sh",
        "PATH" to "/system/bin:/system/xbin",
        "LD_LIBRARY_PATH" to nativeDirectory.canonicalPath,
        "LD_PRELOAD" to nativePreloadLibrary().canonicalPath,
        "LANG" to "C.UTF-8"
      )
    )
  }

  private fun validateWorkspace(cwd: String): File {
    require(cwd.isNotBlank()) { "Local workspace path must not be empty" }
    val requested = File(cwd)
    require(requested.isAbsolute) { "Local workspace path must be absolute" }
    val workspace = try {
      requested.canonicalFile
    } catch (error: IOException) {
      throw IllegalArgumentException("Unable to resolve local workspace path", error)
    }
    require(workspace.isDirectory) { "Local workspace path is not a directory" }
    require(workspace.canRead()) { "Local workspace directory is not readable" }
    require(workspace.canWrite()) { "Local workspace directory is not writable" }
    return workspace
  }

  private fun nativeExecutable(): File = File(
    applicationContext.applicationInfo.nativeLibraryDir,
    NVIM_LIBRARY_NAME
  )

  private fun nativePreloadLibrary(): File = File(
    applicationContext.applicationInfo.nativeLibraryDir,
    LUAJIT_LIBRARY_NAME
  )

  private companion object {
    const val SUPPORTED_ABI = "arm64-v8a"
    const val PRIVATE_ROOT = "codey-nvim"
    const val NVIM_LIBRARY_NAME = "libcodey_nvim.so"
    const val LUAJIT_LIBRARY_NAME = "libluajit-5.1.so"
  }
}

internal class NvimRuntimeInstaller(
  private val context: Context,
  private val openAsset: (String) -> InputStream = { path -> context.assets.open(path) }
) {
  @Synchronized
  fun isBundlePresent(): Boolean = runCatching {
    openAsset(BUNDLE_PROPERTIES_ASSET).use { propertiesInput ->
      val metadata = Properties().apply { load(propertiesInput) }
      parseMetadata(metadata)
    }
    openAsset(RUNTIME_ZIP_ASSET).close()
  }.isSuccess

  @Synchronized
  fun installIfNeeded(): File {
    val metadata = readMetadata()
    val installRoot = File(context.filesDir, "$PRIVATE_ROOT/runtimes").ensureDirectory()
    val destination = File(
      installRoot,
      "runtime-${sanitizeVersion(metadata.version)}-${metadata.sha256.take(DIGEST_PATH_LENGTH)}"
    )
    val marker = File(destination, COMPLETE_MARKER)
    if (destination.isDirectory && marker.readTextOrNull()?.trim() == metadata.sha256) {
      return destination.canonicalFile
    }

    verifyRuntimeDigest(metadata.sha256)
    destination.deleteRecursively()
    val staging = File(installRoot, ".partial-${UUID.randomUUID()}")
    check(staging.mkdirs()) { "Unable to create private NeoVim runtime staging directory" }
    try {
      extractRuntime(staging)
      File(staging, COMPLETE_MARKER).writeText("${metadata.sha256}\n")
      if (!staging.renameTo(destination)) {
        if (destination.isDirectory && marker.readTextOrNull()?.trim() == metadata.sha256) {
          staging.deleteRecursively()
          return destination.canonicalFile
        }
        throw IOException("Unable to activate private NeoVim runtime")
      }
      return destination.canonicalFile
    } catch (error: Throwable) {
      staging.deleteRecursively()
      throw error
    }
  }

  private fun readMetadata(): NvimBundleMetadata {
    val properties = Properties()
    try {
      openAsset(BUNDLE_PROPERTIES_ASSET).use { input -> properties.load(input) }
    } catch (error: IOException) {
      throw IOException("Bundled NeoVim metadata is unavailable", error)
    }
    return parseMetadata(properties)
  }

  private fun parseMetadata(properties: Properties): NvimBundleMetadata {
    val version = properties.getProperty("version")?.trim().orEmpty()
    val digest = sequenceOf("runtimeSha256", "sha256", "runtime.sha256")
      .mapNotNull(properties::getProperty)
      .firstOrNull()
      ?.trim()
      ?.lowercase()
      .orEmpty()
    require(version.isNotEmpty()) { "Bundled NeoVim version is missing" }
    require(SHA256_PATTERN.matches(digest)) { "Bundled NeoVim runtime SHA-256 is invalid" }
    return NvimBundleMetadata(version, digest)
  }

  private fun verifyRuntimeDigest(expectedDigest: String) {
    val digest = MessageDigest.getInstance("SHA-256")
    try {
      openAsset(RUNTIME_ZIP_ASSET).use { rawInput ->
        val input = BufferedInputStream(rawInput)
        val buffer = ByteArray(COPY_BUFFER_BYTES)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          if (count > 0) digest.update(buffer, 0, count)
        }
      }
    } catch (error: IOException) {
      throw IOException("Bundled NeoVim runtime is unavailable", error)
    }
    val actual = digest.digest().joinToString("") { byte -> "%02x".format(byte) }
    check(actual == expectedDigest) { "Bundled NeoVim runtime failed its SHA-256 check" }
  }

  private fun extractRuntime(destination: File) {
    val destinationPath = destination.canonicalPath + File.separator
    var extractedFiles = 0
    try {
      openAsset(RUNTIME_ZIP_ASSET).use { rawInput ->
        ZipInputStream(BufferedInputStream(rawInput)).use { zip ->
          while (true) {
            val entry = zip.nextEntry ?: break
            val output = File(destination, entry.name).canonicalFile
            require(output.canonicalPath.startsWith(destinationPath)) {
              "Bundled NeoVim runtime contains an unsafe path"
            }
            if (entry.isDirectory) {
              output.ensureDirectory()
              output.setExecutable(true, true)
            } else {
              output.parentFile?.ensureDirectory()
              BufferedOutputStream(FileOutputStream(output)).use { fileOutput ->
                zip.copyTo(fileOutput, COPY_BUFFER_BYTES)
              }
              check(output.setExecutable(false, false) || !output.canExecute()) {
                "Unable to remove executable permission from bundled runtime file"
              }
              extractedFiles += 1
            }
            zip.closeEntry()
          }
        }
      }
    } catch (error: IOException) {
      throw IOException("Unable to extract bundled NeoVim runtime", error)
    }
    check(extractedFiles > 0) { "Bundled NeoVim runtime is empty" }
  }

  private data class NvimBundleMetadata(val version: String, val sha256: String)

  private companion object {
    const val PRIVATE_ROOT = "codey-nvim"
    const val BUNDLE_PROPERTIES_ASSET = "codey-nvim/bundle.properties"
    const val RUNTIME_ZIP_ASSET = "codey-nvim/runtime.zip"
    const val COMPLETE_MARKER = ".complete"
    const val COPY_BUFFER_BYTES = 32 * 1024
    const val DIGEST_PATH_LENGTH = 16
    val SHA256_PATTERN = Regex("^[0-9a-f]{64}$")
  }
}

private fun File.ensureDirectory(): File {
  check((isDirectory || mkdirs()) && isDirectory) { "Unable to create directory: $path" }
  return this
}

private fun File.readTextOrNull(): String? = runCatching { readText() }.getOrNull()

private fun sanitizeVersion(version: String): String =
  version.replace(Regex("[^A-Za-z0-9._-]"), "_").take(64).ifBlank { "unknown" }
