package dev.codey.nvim

import android.content.Context
import android.content.ContextWrapper
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.nio.file.Files
import java.security.MessageDigest
import java.util.Properties
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.io.path.createTempDirectory
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NvimRuntimeInstallerTest {
  private lateinit var testRoot: File
  private lateinit var context: Context

  @Before
  fun setUp() {
    testRoot = createTempDirectory("codey-nvim-runtime-test-").toFile()
    context = FilesContext(RuntimeEnvironment.getApplication(), File(testRoot, "files"))
  }

  @After
  fun tearDown() {
    testRoot.deleteRecursively()
  }

  @Test
  fun `installs a valid digest-verified runtime and reuses its completion marker`() {
    val runtimeZip = validRuntimeZip(
      "autoload/" to null,
      "autoload/provider.vim" to "let g:loaded_provider = 1\n".toByteArray(),
      "doc/help.txt" to "Codey runtime help\n".toByteArray()
    )
    val assets = RuntimeAssets(version = "0.11.3", runtimeZip = runtimeZip)
    val installer = NvimRuntimeInstaller(context, assets::open)

    val installed = installer.installIfNeeded()

    assertTrue(installed.runtimeDirectory.isDirectory)
    assertArrayEquals(
      "let g:loaded_provider = 1\n".toByteArray(),
      File(installed.runtimeDirectory, "autoload/provider.vim").readBytes()
    )
    assertEquals("Codey runtime help\n", File(installed.runtimeDirectory, "doc/help.txt").readText())
    assertEquals(assets.digest, File(installed.runtimeDirectory, ".complete").readText().trim())
    assertEquals(installed, installer.installIfNeeded())
    assertEquals(2, installed.metadata.schemaVersion)
    assertEquals(TREE_SITTER_COMMIT, installed.metadata.treeSitterCommit)
    assertEquals(2, assets.runtimeOpenCount)
  }

  @Test
  fun `rejects a runtime whose bytes do not match the declared digest`() {
    val runtimeZip = validRuntimeZip("runtime/file.vim" to "set compatible\n".toByteArray())
    val assets = RuntimeAssets(
      version = "0.11.3",
      runtimeZip = runtimeZip,
      declaredDigest = "0".repeat(64)
    )
    val installer = NvimRuntimeInstaller(context, assets::open)

    val error = runCatching { installer.installIfNeeded() }.exceptionOrNull()

    assertTrue(error is IllegalStateException)
    assertEquals("Bundled NeoVim runtime failed its SHA-256 check", error?.message)
    assertFalse(runtimeRoot().walkTopDown().any { it.name.startsWith(".partial-") })
  }

  @Test
  fun `rejects zip-slip paths without writing outside the staging directory`() {
    val runtimeZip = validRuntimeZip(
      "runtime/good.vim" to "set nocompatible\n".toByteArray(),
      "../escaped.txt" to "must not escape\n".toByteArray()
    )
    val assets = RuntimeAssets(version = "0.11.3", runtimeZip = runtimeZip)
    val installer = NvimRuntimeInstaller(context, assets::open)

    val error = runCatching { installer.installIfNeeded() }.exceptionOrNull()

    assertTrue(error is IllegalArgumentException)
    assertEquals("Bundled NeoVim runtime contains an unsafe path", error?.message)
    assertFalse(File(runtimeRoot(), "escaped.txt").exists())
    assertFalse(runtimeRoot().walkTopDown().any { it.name.startsWith(".partial-") })
  }

  @Test
  fun `replaces an incomplete destination and finishes the interrupted install`() {
    val runtimeZip = validRuntimeZip("runtime/defaults.vim" to "set encoding=utf-8\n".toByteArray())
    val assets = RuntimeAssets(version = "0.11.3-test+recovery", runtimeZip = runtimeZip)
    val destination = File(
      runtimeRoot(),
      "runtime-0.11.3-test_recovery-${assets.digest.take(16)}"
    )
    assertTrue(destination.mkdirs())
    File(destination, "stale-partial-file").writeText("interrupted")

    val installed = NvimRuntimeInstaller(context, assets::open).installIfNeeded()

    assertEquals(destination.canonicalFile, installed.runtimeDirectory)
    assertFalse(File(installed.runtimeDirectory, "stale-partial-file").exists())
    assertEquals(
      "set encoding=utf-8\n",
      File(installed.runtimeDirectory, "runtime/defaults.vim").readText()
    )
    assertEquals(assets.digest, File(installed.runtimeDirectory, ".complete").readText().trim())
  }

  @Test
  fun `rejects legacy malformed and unexpected metadata`() {
    val legacy = Properties().apply {
      setProperty("version", "0.11.3")
      setProperty("runtimeSha256", "0".repeat(64))
    }
    assertEquals(
      "Bundled NeoVim metadata is missing schemaVersion",
      assertFails { parseNvimBundleMetadata(legacy) }.message
    )

    val malformed = validMetadata("0".repeat(64)).apply {
      setProperty("treeSitterCommit", "427e922")
    }
    assertEquals(
      "Bundled nvim-treesitter commit is invalid",
      assertFails { parseNvimBundleMetadata(malformed) }.message
    )

    val duplicateNativeLibrary = validMetadata("0".repeat(64)).apply {
      setProperty(
        "nativeLibraries",
        (NATIVE_LIBRARIES + NATIVE_LIBRARIES.first()).sorted().joinToString(",")
      )
    }
    assertEquals(
      "Bundled NeoVim metadata list is invalid: nativeLibraries",
      assertFails { parseNvimBundleMetadata(duplicateNativeLibrary) }.message
    )

    val unexpected = validMetadata("0".repeat(64)).apply {
      setProperty("data.typo", "codey-tools/typo")
    }
    assertEquals(
      "Bundled NeoVim metadata contains unexpected keys",
      assertFails { parseNvimBundleMetadata(unexpected) }.message
    )
  }

  @Test
  fun `rejects unsafe or incorrect command and data mappings`() {
    val command = validMetadata("0".repeat(64)).apply {
      setProperty("command.git", "script:../git")
    }
    assertEquals(
      "Bundled command script is invalid: git",
      assertFails { parseNvimBundleMetadata(command) }.message
    )

    val parser = validMetadata("0".repeat(64)).apply {
      setProperty("parser.lua", "libcodey_ts_vim.so")
    }
    assertEquals(
      "Bundled Tree-sitter parser library is invalid: lua",
      assertFails { parseNvimBundleMetadata(parser) }.message
    )

    val data = validMetadata("0".repeat(64)).apply {
      setProperty("data.caBundle", "../cert.pem")
    }
    assertEquals(
      "Bundled NeoVim data path is invalid: caBundle",
      assertFails { parseNvimBundleMetadata(data) }.message
    )
  }

  @Test
  fun `rejects a digest-valid archive missing required tool data`() {
    val runtimeZip = runtimeZip("runtime/defaults.vim" to "set encoding=utf-8\n".toByteArray())
    val assets = RuntimeAssets(version = "0.11.3", runtimeZip = runtimeZip)

    val error = runCatching {
      NvimRuntimeInstaller(context, assets::open).installIfNeeded()
    }.exceptionOrNull()

    assertTrue(error is IllegalArgumentException)
    assertEquals("Bundled Git core directory is missing", error?.message)
    assertFalse(runtimeRoot().walkTopDown().any { it.name.startsWith(".partial-") })
  }

  @Test
  fun `validates every declared native payload and executable command`() {
    val metadata = parseNvimBundleMetadata(validMetadata("0".repeat(64)))
    val nativeDirectory = File(testRoot, "native").apply { mkdirs() }
    metadata.nativeLibraries.forEach { name ->
      File(nativeDirectory, name).apply {
        writeText(name)
        setReadable(true, false)
      }
    }
    File(nativeDirectory, metadata.dispatcher).setExecutable(true, false)
    metadata.commands.values.filterIsInstance<NvimCommandTarget.Elf>().forEach { target ->
      File(nativeDirectory, target.nativeLibrary).setExecutable(true, false)
    }

    assertNull(validatePackagedNativeBundle(metadata, nativeDirectory))

    File(nativeDirectory, "libandroid-support.so").delete()
    assertEquals(
      "The bundled native library is missing: libandroid-support.so",
      validatePackagedNativeBundle(metadata, nativeDirectory)
    )
  }

  @Test
  fun `installs versioned command aliases atomically and repairs a changed link`() {
    val runtimeZip = validRuntimeZip("runtime/defaults.vim" to "set encoding=utf-8\n".toByteArray())
    val bundle = NvimRuntimeInstaller(
      context,
      RuntimeAssets(version = "0.11.3", runtimeZip = runtimeZip)::open
    ).installIfNeeded()
    val nativeDirectory = File(testRoot, "native").apply { mkdirs() }.canonicalFile
    val dispatcher = File(nativeDirectory, bundle.metadata.dispatcher).apply {
      writeText("dispatcher")
      setExecutable(true, false)
    }.canonicalFile
    val installer = NvimCommandAliasInstaller(context)

    val installed = installer.installIfNeeded(bundle, nativeDirectory)

    assertTrue(installed.name.startsWith("commands-0.11.3-"))
    bundle.metadata.commands.keys.forEach { alias ->
      val link = File(installed, alias)
      assertTrue(Files.isSymbolicLink(link.toPath()))
      assertEquals(dispatcher, link.canonicalFile)
    }
    listOf("git-sh-setup", "git-sh-i18n").forEach { supportName ->
      val link = File(installed, supportName)
      assertTrue(Files.isSymbolicLink(link.toPath()))
      assertEquals(
        bundle.resolve("${bundle.metadata.data.gitCore}/$supportName"),
        link.canonicalFile
      )
    }

    val brokenAlias = File(installed, "rg")
    Files.delete(brokenAlias.toPath())
    brokenAlias.writeText("not a link")
    val stale = File(installed.parentFile, "commands-stale").apply { mkdirs() }
    val partial = File(installed.parentFile, ".partial-stale").apply { mkdirs() }
    val repaired = installer.installIfNeeded(bundle, nativeDirectory)

    assertEquals(installed.canonicalFile, repaired)
    assertTrue(Files.isSymbolicLink(File(repaired, "rg").toPath()))
    assertEquals(dispatcher, File(repaired, "rg").canonicalFile)
    assertFalse(stale.exists())
    assertFalse(partial.exists())
  }

  @Test
  fun `removes partial aliases when symbolic-link creation fails`() {
    val bundle = NvimRuntimeInstaller(
      context,
      RuntimeAssets(version = "0.11.3", runtimeZip = validRuntimeZip())::open
    ).installIfNeeded()
    val nativeDirectory = File(testRoot, "native-failure").apply { mkdirs() }.canonicalFile
    File(nativeDirectory, bundle.metadata.dispatcher).apply {
      writeText("dispatcher")
      setExecutable(true, false)
    }
    val installer = NvimCommandAliasInstaller(context) { _, _ ->
      throw IOException("test link failure")
    }

    val error = runCatching { installer.installIfNeeded(bundle, nativeDirectory) }.exceptionOrNull()

    assertEquals("test link failure", error?.message)
    val commandRoot = File(context.filesDir, "codey-nvim/commands")
    assertFalse(commandRoot.walkTopDown().any { it.name.startsWith(".partial-") })
  }

  @Test
  fun `composes the exact isolated toolchain environment`() {
    val bundle = NvimRuntimeInstaller(
      context,
      RuntimeAssets(version = "0.11.3", runtimeZip = validRuntimeZip())::open
    ).installIfNeeded()
    val roots = listOf(
      "commands",
      "native",
      "home",
      "config",
      "data",
      "state",
      "cache",
      "runtime",
      "tmp"
    ).associateWith { name -> File(testRoot, "environment/$name").apply { mkdirs() }.canonicalFile }
    val preload = File(checkNotNull(roots["native"]), "libluajit-5.1.so").apply { writeText("preload") }

    val environment = nvimEnvironment(
      bundle = bundle,
      commandDirectory = checkNotNull(roots["commands"]),
      nativeDirectory = checkNotNull(roots["native"]),
      home = checkNotNull(roots["home"]),
      xdgConfig = checkNotNull(roots["config"]),
      xdgData = checkNotNull(roots["data"]),
      xdgState = checkNotNull(roots["state"]),
      xdgCache = checkNotNull(roots["cache"]),
      xdgRuntime = checkNotNull(roots["runtime"]),
      temp = checkNotNull(roots["tmp"]),
      nativePreloadLibrary = preload
    )

    assertEquals("1", environment["CODEY_NVIM"])
    assertEquals(bundle.runtimeDirectory.canonicalPath, environment["CODEY_NVIM_DATA_DIR"])
    assertEquals(bundle.treeSitterRuntime.canonicalPath, environment["CODEY_NVIM_TREESITTER_RTP"])
    assertEquals(TREE_SITTER_COMMIT, environment["CODEY_NVIM_TREESITTER_REV"])
    assertEquals(bundle.luaLsBootstrap.canonicalPath, environment["CODEY_LUALS_BOOTSTRAP"])
    assertEquals(bundle.luaLsMain.canonicalPath, environment["CODEY_NVIM_LUALS_MAIN"])
    assertEquals(checkNotNull(roots["commands"]).canonicalPath, environment["GIT_EXEC_PATH"])
    assertEquals(
      "${checkNotNull(roots["commands"]).canonicalPath}:/system/bin:/system/xbin",
      environment["PATH"]
    )
    val caBundle = bundle.resolve(bundle.metadata.data.caBundle).canonicalPath
    assertEquals(caBundle, environment["GIT_SSL_CAINFO"])
    assertEquals(caBundle, environment["SSL_CERT_FILE"])
    assertEquals(caBundle, environment["CURL_CA_BUNDLE"])
    assertEquals("1", environment["GIT_CONFIG_NOSYSTEM"])
    assertEquals("1", environment["GIT_ATTR_NOSYSTEM"])
    assertEquals("0", environment["GIT_TERMINAL_PROMPT"])
    assertEquals("cat", environment["GIT_PAGER"])
    assertEquals("cat", environment["PAGER"])
  }

  private fun runtimeRoot(): File = File(context.filesDir, "codey-nvim/runtimes")

  private class FilesContext(base: Context, private val files: File) : ContextWrapper(base) {
    override fun getFilesDir(): File {
      check((files.isDirectory || files.mkdirs()) && files.isDirectory)
      return files
    }
  }

  private class RuntimeAssets(
    version: String,
    private val runtimeZip: ByteArray,
    declaredDigest: String = sha256(runtimeZip)
  ) {
    val digest = declaredDigest
    var runtimeOpenCount = 0
      private set

    private val metadata = validMetadata(declaredDigest, version).toText().toByteArray()

    fun open(path: String): ByteArrayInputStream = when (path) {
      "codey-nvim/bundle.properties" -> ByteArrayInputStream(metadata)
      "codey-nvim/runtime.zip" -> {
        runtimeOpenCount += 1
        ByteArrayInputStream(runtimeZip)
      }
      else -> throw FileNotFoundException(path)
    }
  }

  private companion object {
    val KICKSTART_COMMIT = "a".repeat(40)
    const val TREE_SITTER_COMMIT = "427e9222363d07c32d6db6169e4049c28d58d141"
    val COMMANDS = listOf(
      "git",
      "git-remote-http",
      "git-remote-https",
      "git-sh-i18n--envsubst",
      "git-submodule",
      "rg",
      "stylua",
      "lua-language-server"
    )
    val PARSERS = listOf(
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
    val NATIVE_LIBRARIES = (
      listOf(
        "libandroid-support.so",
        "libcodey_exec_dispatcher.so",
        "libcodey_git.so",
        "libcodey_git_envsubst.so",
        "libcodey_git_remote_http.so",
        "libcodey_lua_language_server.so",
        "libcodey_nvim.so",
        "libcodey_rg.so",
        "libcodey_stylua.so",
        "libluajit-5.1.so"
      ) + PARSERS.map { "libcodey_ts_${it}.so" }
      ).sorted()

    fun validRuntimeZip(vararg extraEntries: Pair<String, ByteArray?>): ByteArray = runtimeZip(
      *extraEntries,
      "codey-tools/git-core/git-submodule" to "#!/system/bin/sh\n".toByteArray(),
      "codey-tools/git-core/git-sh-setup" to "# git setup\n".toByteArray(),
      "codey-tools/git-core/git-sh-i18n" to "# git i18n\n".toByteArray(),
      "codey-tools/git-templates/hooks/readme" to "hooks\n".toByteArray(),
      "codey-tools/tls/cert.pem" to "certificate\n".toByteArray(),
      "codey-tools/tls/openssl.cnf" to "openssl_conf = default_conf\n".toByteArray(),
      "codey-tools/lua-language-server/bin/main.lua" to "return {}\n".toByteArray(),
      "codey-tools/lua-language-server/main.lua" to "return {}\n".toByteArray(),
      "codey-treesitter/queries/lua/highlights.scm" to "(comment) @comment\n".toByteArray()
    )

    fun validMetadata(digest: String, version: String = "0.11.3"): Properties = Properties().apply {
      setProperty("schemaVersion", "2")
      setProperty("version", version)
      setProperty("runtimeSha256", digest)
      setProperty("kickstartCommit", KICKSTART_COMMIT)
      setProperty("treeSitterCommit", TREE_SITTER_COMMIT)
      setProperty("dispatcher", "libcodey_exec_dispatcher.so")
      setProperty("nativeLibraries", NATIVE_LIBRARIES.joinToString(","))
      setProperty("commands", COMMANDS.joinToString(","))
      setProperty("command.git", "elf:libcodey_git.so")
      setProperty("command.git-remote-http", "elf:libcodey_git_remote_http.so")
      setProperty("command.git-remote-https", "elf:libcodey_git_remote_http.so")
      setProperty("command.git-sh-i18n--envsubst", "elf:libcodey_git_envsubst.so")
      setProperty("command.git-submodule", "script:codey-tools/git-core/git-submodule")
      setProperty("command.rg", "elf:libcodey_rg.so")
      setProperty("command.stylua", "elf:libcodey_stylua.so")
      setProperty("command.lua-language-server", "elf:libcodey_lua_language_server.so")
      setProperty("parsers", PARSERS.joinToString(","))
      PARSERS.forEach { setProperty("parser.$it", "libcodey_ts_${it}.so") }
      setProperty("data.gitCore", "codey-tools/git-core")
      setProperty("data.gitTemplates", "codey-tools/git-templates")
      setProperty("data.caBundle", "codey-tools/tls/cert.pem")
      setProperty("data.opensslConfig", "codey-tools/tls/openssl.cnf")
      setProperty("data.luaLsBootstrap", "codey-tools/lua-language-server/bin/main.lua")
      setProperty("data.luaLsMain", "codey-tools/lua-language-server/main.lua")
      setProperty("data.treeSitterRuntime", "codey-treesitter")
    }

    fun Properties.toText(): String = stringPropertyNames().sorted().joinToString(
      separator = "\n",
      postfix = "\n"
    ) { key -> "$key=${getProperty(key)}" }

    fun assertFails(block: () -> Unit): Throwable =
      checkNotNull(runCatching(block).exceptionOrNull())

    fun runtimeZip(vararg entries: Pair<String, ByteArray?>): ByteArray =
      ByteArrayOutputStream().use { bytes ->
        ZipOutputStream(bytes).use { zip ->
          entries.forEach { (name, contents) ->
            zip.putNextEntry(ZipEntry(name))
            if (contents != null) zip.write(contents)
            zip.closeEntry()
          }
        }
        bytes.toByteArray()
      }

    fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
      .digest(bytes)
      .joinToString("") { byte -> "%02x".format(byte) }
  }
}
