package dev.codey.actionlabel

import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Typeface
import android.os.LocaleList
import android.text.Spanned
import android.text.TextPaint
import android.text.style.ForegroundColorSpan
import android.util.DisplayMetrics
import android.util.TypedValue
import com.facebook.react.common.assets.ReactFontManager
import java.io.File
import java.util.Locale
import kotlin.math.ceil
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** These tests exercise real font resolution and layout, without constructing an Expo/React host. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ActionLabelViewStateTest {
  private lateinit var context: Context
  private lateinit var regular: Typeface
  private lateinit var bold: Typeface

  @Before
  fun registerBundledFacesExactlyAsExpoDoes() {
    context = configuredContext()
    val fonts = File(requireNotNull(System.getProperty("codey.label.fontsDir")))
    val regularFile = File(fonts, "JetBrainsMonoNerdFontMono-Regular.ttf")
    val boldFile = File(fonts, "JetBrainsMonoNerdFontMono-Bold.ttf")
    assertTrue("The production regular font must be available to native tests", regularFile.isFile)
    assertTrue("The production bold font must be available to native tests", boldFile.isFile)
    regular = Typeface.createFromFile(regularFile)
    bold = Typeface.createFromFile(boldFile)
    ReactFontManager.getInstance().apply {
      setTypeface(REGULAR_FAMILY, Typeface.NORMAL, regular)
      setTypeface(BOLD_FAMILY, Typeface.NORMAL, bold)
    }
  }

  @Test
  fun `concrete registered families keep their exact faces without synthetic weights`() {
    assertSame(regular, resolveActionLabelTypeface(REGULAR_FAMILY, 400, context.assets))
    assertSame(bold, resolveActionLabelTypeface(BOLD_FAMILY, 700, context.assets))
    // A concrete family names a face, not a family in which Android should choose a weight.
    assertSame(regular, resolveActionLabelTypeface(REGULAR_FAMILY, 700, context.assets))
    assertSame(bold, resolveActionLabelTypeface(BOLD_FAMILY, 400, context.assets))

    val state = ActionLabelViewState()
    state.update(content(listOf(run("Regular "), run("Bold", family = BOLD_FAMILY, weight = 700))))
    val result = layout(state)
    val regularPaint = runPaint(result, 0)
    val boldPaint = runPaint(result, "Regular ".length)

    assertSame(regular, result.layout.paint.typeface)
    assertSame(regular, regularPaint.typeface)
    assertSame(bold, boldPaint.typeface)
    assertFalse(regularPaint.isFakeBoldText)
    assertFalse(boldPaint.isFakeBoldText)
    assertEquals(0f, regularPaint.textSkewX, 0f)
    assertEquals(0f, boldPaint.textSkewX, 0f)
  }

  @Test
  fun `missing and blank families use system regular 400 and bold 700`() {
    for (family in listOf(null, "", " \t")) {
      val regularFallback = resolveActionLabelTypeface(family, 400, context.assets)
      val boldFallback = resolveActionLabelTypeface(family, 700, context.assets)
      assertEquals(400, regularFallback.weight)
      assertEquals(700, boldFallback.weight)
      assertFalse(regularFallback.isBold)
      assertTrue(boldFallback.isBold)
      assertFalse(regularFallback.isItalic)
      assertFalse(boldFallback.isItalic)
    }

    val state = ActionLabelViewState()
    state.update(ActionLabelContent(runs = listOf(
      run("Regular ", family = null),
      run("Bold", family = null, weight = 700),
    )))
    val result = layout(state)
    assertEquals(400, result.layout.paint.typeface.weight)
    assertEquals(400, runPaint(result, 0).typeface.weight)
    assertEquals(700, runPaint(result, "Regular ".length).typeface.weight)
    assertFalse(runPaint(result, "Regular ".length).isFakeBoldText)
  }

  @Test
  fun `font availability transitions rebuild default and run typography in both directions`() {
    val state = ActionLabelViewState()
    val unavailable = ActionLabelContent(runs = listOf(
      run("A", family = null), run("B", family = null, weight = 700),
    ))
    val available = content(listOf(run("A"), run("B", family = BOLD_FAMILY, weight = 700)))

    assertTrue(state.update(unavailable))
    val initial = layout(state)
    assertNotSame(regular, runPaint(initial, 0).typeface)
    assertEquals(700, runPaint(initial, 1).typeface.weight)

    assertTrue(state.update(available))
    val loaded = layout(state)
    assertNotSame(initial, loaded)
    assertSame(regular, loaded.layout.paint.typeface)
    assertSame(regular, runPaint(loaded, 0).typeface)
    assertSame(bold, runPaint(loaded, 1).typeface)

    assertTrue(state.update(unavailable))
    val failed = layout(state)
    assertNotSame(loaded, failed)
    assertNotSame(regular, failed.layout.paint.typeface)
    assertEquals(400, runPaint(failed, 0).typeface.weight)
    assertEquals(700, runPaint(failed, 1).typeface.weight)
    assertEquals("AB", failed.sourceText)
  }

  @Test
  fun `default normal 15 and compact 13 sizes remain independent of requested run sizes`() {
    for (defaultSize in listOf(15.0, 13.0)) {
      val state = ActionLabelViewState()
      state.update(content(listOf(run("A", size = 22.0))).copy(defaultFontSize = defaultSize))
      val result = layout(state)
      assertEquals(spPixels(context, defaultSize), result.layout.paint.textSize, 0f)
      assertEquals(spPixels(context, 22.0), runPaint(result).textSize, 0f)
      assertSame(regular, result.layout.paint.typeface)
    }
  }

  @Test
  fun `run sizes use current Android SP conversion and one RN compatible rounding step`() {
    val state = ActionLabelViewState()
    val sizes = listOf(9.0, 10.0, 12.0, 13.0, 15.0, 16.0, 18.0, 19.0, 22.0)
    state.update(content(sizes.mapIndexed { index, size -> run(('a' + index).toString(), size = size) }))

    for ((density, scale) in listOf(160 to 1f, 240 to 1f, 320 to 1.3f, 320 to 2f)) {
      val configured = configuredContext(densityDpi = density, fontScale = scale)
      val result = layout(state, context = configured)
      assertEquals(spPixels(configured, 15.0), result.layout.paint.textSize, 0f)
      for ((index, size) in sizes.withIndex()) {
        assertEquals("SP size $size at density $density and font scale $scale",
          spPixels(configured, size), runPaint(result, index).textSize, 0f)
      }
    }

    val normal = layout(state, context = configuredContext())
    val enlarged = layout(state, context = configuredContext(fontScale = 2f))
    assertTrue(runPaint(enlarged).textSize > runPaint(normal).textSize)
    assertEquals(23f, spPixels(configuredContext(densityDpi = 240), 15.0), 0f)
  }

  @Test
  fun `identical content and repeated drawing reuse the same native layout and resolved fonts`() {
    var resolutions = 0
    val state = ActionLabelViewState(typefaceResolver = { family, weight, assets ->
      resolutions++
      resolveActionLabelTypeface(family, weight, assets)
    })
    val original = content(listOf(run("Stable")))
    assertTrue(state.update(original))
    val first = layout(state, width = 400, height = 100)
    val originalResolutions = resolutions
    val bitmap = Bitmap.createBitmap(400, 100, Bitmap.Config.ARGB_8888)
    try {
      val canvas = Canvas(bitmap)
      repeat(3) {
        assertSame(first, layout(state, width = 400, height = 100))
        first.layout.draw(canvas)
      }
      assertFalse(state.update(original.copy(runs = original.runs.map { it.copy() })))
      assertSame(first, layout(state, width = 400, height = 100))
      assertEquals(originalResolutions, resolutions)
    } finally {
      bitmap.recycle()
    }
  }

  @Test
  fun `every content property invalidates the cached layout`() {
    val original = content(listOf(run("Original", family = null)))
    val variants = listOf(
      "text" to original.copy(runs = listOf(original.runs.single().copy(text = "Changed"))),
      "run size" to original.copy(runs = listOf(original.runs.single().copy(fontSize = 22.0))),
      "run family" to original.copy(runs = listOf(original.runs.single().copy(fontFamily = BOLD_FAMILY))),
      "run weight" to original.copy(runs = listOf(original.runs.single().copy(fontWeight = 700))),
      "run colour" to original.copy(runs = listOf(original.runs.single().copy(color = "#9ece6a"))),
      "default size" to original.copy(defaultFontSize = 13.0),
      "default family" to original.copy(defaultFontFamily = BOLD_FAMILY),
      "colour" to original.copy(color = Color.RED),
      "run count" to original.copy(runs = original.runs + run(" appended")),
    )

    for ((property, changed) in variants) {
      val state = ActionLabelViewState()
      state.update(original)
      val previous = layout(state)
      assertTrue(property, state.update(changed))
      val next = layout(state)
      assertNotSame(property, previous, next)
      assertEquals(changed.runs.joinToString("") { it.text }, next.sourceText)
      assertEquals(changed.color, next.layout.paint.color)
      assertFalse(property, state.update(changed.copy(runs = changed.runs.map { it.copy() })))
      assertSame(next, layout(state))
    }
  }

  @Test
  fun `width height and explicit lifecycle invalidation rebuild without changing content`() {
    val state = ActionLabelViewState()
    state.update(content(listOf(run("Resize"))))
    val first = layout(state, width = 400, height = 100)
    val resizedWidth = layout(state, width = 300, height = 100)
    val resizedHeight = layout(state, width = 300, height = 80)
    assertNotSame(first, resizedWidth)
    assertNotSame(resizedWidth, resizedHeight)
    assertEquals(300, resizedWidth.layout.width)
    assertEquals((80 - resizedHeight.layout.height) / 2f, resizedHeight.verticalOffset, 0f)
    assertSame(resizedHeight, layout(state, width = 300, height = 80))

    state.invalidate()
    val afterLifecycleChange = layout(state, width = 300, height = 80)
    assertNotSame(resizedHeight, afterLifecycleChange)
    assertEquals("Resize", afterLifecycleChange.sourceText)
  }

  @Test
  fun `density font scale locales and layout direction are part of the cache key`() {
    val state = ActionLabelViewState()
    state.update(content(listOf(run("Configuration"))))
    var previous = layout(state)
    for (configured in listOf(
      configuredContext(densityDpi = 240),
      configuredContext(densityDpi = 240, fontScale = 1.5f),
      configuredContext(densityDpi = 240, fontScale = 1.5f, locale = Locale.FRENCH),
      configuredContext(densityDpi = 240, fontScale = 1.5f, locale = Locale.forLanguageTag("ar")),
    )) {
      val next = layout(state, context = configured)
      assertNotSame(previous, next)
      assertSame(next, layout(state, context = configured))
      assertEquals(spPixels(configured, 15.0), runPaint(next).textSize, 0f)
      previous = next
    }
  }

  @Test
  fun `updating snapshots the bridge list and old layout remains independent of later edits`() {
    val bridgeRuns = mutableListOf(run("Original"))
    val state = ActionLabelViewState()
    state.update(content(bridgeRuns))
    val original = layout(state)

    bridgeRuns[0] = run("Replacement", size = 22.0, family = BOLD_FAMILY, weight = 700)
    bridgeRuns += run(" appended")
    // Force a rebuild as well as checking the cached result: neither may observe list mutation.
    state.invalidate()
    val afterExternalMutation = layout(state)
    assertEquals("Original", afterExternalMutation.sourceText)
    assertSame(regular, runPaint(afterExternalMutation).typeface)
    assertEquals(spPixels(context, 15.0), runPaint(afterExternalMutation).textSize, 0f)

    assertTrue(state.update(content(bridgeRuns)))
    val updated = layout(state)
    assertEquals("Replacement appended", updated.sourceText)
    assertSame(bold, runPaint(updated).typeface)
    assertEquals("Original", original.sourceText)
    assertSame(regular, runPaint(original).typeface)
  }

  @Test
  fun `zero negative and temporarily too small bounds render nothing and recover on resize`() {
    val state = ActionLabelViewState()
    state.update(content(listOf(run("Visible", size = 22.0))))
    for ((width, height) in listOf(0 to 100, 400 to 0, -1 to 100, 400 to -1, 400 to 1)) {
      assertNull(state.layout(context, width, height))
      assertNull(state.layout(context, width, height))
    }
    assertEquals("Visible", layout(state, width = 400, height = 100).sourceText)
  }

  @Test
  fun `empty drafts are cached safely and populated runs recover without stale content`() {
    var resolutions = 0
    val state = ActionLabelViewState(typefaceResolver = { family, weight, assets ->
      resolutions++
      resolveActionLabelTypeface(family, weight, assets)
    })
    assertFalse(state.update(ActionLabelContent()))
    assertNull(state.layout(context, 400, 100))
    val emptyResolutions = resolutions
    assertNull(state.layout(context, 400, 100))
    assertEquals(emptyResolutions, resolutions)

    state.update(content(listOf(run(""), run(""))))
    assertNull(state.layout(context, 400, 100))
    state.update(content(listOf(run(""), run("Populated"), run(""))))
    assertEquals("Populated", layout(state, width = 400, height = 100).sourceText)
    state.update(content(emptyList()))
    assertNull(state.layout(context, 400, 100))
  }

  @Test
  fun `invalid private bridge sizes fall back to a valid default before reaching the engine`() {
    for (invalid in listOf(0.0, -1.0, Double.NaN, Double.POSITIVE_INFINITY)) {
      val state = ActionLabelViewState()
      state.update(content(listOf(run("A", size = invalid))).copy(defaultFontSize = 13.0))
      assertEquals(spPixels(context, 13.0), runPaint(layout(state)).textSize, 0f)
      state.update(content(listOf(run("A", size = invalid))).copy(defaultFontSize = invalid))
      val fallback = layout(state)
      assertEquals(spPixels(context, 15.0), fallback.layout.paint.textSize, 0f)
      assertEquals(spPixels(context, 15.0), runPaint(fallback).textSize, 0f)
    }
  }

  @Test
  fun `run colours resolve independently while absent and invalid drafts inherit the label colour`() {
    val state = ActionLabelViewState()
    state.update(content(listOf(
      run("Green", color = "#9ece6a"),
      run(" Yellow", color = "#E0AF68"),
      run(" inherited"),
      run(" invalid", color = "#73da"),
    )).copy(color = Color.BLUE))

    val result = layout(state)
    assertEquals(Color.BLUE, result.layout.paint.color)
    assertEquals(Color.rgb(158, 206, 106), runColor(result, 0))
    assertEquals(Color.rgb(224, 175, 104), runColor(result, "Green".length))
    assertEquals(Color.BLUE, runColor(result, "Green Yellow".length))
    assertEquals(Color.BLUE, runColor(result, "Green Yellow inherited".length))
  }

  @Test
  fun `private bridge colour parsing accepts only opaque six digit hex`() {
    val fallback = Color.MAGENTA
    assertEquals(Color.rgb(115, 218, 202), resolveActionLabelColor("#73daca", fallback))
    assertEquals(Color.rgb(255, 123, 114), resolveActionLabelColor("#FF7B72", fallback))
    for (invalid in listOf(null, "", "#fff", "#12345678", "red", "transparent", "rgb(1,2,3)", "#gggggg")) {
      assertEquals("invalid=$invalid", fallback, resolveActionLabelColor(invalid, fallback))
    }
  }

  private fun layout(
    state: ActionLabelViewState,
    width: Int = 1200,
    height: Int = 300,
    context: Context = this.context,
  ): ActionLabelLayoutResult = requireNotNull(state.layout(context, width, height)) {
    "Expected a complete label at $width x $height"
  }

  private fun runPaint(result: ActionLabelLayoutResult, offset: Int = 0): TextPaint {
    val text = result.layout.text as Spanned
    val span = text.getSpans(offset, offset + 1, CentredLabelRunSpan::class.java).single()
    return TextPaint(result.layout.paint).apply { span.updateMeasureState(this) }
  }

  private fun runColor(result: ActionLabelLayoutResult, offset: Int): Int {
    val text = result.layout.text as Spanned
    return text.getSpans(offset, offset + 1, ForegroundColorSpan::class.java)
      .single()
      .foregroundColor
  }

  private fun run(
    text: String,
    size: Double = 15.0,
    family: String? = REGULAR_FAMILY,
    weight: Int = 400,
    color: String? = null,
  ) = ActionLabelRunSpec(text, size, family, weight, color)

  private fun content(runs: List<ActionLabelRunSpec>) = ActionLabelContent(
    runs = runs,
    defaultFontFamily = REGULAR_FAMILY,
  )

  private fun configuredContext(
    densityDpi: Int = DisplayMetrics.DENSITY_DEFAULT,
    fontScale: Float = 1f,
    locale: Locale = Locale.ENGLISH,
  ): Context {
    val application = RuntimeEnvironment.getApplication()
    val configuration = Configuration(application.resources.configuration).apply {
      this.densityDpi = densityDpi
      this.fontScale = fontScale
      setLocales(LocaleList(locale))
      setLayoutDirection(locale)
    }
    return application.createConfigurationContext(configuration)
  }

  private fun spPixels(context: Context, size: Double): Float = ceil(
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, size.toFloat(), context.resources.displayMetrics).toDouble(),
  ).toFloat()

  companion object {
    private const val REGULAR_FAMILY = "CodeyJetBrainsMonoNerdFont-Regular"
    private const val BOLD_FAMILY = "CodeyJetBrainsMonoNerdFont-Bold"
  }
}
