package dev.codey.ime

import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.FutureTask

/**
 * Gives every native input path the same main-thread ordering boundary.
 * Background callers wait for their queued work so an InputConnection method
 * still returns the Boolean produced by the processor.
 */
internal class MainThreadInputDispatcher(
  private val isMainThread: () -> Boolean,
  private val enqueue: (Runnable) -> Boolean
) {
  fun <T> run(callback: () -> T): T {
    if (isMainThread()) return callback()

    val task = FutureTask(Callable(callback))
    check(enqueue(task)) { "Unable to enqueue input work on the main thread" }
    return try {
      task.get()
    } catch (error: InterruptedException) {
      Thread.currentThread().interrupt()
      throw IllegalStateException("Interrupted while waiting for main-thread input dispatch", error)
    } catch (error: ExecutionException) {
      throw error.cause ?: error
    }
  }
}
