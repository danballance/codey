package dev.codey.ime

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ImeHardwareKeyMapperTest {
  @Test
  fun `system key without printable content is unsupported`() {
    assertNull(
      imeHardwareKeyName(
        keyCode = KeyEvent.KEYCODE_VOLUME_UP,
        displayLabel = '\u0000',
        unicodeCodePoint = 0,
        modifiers = ImeModifiers()
      )
    )
  }

  @Test
  fun `supported special and modified printable keys remain structured`() {
    assertEquals(
      "ArrowLeft",
      imeHardwareKeyName(
        keyCode = KeyEvent.KEYCODE_DPAD_LEFT,
        displayLabel = '\u0000',
        unicodeCodePoint = 0,
        modifiers = ImeModifiers()
      )
    )
    assertEquals(
      "c",
      imeHardwareKeyName(
        keyCode = KeyEvent.KEYCODE_C,
        displayLabel = 'C',
        unicodeCodePoint = 0,
        modifiers = ImeModifiers(ctrl = true)
      )
    )
  }
}
