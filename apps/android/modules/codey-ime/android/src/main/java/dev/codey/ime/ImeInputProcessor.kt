package dev.codey.ime

internal data class ImeModifiers(
  val ctrl: Boolean = false,
  val alt: Boolean = false,
  val shift: Boolean = false,
  val meta: Boolean = false
)

internal sealed interface ImeSignal {
  data class CommittedText(val text: String) : ImeSignal

  data class Key(
    val key: String,
    val modifiers: ImeModifiers = ImeModifiers(),
    val repeat: Boolean = false
  ) : ImeSignal
}

internal sealed interface ImeOrderedSegment {
  data class Text(val text: String) : ImeOrderedSegment

  data class Key(
    val key: String,
    val modifiers: ImeModifiers = ImeModifiers(),
    val repeat: Boolean = false
  ) : ImeOrderedSegment

  data class Input(val keys: String) : ImeOrderedSegment
}

internal data class ImeOrderedBatch(
  val segments: List<ImeOrderedSegment>,
  val drainedComposition: Boolean
)

/**
 * Turns the stateful Android IME protocol into Codey's stateless input stream.
 * Composition updates stay local until Android commits or finishes the composition.
 */
internal class ImeInputProcessor(
  private val emit: (ImeSignal) -> Unit
) {
  private var composingText: String? = null
  private var composingCursor = 0

  fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
    val value = text?.toString().orEmpty()
    composingText = value
    composingCursor = replacementCursor(value.length, newCursorPosition)
    return true
  }

  fun finishComposingText(): Boolean {
    val value = composingText ?: return true
    clearComposition()

    emitCommittedText(value)
    return true
  }

  fun commitText(text: CharSequence?): Boolean {
    val value = text?.toString().orEmpty()
    clearComposition()
    emitCommittedText(value)
    return true
  }

  fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean =
    deleteSurroundingText(beforeLength, afterLength, inCodePoints = false)

  fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean =
    deleteSurroundingText(beforeLength, afterLength, inCodePoints = true)

  fun editorAction(): Boolean {
    finishActiveComposition()
    emit(ImeSignal.Key("Enter"))
    return true
  }

  fun hardwareKey(
    key: String,
    modifiers: ImeModifiers,
    repeat: Boolean
  ): Boolean {
    if (composingText != null && modifiers == ImeModifiers()) {
      when (key) {
        "Backspace" -> return deleteSurroundingText(1, 0)
        "Delete" -> return deleteSurroundingText(0, 1)
      }
    }

    finishActiveComposition()
    emit(ImeSignal.Key(key, modifiers, repeat))
    return true
  }

  fun settledKey(
    key: String,
    modifiers: ImeModifiers,
    repeat: Boolean
  ): Boolean {
    hardwareKey(key, modifiers, repeat)
    return finishComposingText()
  }

  @Synchronized
  fun orderedInput(keys: String): ImeOrderedBatch? {
    if (keys.isEmpty()) return null

    val composition = composingText
    val segments = mutableListOf<ImeOrderedSegment>()
    if (composition != null) {
      clearComposition()
      processCommittedText(composition) { signal ->
        segments += when (signal) {
          is ImeSignal.CommittedText -> ImeOrderedSegment.Text(signal.text)
          is ImeSignal.Key -> ImeOrderedSegment.Key(
            key = signal.key,
            modifiers = signal.modifiers,
            repeat = signal.repeat
          )
        }
      }
    }
    segments += ImeOrderedSegment.Input(keys)
    return ImeOrderedBatch(segments, drainedComposition = composition != null)
  }

  fun reset() {
    clearComposition()
  }

  private fun emitCommittedText(text: String) {
    processCommittedText(text, emit)
  }

  private fun processCommittedText(text: String, sink: (ImeSignal) -> Unit) {
    if (text.isEmpty()) return

    val committed = StringBuilder()
    fun flushCommitted() {
      if (committed.isNotEmpty()) {
        sink(ImeSignal.CommittedText(committed.toString()))
        committed.clear()
      }
    }

    var index = 0
    while (index < text.length) {
      when (val character = text[index]) {
        '\r' -> {
          flushCommitted()
          sink(ImeSignal.Key("Enter"))
          if (index + 1 < text.length && text[index + 1] == '\n') index += 1
        }
        '\n' -> {
          flushCommitted()
          sink(ImeSignal.Key("Enter"))
        }
        '\b' -> {
          flushCommitted()
          sink(ImeSignal.Key("Backspace"))
        }
        '\t' -> {
          flushCommitted()
          sink(ImeSignal.Key("Tab"))
        }
        else -> committed.append(character)
      }
      index += 1
    }
    flushCommitted()
  }

  private fun deleteSurroundingText(
    beforeLength: Int,
    afterLength: Int,
    inCodePoints: Boolean
  ): Boolean {
    val currentComposition = composingText
    if (currentComposition != null) {
      val before = beforeLength.coerceAtLeast(0)
      val after = afterLength.coerceAtLeast(0)
      val availableBefore = if (inCodePoints) {
        currentComposition.codePointCount(0, composingCursor)
      } else {
        composingCursor
      }
      val availableAfter = if (inCodePoints) {
        currentComposition.codePointCount(composingCursor, currentComposition.length)
      } else {
        currentComposition.length - composingCursor
      }
      val localBefore = minOf(before, availableBefore)
      val localAfter = minOf(after, availableAfter)
      val start = if (inCodePoints) {
        offsetBackwardByCodePoints(currentComposition, composingCursor, localBefore)
      } else {
        composingCursor - localBefore
      }
      val end = if (inCodePoints) {
        offsetForwardByCodePoints(currentComposition, composingCursor, localAfter)
      } else {
        composingCursor + localAfter
      }

      composingText = currentComposition.removeRange(start, end)
      composingCursor = start
      repeat(before - localBefore) { emit(ImeSignal.Key("Backspace")) }
      repeat(after - localAfter) { emit(ImeSignal.Key("Delete")) }
      return true
    }

    repeat(beforeLength.coerceAtLeast(0)) { emit(ImeSignal.Key("Backspace")) }
    repeat(afterLength.coerceAtLeast(0)) { emit(ImeSignal.Key("Delete")) }
    return true
  }

  private fun finishActiveComposition() {
    val value = composingText ?: return
    clearComposition()
    emitCommittedText(value)
  }

  private fun clearComposition() {
    composingText = null
    composingCursor = 0
  }

  private fun replacementCursor(textLength: Int, newCursorPosition: Int): Int {
    val requested = if (newCursorPosition > 0) {
      textLength.toLong() + newCursorPosition.toLong() - 1L
    } else {
      newCursorPosition.toLong()
    }
    return requested.coerceIn(0L, textLength.toLong()).toInt()
  }

  private fun offsetBackwardByCodePoints(text: String, index: Int, count: Int): Int {
    var result = index
    var remaining = count
    while (remaining > 0 && result > 0) {
      result -= Character.charCount(Character.codePointBefore(text, result))
      remaining -= 1
    }
    return result
  }

  private fun offsetForwardByCodePoints(text: String, index: Int, count: Int): Int {
    var result = index
    var remaining = count
    while (remaining > 0 && result < text.length) {
      result += Character.charCount(Character.codePointAt(text, result))
      remaining -= 1
    }
    return result
  }
}
