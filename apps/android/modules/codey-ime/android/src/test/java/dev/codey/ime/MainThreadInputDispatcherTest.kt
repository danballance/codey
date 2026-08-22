package dev.codey.ime

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class MainThreadInputDispatcherTest {
  @Test
  fun `rapid mixed paths preserve queued composition before ordered and hardware input`() {
    val mainQueue = LinkedBlockingQueue<Runnable>()
    val dispatcher = MainThreadInputDispatcher(
      isMainThread = { false },
      enqueue = mainQueue::offer
    )
    val inputConnections = ImeConnectionGeneration()
    val originalGeneration = inputConnections.openConnection()
    val deliveries = mutableListOf<String>()
    var sequence = 1L
    var replacementGeneration = 0L
    val processor = ImeInputProcessor { signal ->
      deliveries += when (signal) {
        is ImeSignal.CommittedText -> "${sequence++}:text:${signal.text}"
        is ImeSignal.Key -> "${sequence++}:key:${signal.key}"
      }
    }

    val queuedTasks = mutableListOf<Runnable>()
    val callers = mutableListOf<Thread>()
    fun queueInput(callback: () -> Unit) {
      callers += Thread {
        dispatcher.run {
          inputConnections.serialized(callback)
        }
      }.apply { start() }
      val task = mainQueue.poll(2, TimeUnit.SECONDS)
      assertNotNull("input path did not reach the main queue", task)
      queuedTasks += task!!
    }

    // Queue every path before running the simulated main loop. Composition
    // callbacks queued ahead of the Action Pad transaction must not be lost.
    queueInput {
      inputConnections.dispatch(originalGeneration) {
        processor.setComposingText("rea", newCursorPosition = 1)
      }
    }
    queueInput {
      inputConnections.dispatch(originalGeneration) {
        processor.setComposingText("ready", newCursorPosition = 1)
      }
    }
    queueInput {
      val batch = processor.orderedInput("<Esc>")!!
      inputConnections.invalidate()
      deliveries += "${sequence++}:ordered:${batch.segments}"
    }
    queueInput {
      inputConnections.dispatch(originalGeneration) {
        processor.commitText("stale")
      }
    }
    queueInput {
      replacementGeneration = inputConnections.openConnection()
    }
    queueInput {
      inputConnections.dispatch(replacementGeneration) {
        processor.commitText("next")
      }
    }
    queueInput {
      processor.hardwareKey("Enter", ImeModifiers(), repeat = false)
    }

    queuedTasks.forEach(Runnable::run)
    callers.forEach { caller ->
      caller.join(2_000)
      assertEquals(false, caller.isAlive)
    }

    assertEquals(
      listOf(
        "1:ordered:[Text(text=ready), Input(keys=<Esc>)]",
        "2:text:next",
        "3:key:Enter"
      ),
      deliveries
    )
  }
}
