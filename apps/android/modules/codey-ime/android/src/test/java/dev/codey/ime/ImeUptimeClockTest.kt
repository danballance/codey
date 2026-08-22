package dev.codey.ime

import org.junit.Assert.assertEquals
import org.junit.Test

class ImeUptimeClockTest {
  @Test
  fun `uses Android uptime and converts the JVM fallback from nanoseconds`() {
    assertEquals(
      42.0,
      imeUptimeMillis(androidUptimeMillis = { 42L }, fallbackNanos = { error("unused") }),
      0.0
    )
    assertEquals(
      7.5,
      imeUptimeMillis(
        androidUptimeMillis = { error("Android clock unavailable") },
        fallbackNanos = { 7_500_000L }
      ),
      0.0
    )
  }
}
