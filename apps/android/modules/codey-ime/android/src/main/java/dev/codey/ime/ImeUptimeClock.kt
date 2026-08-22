package dev.codey.ime

import android.os.SystemClock

/** Android performance.now() uses the uptime timebase, which excludes deep sleep. */
internal fun imeUptimeMillis(
  androidUptimeMillis: () -> Long = { SystemClock.uptimeMillis() },
  fallbackNanos: () -> Long = { System.nanoTime() }
): Double = runCatching { androidUptimeMillis().toDouble() }
  .getOrElse { fallbackNanos() / 1_000_000.0 }
