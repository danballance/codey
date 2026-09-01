package dev.codey.nvim

import java.io.File
import kotlin.io.path.createTempDirectory
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class LocalNvimConfigurationTest {
  private lateinit var testRoot: File

  @Before
  fun setUp() {
    testRoot = createTempDirectory("codey-local-config-test-").toFile()
  }

  @After
  fun tearDown() {
    testRoot.deleteRecursively()
  }

  @Test
  fun `blank selection is rejected before launch`() {
    assertEquals(
      "Choose a local config folder",
      assertThrows(IllegalArgumentException::class.java) {
        resolveLocalNvimConfiguration("  ")
      }.message
    )
    assertEquals(
      listOf("/app/libcodey_nvim.so", "--clean", "--embed"),
      nvimCommand("/app/libcodey_nvim.so", configured = false)
    )
  }

  @Test
  fun `an existing folder without init lua also launches clean`() {
    val config = File(testRoot, "Codey Config").apply { mkdirs() }

    val resolved = resolveLocalNvimConfiguration(config.path)

    assertEquals(config.canonicalFile, resolved?.directory)
    assertNull(resolved?.initFile)
    assertEquals(
      listOf("/app/libcodey_nvim.so", "--clean", "--embed"),
      nvimCommand("/app/libcodey_nvim.so", configured = resolved?.initFile != null)
    )
  }

  @Test
  fun `a readable init lua enables embedded configured startup and strict error checking`() {
    val config = File(testRoot, "Codey Config").apply { mkdirs() }
    val init = File(config, "init.lua").apply { writeText("vim.o.number = true\n") }

    val resolved = resolveLocalNvimConfiguration(config.path)
    val command = nvimCommand("/app/libcodey_nvim.so", configured = resolved?.initFile != null)

    assertEquals(config.canonicalFile, resolved?.directory)
    assertEquals(init.canonicalFile, resolved?.initFile)
    val configRoot = localNvimConfigRoot(checkNotNull(resolved).directory)
    assertEquals(config.canonicalFile.parentFile, configRoot.xdgConfigHome)
    assertEquals(config.name, configRoot.appName)
    assertEquals(config.canonicalFile, File(configRoot.xdgConfigHome, configRoot.appName))
    assertEquals("/app/libcodey_nvim.so", command.first())
    assertTrue("--embed" in command)
    assertTrue("--clean" !in command)
    assertTrue(command.any { it.contains("v:errmsg") })
    assertTrue(command.any { it.contains("cquit 1") })
  }

  @Test
  fun `invalid config roots and non-file init lua are rejected before launch`() {
    val missing = File(testRoot, "missing")
    val file = File(testRoot, "config.lua").apply { writeText("return {}\n") }
    val unreadable = File(testRoot, "unreadable").apply {
      mkdirs()
      check(setReadable(false, false))
    }
    val unwritable = File(testRoot, "unwritable").apply {
      mkdirs()
      check(setWritable(false, false))
    }
    val config = File(testRoot, "directory").apply { mkdirs() }
    File(config, "init.lua").mkdirs()

    try {
      assertEquals(
        "Local config folder does not exist",
        assertThrows(IllegalArgumentException::class.java) {
          resolveLocalNvimConfiguration(missing.path)
        }.message
      )
      assertEquals(
        "Local config folder is not a directory",
        assertThrows(IllegalArgumentException::class.java) {
          resolveLocalNvimConfiguration(file.path)
        }.message
      )
      assertEquals(
        "Local config folder is not readable",
        assertThrows(IllegalArgumentException::class.java) {
          resolveLocalNvimConfiguration(unreadable.path)
        }.message
      )
      assertEquals(
        "Local config folder is not writable",
        assertThrows(IllegalArgumentException::class.java) {
          resolveLocalNvimConfiguration(unwritable.path)
        }.message
      )
      assertEquals(
        "Local init.lua is not a regular file",
        assertThrows(IllegalArgumentException::class.java) {
          resolveLocalNvimConfiguration(config.path)
        }.message
      )
    } finally {
      unreadable.setReadable(true, false)
      unwritable.setWritable(true, false)
    }
  }
}
