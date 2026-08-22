package dev.codey.ime

import android.content.Context
import android.graphics.Color
import android.text.InputType
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.CompletionInfo
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

internal class CodeyImeView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext) {
  val onCommittedText by EventDispatcher()
  val onKey by EventDispatcher()

  private val processor = ImeInputProcessor(::emitSignal)

  init {
    isFocusable = true
    isFocusableInTouchMode = true
    setBackgroundColor(Color.TRANSPARENT)
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  override fun onCheckIsTextEditor(): Boolean = true

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
    outAttrs.inputType = InputType.TYPE_CLASS_TEXT or
      InputType.TYPE_TEXT_FLAG_MULTI_LINE or
      InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or
      EditorInfo.IME_FLAG_NO_FULLSCREEN or
      EditorInfo.IME_ACTION_NONE
    outAttrs.initialSelStart = 0
    outAttrs.initialSelEnd = 0

    return object : BaseInputConnection(this, false) {
      override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean =
        processor.setComposingText(text, newCursorPosition)

      override fun finishComposingText(): Boolean = processor.finishComposingText()

      override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean =
        processor.commitText(text)

      override fun commitCompletion(text: CompletionInfo?): Boolean =
        processor.commitText(text?.text)

      override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean =
        processor.deleteSurroundingText(beforeLength, afterLength)

      override fun deleteSurroundingTextInCodePoints(
        beforeLength: Int,
        afterLength: Int
      ): Boolean = processor.deleteSurroundingTextInCodePoints(beforeLength, afterLength)

      override fun performEditorAction(actionCode: Int): Boolean = processor.editorAction()

      override fun sendKeyEvent(event: KeyEvent): Boolean {
        return when (event.action) {
          KeyEvent.ACTION_DOWN ->
            if (handleHardwareKey(event)) true else super.sendKeyEvent(event)
          KeyEvent.ACTION_UP ->
            if (keyName(event) != null) true else super.sendKeyEvent(event)
          else -> super.sendKeyEvent(event)
        }
      }
    }
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean =
    if (handleHardwareKey(event)) true else super.onKeyDown(keyCode, event)

  override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean =
    if (keyName(event) != null) true else super.onKeyUp(keyCode, event)

  fun focusKeyboard() {
    val shouldRestartInput = !hasFocus()
    if (shouldRestartInput) processor.reset()
    requestFocus()
    post {
      if (!hasFocus()) return@post

      val inputMethodManager = inputMethodManager()
      if (shouldRestartInput) inputMethodManager.restartInput(this)
      inputMethodManager.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
    }
  }

  fun blurKeyboard() {
    processor.reset()
    inputMethodManager().hideSoftInputFromWindow(windowToken, 0)
    clearFocus()
  }

  fun sendImeKey(
    key: String,
    ctrl: Boolean,
    alt: Boolean,
    shift: Boolean,
    meta: Boolean,
    repeat: Boolean
  ) {
    processor.settledKey(
      key = key,
      modifiers = ImeModifiers(ctrl = ctrl, alt = alt, shift = shift, meta = meta),
      repeat = repeat
    )
    if (hasFocus()) inputMethodManager().restartInput(this)
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
    post {
      when (signal) {
        is ImeSignal.CommittedText -> onCommittedText(mapOf("text" to signal.text))
        is ImeSignal.Key -> onKey(
          mapOf(
            "key" to signal.key,
            "ctrl" to signal.modifiers.ctrl,
            "alt" to signal.modifiers.alt,
            "shift" to signal.modifiers.shift,
            "meta" to signal.modifiers.meta,
            "repeat" to signal.repeat
          )
        )
      }
    }
  }

  private fun inputMethodManager(): InputMethodManager =
    context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
}
