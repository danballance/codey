package dev.codey.ime

import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.os.Trace
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.CompletionInfo
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.atomic.AtomicLong

internal class CodeyImeView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext) {
  val onCommittedText by EventDispatcher()
  val onKey by EventDispatcher()
  val onOrderedInput by EventDispatcher()

  private val processor = ImeInputProcessor(::emitSignal)
  private val inputConnections = ImeConnectionGeneration()
  private val mainHandler = Handler(Looper.getMainLooper())
  private val inputDispatcher = MainThreadInputDispatcher(
    isMainThread = { Looper.myLooper() == mainHandler.looper },
    enqueue = mainHandler::post
  )
  private val nextEventSequence = AtomicLong(1L)
  private var inputMode = ImeInputMode.Terminal

  init {
    isFocusable = true
    isFocusableInTouchMode = true
    setBackgroundColor(Color.TRANSPARENT)
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  override fun onCheckIsTextEditor(): Boolean = true

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection =
    inputDispatcher.run {
      traceSection("Codey/IME/CreateConnection") {
        inputConnections.serialized {
          outAttrs.inputType = imeInputType(inputMode)
          outAttrs.imeOptions = imeOptions()
          outAttrs.initialSelStart = 0
          outAttrs.initialSelEnd = 0
          val generation = inputConnections.openConnection()

          object : BaseInputConnection(this, false) {
            override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean =
              dispatchInputConnection(generation) {
                processor.setComposingText(text, newCursorPosition)
              }

            override fun finishComposingText(): Boolean = dispatchInputConnection(generation) {
              processor.finishComposingText()
            }

            override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean =
              dispatchInputConnection(generation) { processor.commitText(text) }

            override fun commitCompletion(text: CompletionInfo?): Boolean =
              dispatchInputConnection(generation) { processor.commitText(text?.text) }

            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean =
              dispatchInputConnection(generation) {
                processor.deleteSurroundingText(beforeLength, afterLength)
              }

            override fun deleteSurroundingTextInCodePoints(
              beforeLength: Int,
              afterLength: Int
            ): Boolean = dispatchInputConnection(generation) {
              processor.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
            }

            override fun performEditorAction(actionCode: Int): Boolean =
              dispatchInputConnection(generation) { processor.editorAction() }

            override fun sendKeyEvent(event: KeyEvent): Boolean =
              dispatchInputConnection(generation) {
                when (event.action) {
                  KeyEvent.ACTION_DOWN ->
                    if (handleHardwareKey(event)) true else super.sendKeyEvent(event)
                  KeyEvent.ACTION_UP ->
                    if (keyName(event) != null) true else super.sendKeyEvent(event)
                  else -> super.sendKeyEvent(event)
                }
              }
          }
        }
      }
    }

  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    val handled = inputDispatcher.run {
      inputConnections.serialized {
        traceSection("Codey/IME/HardwareDispatch") { handleHardwareKey(event) }
      }
    }
    return if (handled) true else super.onKeyDown(keyCode, event)
  }

  override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean =
    if (keyName(event) != null) true else super.onKeyUp(keyCode, event)

  fun focusKeyboard() {
    inputDispatcher.run {
      val shouldRestartInput = !hasFocus()
      if (shouldRestartInput) inputConnections.serialized { processor.reset() }
      requestFocus()
      post {
        if (!hasFocus()) return@post

        inputConnections.serialized {
          val inputMethodManager = inputMethodManager()
          if (shouldRestartInput) restartKeyboardInput(inputMethodManager)
          inputMethodManager.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
        }
      }
    }
  }

  fun blurKeyboard() {
    inputDispatcher.run {
      inputConnections.serialized {
        inputConnections.invalidate()
        processor.reset()
        inputMethodManager().hideSoftInputFromWindow(windowToken, 0)
        clearFocus()
      }
    }
  }

  fun setInputMode(value: String) {
    inputDispatcher.run {
      val nextMode = ImeInputMode.fromProp(value)
      if (nextMode == inputMode) return@run

      inputConnections.serialized {
        inputMode = nextMode
        inputConnections.invalidate()
        processor.reset()
        if (hasFocus()) inputMethodManager().restartInput(this)
      }
    }
  }

  fun sendOrderedInput(keys: String) {
    if (keys.isEmpty()) return
    val receivedAtUptimeMs = imeUptimeMillis()
    inputDispatcher.run {
      inputConnections.serialized {
        val connectionGeneration = inputConnections.current()
        val batch = processor.orderedInput(keys) ?: return@serialized
        if (batch.drainedComposition) inputConnections.invalidate()
        val sequence = nextEventSequence.getAndIncrement()
        val nativeDurationMs =
          (imeUptimeMillis() - receivedAtUptimeMs).coerceAtLeast(0.0)

        onOrderedInput(
          mapOf(
            "sequence" to sequence.toDouble(),
            "receivedAtUptimeMs" to receivedAtUptimeMs,
            "nativeDurationMs" to nativeDurationMs,
            "connectionGeneration" to connectionGeneration.toDouble(),
            "compositionDrained" to batch.drainedComposition,
            "segments" to batch.segments.map(::orderedSegmentPayload)
          )
        )
        if (batch.drainedComposition && hasFocus()) {
          // Invalidation, event delivery, and restart are one main-thread
          // transaction, so another native input path cannot split the batch.
          inputMethodManager().restartInput(this)
        }
      }
    }
  }

  private fun handleHardwareKey(event: KeyEvent): Boolean {
    val modifiers = ImeModifiers(
      ctrl = event.isCtrlPressed,
      alt = event.isAltPressed,
      shift = event.isShiftPressed,
      meta = event.isMetaPressed
    )
    val key = keyName(event) ?: return false
    return processor.hardwareKey(key, modifiers, event.repeatCount > 0)
  }

  private fun keyName(event: KeyEvent): String? = imeHardwareKeyName(
    keyCode = event.keyCode,
    displayLabel = event.displayLabel,
    unicodeCodePoint = event.unicodeChar,
    modifiers = ImeModifiers(
      ctrl = event.isCtrlPressed,
      alt = event.isAltPressed,
      shift = event.isShiftPressed,
      meta = event.isMetaPressed
    )
  )

  private fun emitSignal(signal: ImeSignal) {
    val sequence = nextEventSequence.getAndIncrement().toDouble()
    val receivedAtUptimeMs = imeUptimeMillis()
    val connectionGeneration = inputConnections.current().toDouble()
    when (signal) {
      is ImeSignal.CommittedText -> onCommittedText(
        mapOf(
          "text" to signal.text,
          "sequence" to sequence,
          "receivedAtUptimeMs" to receivedAtUptimeMs,
          "connectionGeneration" to connectionGeneration
        )
      )
      is ImeSignal.Key -> onKey(
        mapOf(
          "key" to signal.key,
          "ctrl" to signal.modifiers.ctrl,
          "alt" to signal.modifiers.alt,
          "shift" to signal.modifiers.shift,
          "meta" to signal.modifiers.meta,
          "repeat" to signal.repeat,
          "sequence" to sequence,
          "receivedAtUptimeMs" to receivedAtUptimeMs,
          "connectionGeneration" to connectionGeneration
        )
      )
    }
  }

  private fun dispatchInputConnection(generation: Long, callback: () -> Boolean): Boolean =
    inputDispatcher.run {
      inputConnections.dispatch(generation) {
        traceSection("Codey/IME/Dispatch", callback)
      }
    }

  private fun restartKeyboardInput(inputMethodManager: InputMethodManager) {
    inputConnections.invalidate()
    inputMethodManager.restartInput(this)
  }

  private fun orderedSegmentPayload(segment: ImeOrderedSegment): Map<String, Any> = when (segment) {
    is ImeOrderedSegment.Text -> mapOf(
      "type" to "text",
      "text" to segment.text
    )
    is ImeOrderedSegment.Key -> mapOf(
      "type" to "key",
      "key" to segment.key,
      "ctrl" to segment.modifiers.ctrl,
      "alt" to segment.modifiers.alt,
      "shift" to segment.modifiers.shift,
      "meta" to segment.modifiers.meta,
      "repeat" to segment.repeat
    )
    is ImeOrderedSegment.Input -> mapOf(
      "type" to "input",
      "keys" to segment.keys
    )
  }

  private fun inputMethodManager(): InputMethodManager =
    context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
}

private inline fun <T> traceSection(name: String, callback: () -> T): T {
  Trace.beginSection(name)
  return try {
    callback()
  } finally {
    Trace.endSection()
  }
}
