package dev.codey.ime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ImeConnectionGenerationTest {
  @Test
  fun `callbacks from replaced and explicitly invalidated connections are ignored`() {
    val generations = ImeConnectionGeneration()
    val first = generations.openConnection()
    val second = generations.openConnection()
    var calls = 0

    assertTrue(generations.dispatch(first) { calls += 1; false })
    assertEquals(false, generations.dispatch(second) { calls += 1; false })
    generations.invalidate()
    assertTrue(generations.dispatch(second) { calls += 1; false })

    assertEquals(1, calls)
  }
}
