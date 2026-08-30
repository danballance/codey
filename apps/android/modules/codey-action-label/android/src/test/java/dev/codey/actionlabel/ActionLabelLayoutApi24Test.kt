package dev.codey.actionlabel

import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** API24 really loads these code paths; raster correctness is tested in native graphics on API35. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24])
@GraphicsMode(GraphicsMode.Mode.LEGACY)
class ActionLabelLayoutApi24Test {
  @Test
  fun minimumSdkBuildDoesNotInvokeNewerFontMetricsOrFallbackLayoutApis() {
    assertEquals(24, Build.VERSION.SDK_INT)
    val engine = ActionLabelLayoutEngine()
    val style = LabelTextStyle(15f, Typeface.DEFAULT)
    val result = engine.layout(
      listOf(ResolvedLabelRun("Save ", 22f, Typeface.DEFAULT), ResolvedLabelRun("all", 12f, Typeface.DEFAULT_BOLD)),
      style, Color.WHITE, 300, 100,
    )
    assertNotNull(result)
    assertEquals("Save all", result!!.sourceText)
    assertNull(engine.layout(emptyList(), style, Color.WHITE, 300, 100))
    assertNull(engine.layout(listOf(ResolvedLabelRun("X", 15f, Typeface.DEFAULT)), style, Color.WHITE, 0, 100))
  }
}
