package dev.codey.ime

import android.text.InputType
import android.view.inputmethod.EditorInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ImeConfigurationTest {
  @Test
  fun `terminal mode requests immediate private multiline text commits`() {
    val inputType = imeInputType(ImeInputMode.Terminal)

    assertEquals(InputType.TYPE_CLASS_TEXT, inputType and InputType.TYPE_MASK_CLASS)
    assertEquals(
      InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
      inputType and InputType.TYPE_MASK_VARIATION
    )
    assertTrue(inputType and InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS != 0)
    assertTrue(inputType and InputType.TYPE_TEXT_FLAG_MULTI_LINE != 0)
  }

  @Test
  fun `composed mode preserves the ordinary buffered text variation`() {
    val inputType = imeInputType(ImeInputMode.Composed)

    assertEquals(InputType.TYPE_CLASS_TEXT, inputType and InputType.TYPE_MASK_CLASS)
    assertEquals(InputType.TYPE_TEXT_VARIATION_NORMAL, inputType and InputType.TYPE_MASK_VARIATION)
    assertTrue(inputType and InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS != 0)
    assertTrue(inputType and InputType.TYPE_TEXT_FLAG_MULTI_LINE != 0)
  }

  @Test
  fun `editor options disable actions fullscreen extract UI and personalized learning`() {
    val options = imeOptions()

    assertEquals(EditorInfo.IME_ACTION_NONE, options and EditorInfo.IME_MASK_ACTION)
    assertTrue(options and EditorInfo.IME_FLAG_NO_EXTRACT_UI != 0)
    assertTrue(options and EditorInfo.IME_FLAG_NO_FULLSCREEN != 0)
    assertTrue(options and EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING != 0)
  }
}
