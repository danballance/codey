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
import java.nio.file.Files
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

internal data class LocalNvimConfiguration(
  val directory: File,
  val initFile: File?
)

internal data class LocalNvimConfigRoot(
  val xdgConfigHome: File,
  val appName: String
)

internal sealed interface NvimCommandTarget {
  data class Elf(val nativeLibrary: String) : NvimCommandTarget
  data class Script(val relativePath: String) : NvimCommandTarget
}

internal data class NvimBundleData(
  val gitCore: String,
  val gitTemplates: String,
  val caBundle: String,
  val opensslConfig: String,
  val luaLsBootstrap: String,
  val luaLsMain: String,
  val treeSitterRuntime: String
)

internal data class NvimBundleMetadata(
  val schemaVersion: Int,
  val version: String,
  val runtimeSha256: String,
  val kickstartCommit: String,
  val treeSitterCommit: String,
  val dispatcher: String,
  val nativeLibraries: List<String>,
  val commands: Map<String, NvimCommandTarget>,
  val parsers: Map<String, String>,
  val data: NvimBundleData
)

internal data class InstalledNvimBundle(
  val runtimeDirectory: File,
  val metadata: NvimBundleMetadata
) {
  fun resolve(relativePath: String): File {
    val root = runtimeDirectory.canonicalFile
    val resolved = File(root, relativePath).canonicalFile
    check(resolved.path.startsWith(root.path + File.separator)) {
      "Bundled NeoVim data path escapes its runtime"
    }
    return resolved
  }

  val dataDirectory: File
    get() = resolve(CODEY_TOOLS_DIRECTORY)

  val treeSitterRuntime: File
    get() = resolve(metadata.data.treeSitterRuntime)

  val luaLsMain: File
    get() = resolve(metadata.data.luaLsMain)

  val luaLsBootstrap: File
    get() = resolve(metadata.data.luaLsBootstrap)
}

internal fun resolveLocalNvimConfiguration(path: String): LocalNvimConfiguration {
  require(path.isNotBlank()) { "Choose a local config folder" }
  val requested = File(path)
  require(requested.isAbsolute) { "Local config folder must be absolute" }
  val directory = try {
    requested.canonicalFile
  } catch (error: IOException) {
    throw IllegalArgumentException("Unable to resolve local config folder", error)
  } catch (error: SecurityException) {
    throw IllegalArgumentException("Unable to resolve local config folder", error)
  }
  require(directory.exists()) { "Local config folder does not exist" }
  require(directory.isDirectory) { "Local config folder is not a directory" }
  require(directory.canRead()) { "Local config folder is not readable" }
  require(directory.canWrite()) { "Local config folder is not writable" }
  require(directory.parentFile != null && directory.name.isNotBlank()) {
    "Local config folder must not be the filesystem root"
  }

  val initFile = File(directory, "init.lua")
  if (!initFile.exists()) return LocalNvimConfiguration(directory, null)
  require(initFile.isFile) { "Local init.lua is not a regular file" }
  require(initFile.canRead()) { "Local init.lua is not readable" }
  return LocalNvimConfiguration(directory, initFile.canonicalFile)
}

internal fun nvimCommand(executable: String, configured: Boolean): List<String> = if (configured) {
  listOf(
    executable,
    "--embed",
    "--cmd",
    "let v:errmsg = ''",
    "-c",
    STRICT_CONFIG_CHECK
  )
} else {
  listOf(executable, "--clean", "--embed")
}

internal fun localNvimConfigRoot(directory: File): LocalNvimConfigRoot = LocalNvimConfigRoot(
  xdgConfigHome = checkNotNull(directory.parentFile).canonicalFile,
  appName = directory.name
)

/** Resolves only immutable packaged code plus private, non-executable runtime data. */
internal class AndroidNvimRuntime(private val context: Context) {
  private val applicationContext = context.applicationContext
  private val installer = NvimRuntimeInstaller(applicationContext)
  private val aliasInstaller = NvimCommandAliasInstaller(applicationContext)
  private val workspaceDirectoryValidator = WorkspaceDirectoryValidator()
  private val workspaceBrowser = WorkspaceBrowser(
    volumeProvider = { primarySharedStorageVolume(applicationContext) },
    allFilesAccessProvider = ::hasAllFilesAccess
  )

  fun status(running: Boolean): NvimRuntimeStatus {
    val nativeDirectory = File(applicationContext.applicationInfo.nativeLibraryDir)
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
      else -> installer.bundleUnavailableReason(nativeDirectory)
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

  fun getWorkspaceRoot(): WorkspaceRoot = workspaceBrowser.getRoot()

  fun listWorkspaceDirectory(path: String): WorkspaceListing =
    workspaceBrowser.listDirectory(path)

  fun prepare(cwd: String, configDirectory: String): NvimLaunchSpec {
    val runtimeStatus = status(running = false)
    check(runtimeStatus.supported) {
      runtimeStatus.unavailableReason ?: "Local NeoVim is unavailable"
    }
    check(runtimeStatus.allFilesAccess) {
      "All-files access must be granted before starting local NeoVim"
    }

    val workspace = workspaceDirectoryValidator.requireWritableDirectory(cwd)
    val configuration = resolveLocalNvimConfiguration(configDirectory)
    val bundle = installer.installIfNeeded()
    val privateRoot = File(applicationContext.filesDir, PRIVATE_ROOT).ensureDirectory()
    val home = File(privateRoot, "home").ensureDirectory()
    val xdgRoot = File(privateRoot, "xdg").ensureDirectory()
    val activeConfiguration = configuration.takeIf { it.initFile != null }
    val configRoot = activeConfiguration?.let { localNvimConfigRoot(it.directory) }
    val storageRoot = if (activeConfiguration != null) {
      File(privateRoot, "profiles/${configProfileKey(activeConfiguration.directory)}")
        .ensureDirectory()
    } else {
      xdgRoot
    }
    val xdgConfig = if (configRoot == null) {
      File(xdgRoot, "config").ensureDirectory()
    } else configRoot.xdgConfigHome
    val xdgData = File(storageRoot, "data").ensureDirectory()
    val xdgState = File(storageRoot, "state").ensureDirectory()
    val xdgCache = File(storageRoot, "cache").ensureDirectory()
    val xdgRuntime = File(applicationContext.cacheDir, "$PRIVATE_ROOT/xdg-runtime").ensureDirectory()
    val temp = File(applicationContext.cacheDir, "$PRIVATE_ROOT/tmp").ensureDirectory()
    val nativeDirectory = File(applicationContext.applicationInfo.nativeLibraryDir).canonicalFile
    val commandDirectory = aliasInstaller.installIfNeeded(bundle, nativeDirectory)

    val command = nvimCommand(nativeExecutable().canonicalPath, activeConfiguration != null)
    val environment = nvimEnvironment(
      bundle = bundle,
      commandDirectory = commandDirectory,
      nativeDirectory = nativeDirectory,
      home = home,
      xdgConfig = xdgConfig,
      xdgData = xdgData,
      xdgState = xdgState,
      xdgCache = xdgCache,
      xdgRuntime = xdgRuntime,
      temp = temp,
      nativePreloadLibrary = nativePreloadLibrary()
    ).toMutableMap()
    if (configRoot != null) {
      environment["NVIM_APPNAME"] = configRoot.appName
    }

    return NvimLaunchSpec(command, workspace, environment)
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

internal fun nvimEnvironment(
  bundle: InstalledNvimBundle,
  commandDirectory: File,
  nativeDirectory: File,
  home: File,
  xdgConfig: File,
  xdgData: File,
  xdgState: File,
  xdgCache: File,
  xdgRuntime: File,
  temp: File,
  nativePreloadLibrary: File
): Map<String, String> {
  val metadata = bundle.metadata
  val caBundle = bundle.resolve(metadata.data.caBundle)
  return mapOf(
    "HOME" to home.canonicalPath,
    "XDG_CONFIG_HOME" to xdgConfig.canonicalPath,
    "XDG_DATA_HOME" to xdgData.canonicalPath,
    "XDG_STATE_HOME" to xdgState.canonicalPath,
    "XDG_CACHE_HOME" to xdgCache.canonicalPath,
    "XDG_RUNTIME_DIR" to xdgRuntime.canonicalPath,
    "TMPDIR" to temp.canonicalPath,
    "VIMRUNTIME" to bundle.runtimeDirectory.canonicalPath,
    "SHELL" to "/system/bin/sh",
    "PATH" to "${commandDirectory.canonicalPath}:/system/bin:/system/xbin",
    "LD_LIBRARY_PATH" to nativeDirectory.canonicalPath,
    "LD_PRELOAD" to nativePreloadLibrary.canonicalPath,
    "LANG" to "C.UTF-8",
    "CODEY_NVIM" to "1",
    "CODEY_NVIM_BIN_DIR" to commandDirectory.canonicalPath,
    "CODEY_NVIM_NATIVE_DIR" to nativeDirectory.canonicalPath,
    "CODEY_NVIM_DATA_DIR" to bundle.runtimeDirectory.canonicalPath,
    "CODEY_NVIM_TREESITTER_RTP" to bundle.treeSitterRuntime.canonicalPath,
    "CODEY_NVIM_TREESITTER_REV" to metadata.treeSitterCommit,
    "CODEY_LUALS_BOOTSTRAP" to bundle.luaLsBootstrap.canonicalPath,
    "CODEY_NVIM_LUALS_MAIN" to bundle.luaLsMain.canonicalPath,
    "GIT_EXEC_PATH" to commandDirectory.canonicalPath,
    "GIT_TEMPLATE_DIR" to bundle.resolve(metadata.data.gitTemplates).canonicalPath,
    "GIT_SSL_CAINFO" to caBundle.canonicalPath,
    "SSL_CERT_FILE" to caBundle.canonicalPath,
    "CURL_CA_BUNDLE" to caBundle.canonicalPath,
    "OPENSSL_CONF" to bundle.resolve(metadata.data.opensslConfig).canonicalPath,
    "GIT_CONFIG_NOSYSTEM" to "1",
    "GIT_ATTR_NOSYSTEM" to "1",
    "GIT_TERMINAL_PROMPT" to "0",
    "GIT_PAGER" to "cat",
    "PAGER" to "cat"
  )
}

private const val STRICT_CONFIG_CHECK =
  "lua if vim.v.errmsg ~= '' then io.stderr:write('Codey config startup failed: ' .. " +
    "vim.v.errmsg .. '\\n'); vim.cmd('cquit 1') end"

private fun configProfileKey(directory: File): String = MessageDigest.getInstance("SHA-256")
  .digest(directory.canonicalPath.toByteArray(Charsets.UTF_8))
  .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

internal class NvimCommandAliasInstaller(
  private val context: Context,
  private val createSymbolicLink: (File, File) -> Unit = { link, target ->
    Files.createSymbolicLink(link.toPath(), target.toPath())
  }
) {
  @Synchronized
  fun installIfNeeded(bundle: InstalledNvimBundle, nativeDirectory: File): File {
    val nativeRoot = nativeDirectory.canonicalFile
    val dispatcher = File(nativeRoot, bundle.metadata.dispatcher).canonicalFile
    check(dispatcher.parentFile == nativeRoot && dispatcher.isFile && dispatcher.canExecute()) {
      "Bundled command dispatcher is unavailable"
    }

    val fingerprint = aliasFingerprint(bundle.metadata, nativeRoot)
    val installRoot = File(context.filesDir, "$PRIVATE_ROOT/commands").ensureDirectory()
    val destination = File(
      installRoot,
      "commands-${sanitizeVersion(bundle.metadata.version)}-${fingerprint.take(DIGEST_PATH_LENGTH)}"
    )
    if (validInstallation(destination, fingerprint, dispatcher, bundle)) {
      pruneInstallations(installRoot, destination)
      return destination.canonicalFile
    }

    destination.deleteRecursively()
    val staging = File(installRoot, ".partial-${UUID.randomUUID()}")
    check(staging.mkdirs()) { "Unable to create command alias staging directory" }
    try {
      for (alias in bundle.metadata.commands.keys) {
        createSymbolicLink(File(staging, alias), dispatcher)
      }
      for (supportName in GIT_SHELL_SUPPORT_FILES) {
        val target = bundle.resolve("${bundle.metadata.data.gitCore}/$supportName")
        check(target.isFile && target.canRead()) { "Bundled Git support file is missing: $supportName" }
        createSymbolicLink(File(staging, supportName), target)
      }
      File(staging, COMPLETE_MARKER).writeText("$fingerprint\n")
      if (!staging.renameTo(destination)) {
        if (validInstallation(destination, fingerprint, dispatcher, bundle)) {
          staging.deleteRecursively()
        } else {
          throw IOException("Unable to activate command aliases")
        }
      }
      check(validInstallation(destination, fingerprint, dispatcher, bundle)) {
        "Installed command aliases failed validation"
      }
      pruneInstallations(installRoot, destination)
      return destination.canonicalFile
    } catch (error: Throwable) {
      staging.deleteRecursively()
      throw error
    }
  }

  private fun validInstallation(
    directory: File,
    fingerprint: String,
    dispatcher: File,
    bundle: InstalledNvimBundle
  ): Boolean {
    if (!directory.isDirectory) return false
    if (File(directory, COMPLETE_MARKER).readTextOrNull()?.trim() != fingerprint) return false
    for (alias in bundle.metadata.commands.keys) {
      val link = File(directory, alias)
      if (!Files.isSymbolicLink(link.toPath())) return false
      if (runCatching { link.canonicalFile }.getOrNull() != dispatcher) return false
    }
    for (supportName in GIT_SHELL_SUPPORT_FILES) {
      val link = File(directory, supportName)
      val expected = bundle.resolve("${bundle.metadata.data.gitCore}/$supportName")
      if (!Files.isSymbolicLink(link.toPath())) return false
      if (runCatching { link.canonicalFile }.getOrNull() != expected) return false
    }
    return true
  }

  private fun pruneInstallations(installRoot: File, active: File) {
    installRoot.listFiles()?.forEach { candidate ->
      if (candidate != active &&
        (candidate.name.startsWith("commands-") || candidate.name.startsWith(".partial-"))
      ) {
        candidate.deleteRecursively()
      }
    }
  }

  private companion object {
    const val PRIVATE_ROOT = "codey-nvim"
    const val COMPLETE_MARKER = ".complete"
    const val DIGEST_PATH_LENGTH = 16
  }
}

private fun aliasFingerprint(metadata: NvimBundleMetadata, nativeDirectory: File): String {
  val description = buildString {
    append(metadata.schemaVersion).append('\n')
    append(metadata.version).append('\n')
    append(metadata.runtimeSha256).append('\n')
    append(metadata.dispatcher).append('\n')
    append(nativeDirectory.canonicalPath).append('\n')
    metadata.commands.forEach { (alias, target) ->
      append(alias).append('=')
      when (target) {
        is NvimCommandTarget.Elf -> append("elf:").append(target.nativeLibrary)
        is NvimCommandTarget.Script -> append("script:").append(target.relativePath)
      }
      append('\n')
    }
  }
  return sha256(description.toByteArray(Charsets.UTF_8))
}

internal class NvimRuntimeInstaller(
  private val context: Context,
  private val openAsset: (String) -> InputStream = { path -> context.assets.open(path) }
) {
  @Synchronized
  fun isBundlePresent(): Boolean = runCatching {
    readMetadata()
    openAsset(RUNTIME_ZIP_ASSET).close()
  }.isSuccess

  @Synchronized
  fun bundleUnavailableReason(nativeDirectory: File): String? {
    val metadata = try {
      readMetadata()
    } catch (_: Throwable) {
      return "The bundled NeoVim runtime metadata is missing or invalid"
    }
    try {
      openAsset(RUNTIME_ZIP_ASSET).close()
    } catch (_: Throwable) {
      return "The bundled NeoVim runtime is missing"
    }
    return validatePackagedNativeBundle(metadata, nativeDirectory)
  }

  @Synchronized
  fun installIfNeeded(): InstalledNvimBundle {
    val metadata = readMetadata()
    val installRoot = File(context.filesDir, "$PRIVATE_ROOT/runtimes").ensureDirectory()
    val destination = File(
      installRoot,
      "runtime-${sanitizeVersion(metadata.version)}-${metadata.runtimeSha256.take(DIGEST_PATH_LENGTH)}"
    )
    val marker = File(destination, COMPLETE_MARKER)
    if (destination.isDirectory &&
      marker.readTextOrNull()?.trim() == metadata.runtimeSha256 &&
      runCatching { validateInstalledBundle(destination, metadata) }.isSuccess
    ) {
      return InstalledNvimBundle(destination.canonicalFile, metadata)
    }

    verifyRuntimeDigest(metadata.runtimeSha256)
    destination.deleteRecursively()
    val staging = File(installRoot, ".partial-${UUID.randomUUID()}")
    check(staging.mkdirs()) { "Unable to create private NeoVim runtime staging directory" }
    try {
      extractRuntime(staging)
      validateInstalledBundle(staging, metadata)
      File(staging, COMPLETE_MARKER).writeText("${metadata.runtimeSha256}\n")
      if (!staging.renameTo(destination)) {
        if (destination.isDirectory &&
          marker.readTextOrNull()?.trim() == metadata.runtimeSha256 &&
          runCatching { validateInstalledBundle(destination, metadata) }.isSuccess
        ) {
          staging.deleteRecursively()
          return InstalledNvimBundle(destination.canonicalFile, metadata)
        }
        throw IOException("Unable to activate private NeoVim runtime")
      }
      return InstalledNvimBundle(destination.canonicalFile, metadata)
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
    return parseNvimBundleMetadata(properties)
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

  private companion object {
    const val PRIVATE_ROOT = "codey-nvim"
    const val BUNDLE_PROPERTIES_ASSET = "codey-nvim/bundle.properties"
    const val RUNTIME_ZIP_ASSET = "codey-nvim/runtime.zip"
    const val COMPLETE_MARKER = ".complete"
    const val COPY_BUFFER_BYTES = 32 * 1024
    const val DIGEST_PATH_LENGTH = 16
  }
}

internal fun parseNvimBundleMetadata(properties: Properties): NvimBundleMetadata {
  fun required(key: String): String = properties.getProperty(key)?.trim().orEmpty().also {
    require(it.isNotEmpty()) { "Bundled NeoVim metadata is missing $key" }
  }

  val schemaVersion = required("schemaVersion")
  require(schemaVersion == BUNDLE_SCHEMA_VERSION.toString()) {
    "Unsupported bundled NeoVim metadata schema: $schemaVersion"
  }
  val version = required("version")
  require(VERSION_PATTERN.matches(version)) { "Bundled NeoVim version is invalid" }
  val runtimeSha256 = required("runtimeSha256").lowercase()
  require(SHA256_PATTERN.matches(runtimeSha256)) { "Bundled NeoVim runtime SHA-256 is invalid" }
  val kickstartCommit = required("kickstartCommit").lowercase()
  require(GIT_COMMIT_PATTERN.matches(kickstartCommit)) { "Bundled Kickstart commit is invalid" }
  val treeSitterCommit = required("treeSitterCommit").lowercase()
  require(GIT_COMMIT_PATTERN.matches(treeSitterCommit)) {
    "Bundled nvim-treesitter commit is invalid"
  }
  val dispatcher = required("dispatcher")
  require(dispatcher == DISPATCHER_LIBRARY_NAME) { "Bundled command dispatcher is invalid" }

  val nativeLibraries = parseMetadataList("nativeLibraries", required("nativeLibraries"))
  require(nativeLibraries == nativeLibraries.sorted() &&
    nativeLibraries.distinct().size == nativeLibraries.size &&
    nativeLibraries.all(NATIVE_BUNDLE_LIBRARY_PATTERN::matches)
  ) {
    "Bundled native-library list is invalid"
  }

  val commandNames = parseMetadataList("commands", required("commands"))
  require(commandNames == REQUIRED_COMMANDS) { "Bundled command list is invalid" }
  val commands = linkedMapOf<String, NvimCommandTarget>()
  for (alias in commandNames) {
    val value = required("command.$alias")
    val separator = value.indexOf(':')
    require(separator > 0 && separator < value.lastIndex) {
      "Bundled command target is invalid: $alias"
    }
    val kind = value.substring(0, separator)
    val target = value.substring(separator + 1)
    val parsed = when (kind) {
      "elf" -> {
        require(alias != SCRIPT_COMMAND) { "Bundled command target is invalid: $alias" }
        require(NATIVE_LIBRARY_PATTERN.matches(target)) {
          "Bundled command native library is invalid: $alias"
        }
        NvimCommandTarget.Elf(target)
      }
      "script" -> {
        require(alias == SCRIPT_COMMAND && target == SCRIPT_COMMAND_PATH) {
          "Bundled command script is invalid: $alias"
        }
        NvimCommandTarget.Script(target)
      }
      else -> throw IllegalArgumentException("Bundled command target type is invalid: $alias")
    }
    commands[alias] = parsed
  }

  val parserNames = parseMetadataList("parsers", required("parsers"))
  require(parserNames == REQUIRED_PARSERS) { "Bundled Tree-sitter parser list is invalid" }
  val parsers = linkedMapOf<String, String>()
  for (language in parserNames) {
    val nativeLibrary = required("parser.$language")
    require(nativeLibrary == "libcodey_ts_${language}.so") {
      "Bundled Tree-sitter parser library is invalid: $language"
    }
    parsers[language] = nativeLibrary
  }
  val requiredNativeLibraries = buildSet {
    add(NVIM_LIBRARY_NAME)
    add(LUAJIT_LIBRARY_NAME)
    add(dispatcher)
    commands.values.filterIsInstance<NvimCommandTarget.Elf>().forEach { add(it.nativeLibrary) }
    addAll(parsers.values)
  }
  require(nativeLibraries.containsAll(requiredNativeLibraries)) {
    "Bundled native-library list is incomplete"
  }

  val dataValues = EXPECTED_DATA_PATHS.mapValues { (key, expected) ->
    required("data.$key").also { actual ->
      require(actual == expected && isSafeRelativePath(actual)) {
        "Bundled NeoVim data path is invalid: $key"
      }
    }
  }
  val expectedKeys = buildSet {
    addAll(BASE_METADATA_KEYS)
    commandNames.forEach { add("command.$it") }
    parserNames.forEach { add("parser.$it") }
    EXPECTED_DATA_PATHS.keys.forEach { add("data.$it") }
  }
  require(properties.stringPropertyNames() == expectedKeys) {
    "Bundled NeoVim metadata contains unexpected keys"
  }

  return NvimBundleMetadata(
    schemaVersion = BUNDLE_SCHEMA_VERSION,
    version = version,
    runtimeSha256 = runtimeSha256,
    kickstartCommit = kickstartCommit,
    treeSitterCommit = treeSitterCommit,
    dispatcher = dispatcher,
    nativeLibraries = nativeLibraries,
    commands = commands,
    parsers = parsers,
    data = NvimBundleData(
      gitCore = checkNotNull(dataValues["gitCore"]),
      gitTemplates = checkNotNull(dataValues["gitTemplates"]),
      caBundle = checkNotNull(dataValues["caBundle"]),
      opensslConfig = checkNotNull(dataValues["opensslConfig"]),
      luaLsBootstrap = checkNotNull(dataValues["luaLsBootstrap"]),
      luaLsMain = checkNotNull(dataValues["luaLsMain"]),
      treeSitterRuntime = checkNotNull(dataValues["treeSitterRuntime"])
    )
  )
}

internal fun validatePackagedNativeBundle(
  metadata: NvimBundleMetadata,
  nativeDirectory: File
): String? {
  val nativeRoot = try {
    nativeDirectory.canonicalFile
  } catch (_: IOException) {
    return "The bundled native-library directory is unavailable"
  }
  val dispatcher = File(nativeRoot, metadata.dispatcher)
  if (!dispatcher.isFile) return "The bundled command dispatcher is missing"
  if (!dispatcher.canExecute()) return "Android did not extract the bundled command dispatcher"

  for (nativeLibrary in metadata.nativeLibraries) {
    val file = File(nativeRoot, nativeLibrary)
    if (!file.isFile || !file.canRead()) {
      return "The bundled native library is missing: $nativeLibrary"
    }
  }

  metadata.commands.forEach { (alias, target) ->
    if (target !is NvimCommandTarget.Elf) return@forEach
    val executable = File(nativeRoot, target.nativeLibrary)
    if (!executable.isFile) return "The bundled command executable is missing: $alias"
    if (!executable.canExecute()) return "Android did not extract the bundled command executable: $alias"
  }
  metadata.parsers.forEach { (language, nativeLibrary) ->
    val parser = File(nativeRoot, nativeLibrary)
    if (!parser.isFile || !parser.canRead()) {
      return "The bundled Tree-sitter parser is missing: $language"
    }
  }
  return null
}

private fun validateInstalledBundle(directory: File, metadata: NvimBundleMetadata) {
  val bundle = InstalledNvimBundle(directory.canonicalFile, metadata)
  fun requireDirectory(relativePath: String, description: String) {
    val value = bundle.resolve(relativePath)
    require(value.isDirectory && value.canRead()) { "Bundled $description directory is missing" }
  }
  fun requireFile(relativePath: String, description: String) {
    val value = bundle.resolve(relativePath)
    require(value.isFile && value.canRead()) { "Bundled $description is missing" }
    require(!value.canExecute()) { "Bundled $description must not be executable" }
  }

  requireDirectory(metadata.data.gitCore, "Git core")
  requireDirectory(metadata.data.gitTemplates, "Git templates")
  requireDirectory(metadata.data.treeSitterRuntime, "nvim-treesitter runtime")
  requireFile(metadata.data.caBundle, "CA bundle")
  requireFile(metadata.data.opensslConfig, "OpenSSL configuration")
  requireFile(metadata.data.luaLsBootstrap, "Lua language server bootstrap")
  requireFile(metadata.data.luaLsMain, "Lua language server entry point")
  GIT_SHELL_SUPPORT_FILES.forEach { supportName ->
    requireFile("${metadata.data.gitCore}/$supportName", "Git support file $supportName")
  }
  metadata.commands.values.filterIsInstance<NvimCommandTarget.Script>().forEach { target ->
    requireFile(target.relativePath, "command script")
  }
}

private fun parseMetadataList(key: String, value: String): List<String> {
  val items = value.split(',').map(String::trim)
  require(items.all { it.isNotEmpty() } && items.distinct().size == items.size) {
    "Bundled NeoVim metadata list is invalid: $key"
  }
  return items
}

private fun isSafeRelativePath(path: String): Boolean =
  path.isNotBlank() &&
    !path.startsWith('/') &&
    '\\' !in path &&
    '\u0000' !in path &&
    path.split('/').all { it.isNotEmpty() && it != "." && it != ".." }

private const val BUNDLE_SCHEMA_VERSION = 2
private const val CODEY_TOOLS_DIRECTORY = "codey-tools"
private const val DISPATCHER_LIBRARY_NAME = "libcodey_exec_dispatcher.so"
private const val NVIM_LIBRARY_NAME = "libcodey_nvim.so"
private const val LUAJIT_LIBRARY_NAME = "libluajit-5.1.so"
private const val SCRIPT_COMMAND = "git-submodule"
private const val SCRIPT_COMMAND_PATH = "codey-tools/git-core/git-submodule"
private val GIT_SHELL_SUPPORT_FILES = listOf("git-sh-setup", "git-sh-i18n")
private val REQUIRED_COMMANDS = listOf(
  "git",
  "git-remote-http",
  "git-remote-https",
  "git-sh-i18n--envsubst",
  "git-submodule",
  "rg",
  "stylua",
  "lua-language-server"
)
private val REQUIRED_PARSERS = listOf(
  "bash",
  "c",
  "diff",
  "html",
  "lua",
  "luadoc",
  "markdown",
  "markdown_inline",
  "query",
  "vim",
  "vimdoc"
)
private val EXPECTED_DATA_PATHS = linkedMapOf(
  "gitCore" to "codey-tools/git-core",
  "gitTemplates" to "codey-tools/git-templates",
  "caBundle" to "codey-tools/tls/cert.pem",
  "opensslConfig" to "codey-tools/tls/openssl.cnf",
  "luaLsBootstrap" to "codey-tools/lua-language-server/bin/main.lua",
  "luaLsMain" to "codey-tools/lua-language-server/main.lua",
  "treeSitterRuntime" to "codey-treesitter"
)
private val BASE_METADATA_KEYS = setOf(
  "schemaVersion",
  "version",
  "runtimeSha256",
  "kickstartCommit",
  "treeSitterCommit",
  "dispatcher",
  "nativeLibraries",
  "commands",
  "parsers"
)
private val SHA256_PATTERN = Regex("^[0-9a-f]{64}$")
private val GIT_COMMIT_PATTERN = Regex("^[0-9a-f]{40}$")
private val VERSION_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$")
private val NATIVE_LIBRARY_PATTERN = Regex("^libcodey_[a-z0-9_]+\\.so$")
private val NATIVE_BUNDLE_LIBRARY_PATTERN = Regex("^lib[A-Za-z0-9_.+-]+\\.so$")

private fun File.ensureDirectory(): File {
  check((isDirectory || mkdirs()) && isDirectory) { "Unable to create directory: $path" }
  return this
}

private fun File.readTextOrNull(): String? = runCatching { readText() }.getOrNull()

private fun sanitizeVersion(version: String): String =
  version.replace(Regex("[^A-Za-z0-9._-]"), "_").take(64).ifBlank { "unknown" }

private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
  .digest(bytes)
  .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
