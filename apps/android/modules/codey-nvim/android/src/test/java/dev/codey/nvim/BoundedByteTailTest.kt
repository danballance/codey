package dev.codey.nvim

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BoundedByteTailTest {
  @Test
  fun `keeps only the most recent bytes across appends`() {
    val tail = BoundedByteTail(5)

    tail.append(byteArrayOf(1, 2, 3))
    tail.append(byteArrayOf(4, 5, 6, 7))

    assertArrayEquals(byteArrayOf(3, 4, 5, 6, 7), tail.toByteArray())
  }

  @Test
  fun `a single oversized append replaces the previous tail`() {
    val tail = BoundedByteTail(4)
    tail.append(byteArrayOf(9, 9))

    tail.append(byteArrayOf(0, 1, 2, 3, 4, 5))

    assertArrayEquals(byteArrayOf(2, 3, 4, 5), tail.toByteArray())
  }

  @Test
  fun `validates capacity and append length`() {
    assertTrue(runCatching { BoundedByteTail(0) }.isFailure)
    val tail = BoundedByteTail(4)
    assertTrue(runCatching { tail.append(byteArrayOf(1), 2) }.isFailure)
    assertEquals(0, tail.toByteArray().size)
  }
}
