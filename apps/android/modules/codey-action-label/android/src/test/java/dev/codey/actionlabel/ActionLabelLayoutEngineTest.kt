package dev.codey.actionlabel

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextDirectionHeuristics
import android.text.TextPaint
import android.text.TextUtils
import java.io.File
import java.io.FileOutputStream
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ActionLabelLayoutEngineTest {
  private val engine = ActionLabelLayoutEngine()
  private val base get() = LabelTextStyle(15f, regular)

  @Test
  fun allPresetAndCompactSizePairsHaveTheSameFontBoxCentre() {
    for (sizes in listOf(listOf(10f, 12f, 15f, 18f, 22f), listOf(9f, 10f, 13f, 16f, 19f))) {
      for (first in sizes) for (second in sizes) {
        for (firstFace in listOf(regular, bold)) for (secondFace in listOf(regular, bold)) {
          val result = layout(listOf(run("A ", first, firstFace), run("B", second, secondFace)), width = 400)
          assertEquals(1, result.lines.size)
          val fragments = result.lines.single().fragments
          assertEquals(2, fragments.size)
          for (fragment in fragments) assertTrue(abs(fragment.centredBaseline) <= 0.5001f)
          assertTrue(abs(fragments[0].centredBaseline - fragments[1].centredBaseline) <= 1f)
          assertMeasuredLineMetrics(result)
        }
      }
    }
  }

  @Test
  fun styleSpansUseIdenticalFontSizeTypefaceAndShiftForMeasureAndDraw() {
    val span = CentredLabelRunSpan(22f, bold, 7)
    val measure = TextPaint().apply { baselineShift = 30 }
    val draw = TextPaint().apply { baselineShift = -30 }
    span.updateMeasureState(measure)
    span.updateDrawState(draw)
    assertEquals(22f, measure.textSize, 0f)
    assertEquals(measure.textSize, draw.textSize, 0f)
    assertSame(bold, measure.typeface)
    assertSame(measure.typeface, draw.typeface)
    assertEquals(7, measure.baselineShift)
    assertEquals(measure.baselineShift, draw.baselineShift)
  }

  @Test
  fun originalMetricSpanBoundariesAndUnicodeTextArePreserved() {
    val supplementaryIcon = String(Character.toChars(0xF0198))
    val runs = listOf(run("\uf013 ", 22f), run("Save", 15f, bold), run(" all $supplementaryIcon 🙂", 12f))
    val result = layout(runs, width = 500)
    assertEquals(runs.joinToString("") { it.text }, result.sourceText)
    val text = result.layout.text as Spanned
    val spans = text.getSpans(0, text.length, CentredLabelRunSpan::class.java)
    assertEquals(3, spans.size)
    assertEquals(listOf(0 to 2, 2 to 6, 6 to result.sourceText.length), spans.map { text.getSpanStart(it) to text.getSpanEnd(it) })
    assertInkFits(result, 500, 120, horizontal = true)
    fixture("normal-half-mixed", runs, 119, 50)
  }

  @Test
  fun wrappingAndEllipsisOffsetsMatchTheUnshiftedFullParagraph() {
    val cases = listOf(
      listOf(run("Save a rather long paragraph, including several words ", 15f), run("and a bold ending.", 12f, bold)),
      listOf(run("A", 18f), run("ction", 12f), run("Pad", 15f, bold), run(" button wraps across this run boundary ", 10f)),
      listOf(run("سلام hello ", 15f), run("العالم 123 emoji 👩‍💻", 12f, bold)),
      listOf(run("e\u0301 🇬🇧 👩‍💻 ", 18f), run("other text after the combined glyphs", 12f)),
    )
    for (runs in cases) for (width in listOf(56, 148)) {
      val result = layout(runs, width = width, height = 400)
      // The engine may narrow only StaticLayout's native ellipsis budget to account for a
      // first-hidden span whose ellipsis glyph is wider than the base paint's. Compare against an
      // otherwise unshifted native layout with that exact budget, not a duplicated algorithm.
      val reference = referenceLayout(runs, width, result.layout.ellipsizedWidth)
      assertEquals(reference.lineCount, result.layout.lineCount)
      for (line in 0 until reference.lineCount) {
        assertEquals(reference.getLineStart(line), result.layout.getLineStart(line))
        assertEquals(reference.getLineEnd(line), result.layout.getLineEnd(line))
        assertEquals(reference.getEllipsisStart(line), result.layout.getEllipsisStart(line))
        assertEquals(reference.getEllipsisCount(line), result.layout.getEllipsisCount(line))
      }
      assertMeasuredLineMetrics(result)
    }
  }

  @Test
  fun aSingleRunCanFlowAcrossBothPhysicalLines() {
    val result = layout(listOf(run("One run with many ordinary words which need several lines to finish", 15f)), width = 148)
    assertEquals(2, result.lines.size)
    assertTrue(result.lines.all { it.fragments.any { fragment -> fragment.runIndex == 0 } })
    assertTrue(result.lines.last().ellipsisCount > 0)
  }

  @Test
  fun aLargerRunOnTheFirstLineDoesNotInflateTheSecondLine() {
    val result = layout(listOf(run("LARGE\n", 22f), run("small", 10f)), width = 250)
    assertEquals(2, result.lines.size)
    val first = result.lines.first()
    val second = result.lines.last()
    assertTrue(first.descent - first.ascent > second.descent - second.ascent)
    assertEquals(listOf(1), second.fragments.map { it.runIndex })
    assertMeasuredLineMetrics(result)
    assertInkFits(result, 250, 120)
    fixture("large-first-small-second", listOf(run("LARGE\n", 22f), run("small", 10f)), 148, 50)
  }

  @Test
  fun fullyEllipsizedLargeRunsDoNotReserveAnyVisibleHeight() {
    val prefix = "ordinary words ".repeat(20)
    val largeHidden = layout(listOf(run(prefix, 12f), run("HIDDEN HUGE", 90f)), width = 110)
    val smallHidden = layout(listOf(run(prefix, 12f), run("hidden small", 12f)), width = 110)
    assertEquals(2, largeHidden.lines.size)
    assertEquals(smallHidden.layout.height, largeHidden.layout.height)
    assertEquals(smallHidden.layout.ellipsizedWidth, largeHidden.layout.ellipsizedWidth)
    assertTrue(largeHidden.lines.flatMap { it.fragments }.all { it.runIndex == 0 })
    assertTrue(largeHidden.lines.last().ellipsisCount > 0)
  }

  @Test
  fun twoLinesBecomeOneCompleteEllipsizedLineWhenHeightIsInsufficient() {
    val runs = listOf(run("One\nTwo\nThree", 12f))
    val twoLines = layout(runs, width = 200)
    assertEquals(2, twoLines.lines.size)
    val shortHeight = twoLines.layout.height - 1
    val oneLine = layout(runs, width = 200, height = shortHeight)
    assertEquals(ActionLabelLayoutKind.TEXT, oneLine.kind)
    assertEquals(1, oneLine.lines.size)
    assertTrue(oneLine.lines.single().ellipsisCount > 0)
    assertTrue(oneLine.layout.height <= shortHeight)
    assertEquals((shortHeight - oneLine.layout.height) / 2f, oneLine.verticalOffset, 0f)
    assertInkFits(oneLine, 200, shortHeight)
  }

  @Test
  fun aSingleOversizedLineUsesBaseSizeEllipsisOrNoInkWithoutShrinkingRuns() {
    val runs = listOf(run("Big", 70f, bold))
    val full = layout(runs, width = 400, height = 200)
    val indicatorHeight = layout(listOf(run("…", 15f)), width = 400).layout.height
    assertTrue(full.layout.height > indicatorHeight)
    val indicator = layout(runs, width = 400, height = indicatorHeight)
    assertEquals(ActionLabelLayoutKind.ELLIPSIS_ONLY, indicator.kind)
    assertEquals("Big", indicator.sourceText)
    assertEquals("…", indicator.layout.text.toString())
    assertEquals(70f, runs.single().textSize, 0f)
    assertNull(engine.layout(runs, base, LABEL_COLOR, 400, indicatorHeight - 1))
    assertNull(engine.layout(runs, base, LABEL_COLOR, 1, 200))
    assertInkFits(indicator, 400, indicatorHeight)
  }

  @Test
  fun theBasePaintDoesNotImposeItsFontSizeOnAnEntirelyStyledLine() {
    val runs = listOf(run("small", 10f))
    val normalBase = layout(runs)
    val largeBase = assertLayout(engine.layout(runs, LabelTextStyle(60f, bold), LABEL_COLOR, 148, 120))
    assertEquals(normalBase.layout.height, largeBase.layout.height)
  }

  @Test
  fun blankDraftsAndZeroSizedViewsProduceNoInk() {
    assertNull(engine.layout(emptyList(), base, LABEL_COLOR, 100, 50))
    assertNull(engine.layout(listOf(run("")), base, LABEL_COLOR, 100, 50))
    assertNull(engine.layout(listOf(run("Text")), base, LABEL_COLOR, 0, 50))
    assertNull(engine.layout(listOf(run("Text")), base, LABEL_COLOR, 100, 0))
    assertNull(engine.layout(listOf(run("Text")), base, LABEL_COLOR, -1, 50))
  }

  @Test
  fun emptyRunsSeparatorsAndExplicitBlankLinesRetainTheirFlow() {
    val runs = listOf(run(""), run("A", 15f), run(" ", 10f), run("B\n\nC", 12f), run(""))
    val result = layout(runs, width = 250)
    assertEquals("A B\n\nC", result.sourceText)
    assertEquals(2, result.lines.size)
    val spans = (result.layout.text as Spanned).getSpans(0, result.sourceText.length, CentredLabelRunSpan::class.java)
    assertEquals(3, spans.size)
    assertTrue(result.lines.last().ellipsisCount > 0)
    assertMeasuredLineMetrics(result)
  }

  @Test
  fun aTrailingNewlineRetainsTheFinalBlankLineAtBaseSize() {
    val result = layout(listOf(run("one\n", 12f)), width = 250)
    assertEquals(2, result.lines.size)
    assertEquals(result.sourceText.length, result.lines.last().start)
    assertTrue(result.lines.last().fragments.isEmpty())
    assertMeasuredLineMetrics(result)
  }

  @Test
  fun all64RunsRetainTheirIndependentStylesAndSourceRanges() {
    val runs = (0 until 64).map { index -> run("x", if (index % 2 == 0) 10f else 22f, if (index % 3 == 0) bold else regular) }
    val result = layout(runs, width = 2000)
    assertEquals(1, result.lines.size)
    assertEquals(64, result.lines.single().fragments.size)
    assertEquals((0 until 64).toList(), result.lines.single().fragments.map { it.start })
    val spans = (result.layout.text as Spanned).getSpans(0, 64, CentredLabelRunSpan::class.java)
    assertEquals(64, spans.size)
  }

  @Test
  fun primaryAndFallbackGlyphsFitTheProtectedBoxAcrossCompatibilityStrategies() {
    val cases = listOf(
      listOf(run("\uf013 ", 22f), run("Save all", 12f, bold)),
      listOf(run("\udb80\udd98 ", 22f), run("emoji 🙂 👩‍💻 🇬🇧", 12f)),
      listOf(run("e\u0301 A\u030a ", 22f), run("gypq", 10f)),
      listOf(run("سلام ", 18f), run("العالم", 12f, bold)),
      listOf(run("ಕನ್ನಡ ", 18f), run("བོད་", 12f)),
    )
    for (api in listOf(24, 28, 32, 33, 35)) for (runs in cases) {
      val result = assertLayout(ActionLabelLayoutEngine(api).layout(runs, base, LABEL_COLOR, 500, 120))
      assertEquals(ActionLabelLayoutKind.TEXT, result.kind)
      assertInkFits(result, 500, 120, horizontal = true)
      assertMeasuredLineMetrics(result)
      assertTrue(result.lines.flatMap { it.fragments }.all { abs(it.centredBaseline) <= 0.5001f })
    }
    fixture("unicode-and-fallbacks", cases[1], 310, 50)
    fixture("rtl-mixed-label", listOf(run("Save ", 12f), run("سلام", 22f)), 148, 50)
  }

  @Test
  fun systemRegularAndBoldTypefacesUseTheSameAlignmentRules() {
    val runs = listOf(run("Plain ", 22f, Typeface.DEFAULT), run("Bold", 12f, Typeface.DEFAULT_BOLD))
    val result = assertLayout(engine.layout(runs, LabelTextStyle(15f, Typeface.DEFAULT), LABEL_COLOR, 300, 50))
    assertEquals(ActionLabelLayoutKind.TEXT, result.kind)
    assertTrue(result.lines.single().fragments.all { abs(it.centredBaseline) <= 0.5001f })
    assertInkFits(result, 300, 50, horizontal = true)
  }

  @Test
  fun compactQuarterPreviewAndLargerFontScaleProduceCompleteLinesOnly() {
    val runs = listOf(run("\uf013 ", 19f), run("Save", 13f, bold), run(" all", 10f))
    val compact = layout(runs, width = 58, height = 46)
    assertTrue(compact.layout.height <= 46)
    assertTrue(compact.lines.size <= 2)
    assertInkFits(compact, 58, 46)
    fixture("compact-quarter-mixed", runs, 58, 46)
    for (scale in listOf(1f, 1.3f, 2f, 3f)) {
      val scaled = runs.map { it.copy(textSize = it.textSize * scale) }
      val result = engine.layout(scaled, LabelTextStyle(13f * scale, regular), LABEL_COLOR, 58, 46)
      if (result != null) {
        assertTrue(result.layout.height <= 46)
        assertInkFits(result, 58, 46)
      }
      assertEquals(19f * scale, scaled.first().textSize, 0f)
    }
  }

  @Test
  fun actualPreviewStageWidthsSupportBothLargeSmallOrders() {
    for (compact in listOf(false, true)) {
      val style = LabelTextStyle(if (compact) 13f else 15f, regular)
      val iconSize = if (compact) 19f else 22f
      val textSize = if (compact) 13f else 15f
      val smallSize = if (compact) 10f else 12f
      val height = if (compact) 46 else 50
      val widths = if (compact) listOf("half" to 143, "quarter" to 60) else listOf("half" to 119, "quarter" to 45)
      for ((sizeName, width) in widths) for (largeFirst in listOf(true, false)) {
        val runs = if (largeFirst) {
          listOf(run("\uf013 ", iconSize), run("Save", textSize, bold), run(" all", smallSize))
        } else {
          listOf(run("Save ", textSize, bold), run("\uf013", iconSize), run(" all", smallSize))
        }
        val result = assertLayout(engine.layout(runs, style, LABEL_COLOR, width, height))
        assertTrue(result.layout.height <= height)
        assertTrue(result.lines.size <= 2)
        assertInkFits(result, width, height, horizontal = result.lines.all { it.ellipsisCount == 0 })
        fixture(
          "${if (compact) "compact" else "normal"}-$sizeName-${if (largeFirst) "large-first" else "large-last"}",
          runs, width, height, style,
        )
      }
    }
  }

  @Test
  fun ellipsisInkStaysInsideTheNativeWidthForMixedSizeRuns() {
    val cases = listOf(
      listOf(run("M".repeat(40), 22f)),
      listOf(run("m".repeat(60), 10f)),
      listOf(run("small ", 10f), run("M".repeat(40), 22f)),
      listOf(run("BIG ", 22f), run("m".repeat(60), 10f)),
      listOf(run("M".repeat(20), 22f, bold), run("small ending", 12f)),
    )
    val overflows = mutableListOf<String>()
    var correctedBudgets = 0
    for ((index, runs) in cases.withIndex()) for (width in listOf(30, 36, 45, 58, 60, 119)) {
      val result = layout(runs, width, 120)
      if (result.lines.none { it.ellipsisCount > 0 }) continue
      assertEquals(ActionLabelLayoutKind.TEXT, result.kind)
      assertEquals(runs.joinToString("") { it.text }, result.sourceText)
      if (result.layout.ellipsizedWidth < width) correctedBudgets++
      val bounds = inkBounds(result, width, 120)
      if (bounds.left < 0 || bounds.right > width) {
        val last = result.lines.last()
        overflows += "case=$index width=$width ink=${bounds.left}..${bounds.right} ellipsis=${last.ellipsisStart}/${last.ellipsisCount}"
        fixture("ellipsis-probe-$index-$width", runs, width, 120)
      }
    }
    assertTrue("Probe did not exercise a corrected native ellipsis budget", correctedBudgets > 0)
    assertTrue("Ellipsis width overflow:\n${overflows.joinToString("\n")}", overflows.isEmpty())
  }

  private fun layout(runs: List<ResolvedLabelRun>, width: Int = 148, height: Int = 120) =
    assertLayout(engine.layout(runs, base, LABEL_COLOR, width, height))

  private fun assertLayout(result: ActionLabelLayoutResult?): ActionLabelLayoutResult {
    assertNotNull("Expected a complete label or ellipsis to fit", result)
    return result!!
  }

  private fun assertMeasuredLineMetrics(result: ActionLabelLayoutResult) {
    assertEquals(result.lines.size, result.layout.lineCount)
    for ((index, metrics) in result.lines.withIndex()) {
      assertEquals("ascent of physical line $index", metrics.ascent, result.layout.getLineAscent(index))
      assertEquals("descent of physical line $index", metrics.descent, result.layout.getLineDescent(index))
    }
  }

  private fun assertInkFits(result: ActionLabelLayoutResult, width: Int, height: Int, horizontal: Boolean = false) {
    // Deliberately draw without clipping to the view. Overflow remains visible in the guard band,
    // so a bitmap cropped to the intended view cannot accidentally conceal a clipping regression.
    val guard = 100
    val bitmap = Bitmap.createBitmap(width + guard * 2, height + guard * 2, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    canvas.translate(guard.toFloat(), guard + result.verticalOffset)
    result.layout.draw(canvas)
    var hasInk = false
    for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) {
      if (Color.alpha(bitmap.getPixel(x, y)) == 0) continue
      hasInk = true
      assertTrue("Ink above label: y=$y; height=$height; ${result.sourceText}", y >= guard)
      assertTrue("Ink below label: y=$y; height=$height; ${result.sourceText}", y < guard + height)
      if (horizontal) {
        assertTrue("Ink left of label: x=$x; width=$width; ${result.sourceText}", x >= guard)
        assertTrue("Ink right of label: x=$x; width=$width; ${result.sourceText}", x < guard + width)
      }
    }
    assertTrue("Expected visible glyphs in ${result.sourceText}", hasInk)
    bitmap.recycle()
  }

  private fun inkBounds(result: ActionLabelLayoutResult, width: Int, height: Int): Rect {
    val guard = 100
    val bitmap = Bitmap.createBitmap(width + guard * 2, height + guard * 2, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    canvas.translate(guard.toFloat(), guard + result.verticalOffset)
    result.layout.draw(canvas)
    val pixels = IntArray(bitmap.width * bitmap.height)
    bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
    val bounds = Rect(bitmap.width, bitmap.height, 0, 0)
    for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) {
      if (Color.alpha(pixels[y * bitmap.width + x]) == 0) continue
      bounds.left = minOf(bounds.left, x)
      bounds.top = minOf(bounds.top, y)
      bounds.right = maxOf(bounds.right, x + 1)
      bounds.bottom = maxOf(bounds.bottom, y + 1)
    }
    bounds.offset(-guard, -guard)
    bitmap.recycle()
    return bounds
  }

  private fun fixture(name: String, runs: List<ResolvedLabelRun>, width: Int, height: Int, defaultStyle: LabelTextStyle = base) {
    val directory = System.getProperty("codey.label.fixturesDir")?.let(::File) ?: return
    check(directory.exists() || directory.mkdirs())
    val result = assertLayout(engine.layout(runs, defaultStyle, LABEL_COLOR, width, height))
    val scale = 4
    val bitmap = Bitmap.createBitmap((width + 16) * scale, (height + 16) * scale, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    canvas.scale(scale.toFloat(), scale.toFloat())
    canvas.drawColor(Color.rgb(26, 27, 38))
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(36, 40, 59) }
    canvas.drawRoundRect(8f, 8f, width + 8f, height + 8f, 8f, 8f, paint)
    canvas.translate(8f, 8f + result.verticalOffset)
    result.layout.draw(canvas)
    FileOutputStream(File(directory, "$name.png")).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    bitmap.recycle()
  }

  private fun referenceLayout(runs: List<ResolvedLabelRun>, width: Int, ellipsizedWidth: Int): StaticLayout {
    val text = SpannableStringBuilder()
    for (run in runs) {
      val start = text.length
      text.append(run.text)
      if (start < text.length) text.setSpan(CentredLabelRunSpan(run.textSize, run.typeface, 0), start, text.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
      textSize = 15f
      typeface = regular
      isSubpixelText = true
      isLinearText = true
    }
    return StaticLayout.Builder.obtain(text, 0, text.length, paint, width)
      .setAlignment(Layout.Alignment.ALIGN_CENTER)
      .setTextDirection(TextDirectionHeuristics.FIRSTSTRONG_LTR)
      .setBreakStrategy(Layout.BREAK_STRATEGY_HIGH_QUALITY)
      .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
      .setIncludePad(false)
      .setUseLineSpacingFromFallbacks(true)
      .setLineSpacing(0f, 1f)
      .setEllipsize(TextUtils.TruncateAt.END)
      .setEllipsizedWidth(ellipsizedWidth)
      .setMaxLines(2)
      .build()
  }

  private fun run(text: String, size: Float = 15f, face: Typeface = regular) = ResolvedLabelRun(text, size, face)

  companion object {
    private val fontsDirectory: File by lazy {
      File(checkNotNull(System.getProperty("codey.label.fontsDir")) { "Set codey.label.fontsDir to the bundled Nerd Font assets" })
    }
    private val regular: Typeface by lazy { Typeface.createFromFile(File(fontsDirectory, "JetBrainsMonoNerdFontMono-Regular.ttf")) }
    private val bold: Typeface by lazy { Typeface.createFromFile(File(fontsDirectory, "JetBrainsMonoNerdFontMono-Bold.ttf")) }
    private val LABEL_COLOR = Color.rgb(192, 202, 245)
  }
}
