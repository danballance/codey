package dev.codey.ime

import android.text.InputType
import android.view.inputmethod.EditorInfo

internal enum class ImeInputMode(val propValue: String) {
  Terminal("terminal"),
  Composed("composed");

  companion object {
    fun fromProp(value: String): ImeInputMode = entries.firstOrNull { it.propValue == value }
      ?: throw IllegalArgumentException("Unsupported Codey IME input mode: $value")
  }
}

internal fun imeInputType(mode: ImeInputMode): Int {
  val shared = InputType.TYPE_CLASS_TEXT or
    InputType.TYPE_TEXT_FLAG_MULTI_LINE or
    InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
  return when (mode) {
    ImeInputMode.Terminal -> shared or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
    ImeInputMode.Composed -> shared
  }
}

internal fun imeOptions(): Int = EditorInfo.IME_FLAG_NO_EXTRACT_UI or
  EditorInfo.IME_FLAG_NO_FULLSCREEN or
  EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING or
  EditorInfo.IME_ACTION_NONE
