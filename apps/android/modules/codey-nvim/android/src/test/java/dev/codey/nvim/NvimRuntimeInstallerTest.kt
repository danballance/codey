package dev.codey.nvim

import android.content.Context
import android.content.ContextWrapper
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileNotFoundException
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.io.path.createTempDirectory
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
    val runtimeZip = runtimeZip(
      "autoload/" to null,
      "autoload/provider.vim" to "let g:loaded_provider = 1\n".toByteArray(),
      "doc/help.txt" to "Codey runtime help\n".toByteArray()
    )
    val assets = RuntimeAssets(version = "0.11.3", runtimeZip = runtimeZip)
    val installer = NvimRuntimeInstaller(context, assets::open)

    val installed = installer.installIfNeeded()

    assertTrue(installed.isDirectory)
    assertArrayEquals(
      "let g:loaded_provider = 1\n".toByteArray(),
      File(installed, "autoload/provider.vim").readBytes()
    )
    assertEquals("Codey runtime help\n", File(installed, "doc/help.txt").readText())
    assertEquals(assets.digest, File(installed, ".complete").readText().trim())
    assertEquals(installed.canonicalFile, installer.installIfNeeded())
    assertEquals(2, assets.runtimeOpenCount)
  }

  @Test
  fun `rejects a runtime whose bytes do not match the declared digest`() {
    val runtimeZip = runtimeZip("runtime/file.vim" to "set compatible\n".toByteArray())
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
    val runtimeZip = runtimeZip(
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
    val runtimeZip = runtimeZip("runtime/defaults.vim" to "set encoding=utf-8\n".toByteArray())
    val assets = RuntimeAssets(version = "0.11.3-test+recovery", runtimeZip = runtimeZip)
    val destination = File(
      runtimeRoot(),
      "runtime-0.11.3-test_recovery-${assets.digest.take(16)}"
    )
    assertTrue(destination.mkdirs())
    File(destination, "stale-partial-file").writeText("interrupted")

    val installed = NvimRuntimeInstaller(context, assets::open).installIfNeeded()

    assertEquals(destination.canonicalFile, installed)
    assertFalse(File(installed, "stale-partial-file").exists())
    assertEquals("set encoding=utf-8\n", File(installed, "runtime/defaults.vim").readText())
    assertEquals(assets.digest, File(installed, ".complete").readText().trim())
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

    private val metadata = "version=$version\nruntimeSha256=$declaredDigest\n".toByteArray()

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
