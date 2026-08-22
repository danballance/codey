package dev.codey.ime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ImeInputProcessorTest {
  @Test
  fun `composition updates are suppressed and final unicode is committed once`() {
    val events = mutableListOf<ImeSignal>()
    val processor = ImeInputProcessor(events::add)

    assertTrue(processor.setComposingText("C", newCursorPosition = 1))
    assertTrue(processor.setComposingText("Codey", newCursorPosition = 1))
    assertTrue(processor.commitText("Codey tablet ✓ 👩🏽‍💻"))

    assertEquals(
      listOf(ImeSignal.CommittedText("Codey tablet ✓ 👩🏽‍💻")),
      events
    )
  }

  @Test
  fun `finish without commit emits the composed unicode once`() {
    val events = mutableListOf<ImeSignal>()
    val processor = ImeInputProcessor(events::add)

    assertTrue(processor.setComposingText("mañana 漢字", newCursorPosition = 1))
    assertTrue(processor.finishComposingText())
    assertTrue(processor.finishComposingText())

    assertEquals(listOf(ImeSignal.CommittedText("mañana 漢字")), events)
  }

  @Test
  fun `same commit after finish is preserved as a separate edit`() {
    val events = mutableListOf<ImeSignal>()
    val processor = ImeInputProcessor(events::add)

    assertTrue(processor.setComposingText("漢字", newCursorPosition = 1))
    assertTrue(processor.finishComposingText())
    assertTrue(processor.commitText("漢字"))

    assertEquals(
      listOf(
        ImeSignal.CommittedText("漢字"),
        ImeSignal.CommittedText("漢字")
      ),
      events
    )
  }

  @Test
  fun `composition correction and deletion remain local until finish`() {
    val events = mutableListOf<ImeSignal>()
    val processor = ImeInputProcessor(events::add)

    assertTrue(processor.setComposingText("teh", newCursorPosition = 1))
    assertTrue(processor.setComposingText("the", newCursorPosition = 1))
    assertTrue(processor.deleteSurroundingText(beforeLength = 1, afterLength = 0))
    assertTrue(events.isEmpty())
    assertTrue(processor.finishComposingText())

    assertEquals(listOf(ImeSignal.CommittedText("th")), events)
  }

  @Test
  fun `code point deletion removes a full surrogate pair from composition`() {
    val events = mutableListOf<ImeSignal>()
    val processor = ImeInputProcessor(events::add)

    assertTrue(processor.setComposingText("😀B", newCursorPosition = 0))
    assertTrue(
      processor.deleteSurroundingTextInCodePoints(beforeLength = 0, afterLength = 1)
    )
    assertTrue(events.isEmpty())
    assertTrue(processor.finishComposingText())

    assertEquals(listOf(ImeSignal.CommittedText("B")), events)
  }

  @Test
  fun `delete overflow edits composition locally and forwards surrounding keys`() {
    val events = mutableListOf<ImeSignal>()
    val processor = ImeInputProcessor(events::add)

    assertTrue(processor.setComposingText("x", newCursorPosition = 1))
    assertTrue(processor.deleteSurroundingText(beforeLength = 2, afterLength = 1))
    assertTrue(processor.finishComposingText())

    assertEquals(
      listOf(ImeSignal.Key("Backspace"), ImeSignal.Key("Delete")),
      events
    )
  }

  @Test
  fun `reset discards unfinished composition`() {
    val events = mutableListOf<ImeSignal>()
    val processor = ImeInputProcessor(events::add)

    assertTrue(processor.setComposingText("stale", newCursorPosition = 1))
    processor.reset()
    assertTrue(processor.finishComposingText())

    assertTrue(events.isEmpty())
  }

  @Test
  fun `hardware key flushes composition before the structured key`() {
    val events = mutableListOf<ImeSignal>()
    val processor = ImeInputProcessor(events::add)

    assertTrue(processor.setComposingText("ready", newCursorPosition = 1))
    assertTrue(processor.hardwareKey("Enter", ImeModifiers(), repeat = false))

    assertEquals(
      listOf(ImeSignal.CommittedText("ready"), ImeSignal.Key("Enter")),
      events
    )
  }

  @Test
  fun `modified key row input flushes composition before its key`() {
    val events = mutableListOf<ImeSignal>()
    val processor = ImeInputProcessor(events::add)
    val ctrl = ImeModifiers(ctrl = true)

    assertTrue(processor.setComposingText("ready", newCursorPosition = 1))
    assertTrue(processor.hardwareKey("c", ctrl, repeat = false))

    assertEquals(
      listOf(
        ImeSignal.CommittedText("ready"),
        ImeSignal.Key("c", ctrl, repeat = false)
      ),
      events
    )
  }

  @Test
  fun `key row backspace settles only the edited composition`() {
    val events = mutableListOf<ImeSignal>()
    val processor = ImeInputProcessor(events::add)

    assertTrue(processor.setComposingText("ab", newCursorPosition = 1))
    assertTrue(processor.settledKey("Backspace", ImeModifiers(), repeat = false))
    // Android may finish its old connection while restartInput is taking effect.
    assertTrue(processor.finishComposingText())

    assertEquals(listOf(ImeSignal.CommittedText("a")), events)
  }

  @Test
  fun `key row escape settles composition before escape without a stale finish`() {
    val events = mutableListOf<ImeSignal>()
    val processor = ImeInputProcessor(events::add)

    assertTrue(processor.setComposingText("ab", newCursorPosition = 1))
    assertTrue(processor.settledKey("Escape", ImeModifiers(), repeat = false))
    assertTrue(processor.finishComposingText())

    assertEquals(
      listOf(ImeSignal.CommittedText("ab"), ImeSignal.Key("Escape")),
      events
    )
  }

  @Test
  fun `delete surrounding text emits backward and forward deletion`() {
    val events = mutableListOf<ImeSignal>()
    val processor = ImeInputProcessor(events::add)

    assertTrue(processor.deleteSurroundingText(beforeLength = 2, afterLength = 1))

    assertEquals(
      listOf(
        ImeSignal.Key("Backspace"),
        ImeSignal.Key("Backspace"),
        ImeSignal.Key("Delete")
      ),
      events
    )
  }

  @Test
  fun `enter from committed text and editor action is structured`() {
    val events = mutableListOf<ImeSignal>()
    val processor = ImeInputProcessor(events::add)

    assertTrue(processor.commitText("before\r\nafter"))
    assertTrue(processor.editorAction())

    assertEquals(
      listOf(
        ImeSignal.CommittedText("before"),
        ImeSignal.Key("Enter"),
        ImeSignal.CommittedText("after"),
        ImeSignal.Key("Enter")
      ),
      events
    )
  }

  @Test
  fun `hardware key preserves every modifier and repeat state`() {
    val events = mutableListOf<ImeSignal>()
    val processor = ImeInputProcessor(events::add)
    val modifiers = ImeModifiers(ctrl = true, alt = true, shift = true, meta = true)

    assertTrue(processor.hardwareKey("c", modifiers, repeat = true))

    assertEquals(
      listOf(ImeSignal.Key("c", modifiers, repeat = true)),
      events
    )
  }
}
