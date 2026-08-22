package dev.codey.ime

/**
 * Serializes input-connection callbacks with invalidation. Android can finish
 * dispatching callbacks from an old BaseInputConnection after restartInput.
 */
internal class ImeConnectionGeneration {
  private val lock = Any()
  private var current = 0L

  fun openConnection(): Long = synchronized(lock) {
    current = next(current)
    current
  }

  fun invalidate(): Long = synchronized(lock) {
    current = next(current)
    current
  }

  fun current(): Long = synchronized(lock) { current }

  fun dispatch(generation: Long, callback: () -> Boolean): Boolean = synchronized(lock) {
    if (generation != current) true else callback()
  }

  fun <T> serialized(callback: () -> T): T = synchronized(lock) { callback() }

  private fun next(value: Long): Long = if (value == Long.MAX_VALUE) 1L else value + 1L
}
