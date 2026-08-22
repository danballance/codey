package dev.codey.ime

import android.view.KeyEvent

internal fun imeHardwareKeyName(
  keyCode: Int,
  displayLabel: Char,
  unicodeCodePoint: Int,
  modifiers: ImeModifiers
): String? = when (keyCode) {
  KeyEvent.KEYCODE_DEL -> "Backspace"
  KeyEvent.KEYCODE_FORWARD_DEL -> "Delete"
  KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "Enter"
  KeyEvent.KEYCODE_ESCAPE -> "Escape"
  KeyEvent.KEYCODE_TAB -> "Tab"
  KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
  KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight"
  KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
  KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
  KeyEvent.KEYCODE_MOVE_HOME -> "Home"
  KeyEvent.KEYCODE_MOVE_END -> "End"
  KeyEvent.KEYCODE_PAGE_UP -> "PageUp"
  KeyEvent.KEYCODE_PAGE_DOWN -> "PageDown"
  KeyEvent.KEYCODE_INSERT -> "Insert"
  in KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F12 ->
    "F${keyCode - KeyEvent.KEYCODE_F1 + 1}"
  KeyEvent.KEYCODE_CTRL_LEFT, KeyEvent.KEYCODE_CTRL_RIGHT -> "Control"
  KeyEvent.KEYCODE_ALT_LEFT, KeyEvent.KEYCODE_ALT_RIGHT -> "Alt"
  KeyEvent.KEYCODE_SHIFT_LEFT, KeyEvent.KEYCODE_SHIFT_RIGHT -> "Shift"
  KeyEvent.KEYCODE_META_LEFT, KeyEvent.KEYCODE_META_RIGHT -> "Meta"
  else -> printableHardwareKey(displayLabel, unicodeCodePoint, modifiers)
}

private fun printableHardwareKey(
  displayLabel: Char,
  unicodeCodePoint: Int,
  modifiers: ImeModifiers
): String? {
  if ((modifiers.ctrl || modifiers.alt || modifiers.meta) && displayLabel.code > 0) {
    return if (modifiers.shift) {
      displayLabel.uppercaseChar().toString()
    } else {
      displayLabel.lowercaseChar().toString()
    }
  }

  if (unicodeCodePoint > 0 && Character.isValidCodePoint(unicodeCodePoint)) {
    return String(Character.toChars(unicodeCodePoint))
  }

  return if (displayLabel.code > 0) displayLabel.lowercaseChar().toString() else null
}
