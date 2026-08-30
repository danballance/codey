package dev.codey.actionlabel

import android.annotation.TargetApi
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.os.Build
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.SpannedString
import android.text.StaticLayout
import android.text.TextDirectionHeuristics
import android.text.TextPaint
import android.text.TextUtils
import android.text.style.ForegroundColorSpan
import android.text.style.LineHeightSpan
import android.text.style.MetricAffectingSpan
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Resolved native inputs. Sizes and all layout dimensions are physical pixels. */
data class ResolvedLabelRun(
  val text: String,
  val textSize: Float,
  val typeface: Typeface,
  val color: Int = DEFAULT_ACTION_LABEL_COLOR,
)

data class LabelTextStyle(val textSize: Float, val typeface: Typeface)

enum class ActionLabelLayoutKind { TEXT, ELLIPSIS_ONLY }

/** A fragment is diagnostic metadata only; it never becomes an independent text layout. */
data class ActionLabelFragmentMetrics(
  val runIndex: Int,
  val start: Int,
  val end: Int,
  val isEllipsis: Boolean,
  val baselineShift: Int,
  val primaryAscent: Float,
  val primaryDescent: Float,
  val protectedAscent: Float,
  val protectedDescent: Float,
) {
  val centredBaseline: Float
    get() = (primaryAscent + primaryDescent) / 2f + baselineShift
}

data class ActionLabelLineMetrics(
  val start: Int,
  val end: Int,
  val ellipsisStart: Int,
  val ellipsisCount: Int,
  val ascent: Int,
  val descent: Int,
  val fragments: List<ActionLabelFragmentMetrics>,
)

data class ActionLabelLayoutResult(
  val layout: StaticLayout,
  val verticalOffset: Float,
  val kind: ActionLabelLayoutKind,
  val sourceText: String,
  val lines: List<ActionLabelLineMetrics>,
)

/**
 * Keeps Android's paragraph shaping, Unicode handling and wrapping, changing only vertical metrics.
 *
 * The first layout discovers physical lines and native ellipsis offsets. The second has exactly
 * the same metric-span boundaries and horizontal paints, but centres each run's primary font box
 * on its line baseline. Explicit line metrics account for the translated visible glyphs. Android's
 * normal baselineShift measurement expands only one side of a font box, so it is not sufficient
 * on its own to measure this layout (particularly when smaller text wraps onto another line).
 *
 * There is no retained mutable layout state: the owning view can cache the returned result until
 * its props, dimensions, fonts or system configuration change.
 */
class ActionLabelLayoutEngine(private val apiLevel: Int = Build.VERSION.SDK_INT) {
  fun layout(
    runs: List<ResolvedLabelRun>,
    defaultStyle: LabelTextStyle,
    color: Int,
    width: Int,
    height: Int,
  ): ActionLabelLayoutResult? {
    if (width <= 0 || height <= 0) return null
    require(defaultStyle.textSize.isFinite() && defaultStyle.textSize > 0f)
    require(runs.all { it.textSize.isFinite() && it.textSize > 0f })

    val source = prepare(runs, defaultStyle, color)
    if (source.text.isEmpty()) return null

    for (maxLines in 2 downTo 1) {
      val candidate = candidate(source, width, maxLines) ?: continue
      if (candidate.layout.height <= height) {
        return candidate.copy(verticalOffset = (height - candidate.layout.height) / 2f)
      }
    }

    // A complete line at the selected sizes cannot fit. The indicator uses the existing base
    // style; no content run is ever scaled down to fit its button.
    val indicator = prepare(
      listOf(ResolvedLabelRun(ELLIPSIS, defaultStyle.textSize, defaultStyle.typeface, color)),
      defaultStyle,
      color,
    )
    if (indicator.base.paint.measureText(ELLIPSIS) > width) return null
    val candidate = candidate(indicator, width, 1) ?: return null
    if (candidate.layout.height > height || candidate.lines.any { it.ellipsisCount != 0 }) return null
    return candidate.copy(
      verticalOffset = (height - candidate.layout.height) / 2f,
      kind = ActionLabelLayoutKind.ELLIPSIS_ONLY,
      sourceText = source.text,
    )
  }

  private fun prepare(
    runs: List<ResolvedLabelRun>,
    defaultStyle: LabelTextStyle,
    color: Int,
  ): Source {
    val paints = mutableMapOf<LabelTextStyle, RunPaint>()
    fun resolve(style: LabelTextStyle): RunPaint = paints.getOrPut(style) {
      val paint = textPaint(style, color)
      val metrics = paint.fontMetrics
      RunPaint(
        paint,
        Envelope(metrics.ascent, metrics.descent, metrics.top, metrics.bottom),
        (-(metrics.ascent + metrics.descent) / 2f).roundToInt(),
      )
    }

    val text = StringBuilder()
    val ranges = runs.mapIndexedNotNull { index, run ->
      val start = text.length
      text.append(run.text)
      if (start == text.length) null else RunRange(
        index, start, text.length, resolve(LabelTextStyle(run.textSize, run.typeface)), run.color,
      )
    }
    return Source(text.toString(), ranges, resolve(defaultStyle))
  }

  private fun candidate(source: Source, width: Int, maxLines: Int): ActionLabelLayoutResult? {
    val discoveryResult = discoveryLayout(source, width, maxLines) ?: return null
    val discovery = discoveryResult.layout
    if (discovery.lineCount == 0 || discovery.lineCount > maxLines) return null

    val lineMetrics = (0 until discovery.lineCount).map { line ->
      val start = discovery.getLineStart(line)
      val end = discovery.getLineEnd(line)
      val ellipsisCount = discovery.getEllipsisCount(line)
      val ellipsisStart = start + discovery.getEllipsisStart(line)
      if (start == end && end == source.text.length && ellipsisCount == 0) {
        // StaticLayout appends a zero-character sentinel line after a trailing newline without
        // consulting LineHeightSpan. It contains no glyph to shift, so retain its native base-
        // font geometry rather than inserting a character merely to force span processing.
        return@map ActionLabelLineMetrics(
          start, end, ellipsisStart, 0,
          discovery.getLineAscent(line), discovery.getLineDescent(line), emptyList(),
        )
      }
      val ranges = if (ellipsisCount > 0) {
        listOf(start until ellipsisStart, (ellipsisStart + ellipsisCount) until end)
      } else {
        listOf(start until end)
      }
      val fragments = mutableListOf<MeasuredFragment>()
      for (visibleRange in ranges) {
        // A newline controls flow, not the visual height of the preceding line.
        var visibleEnd = visibleRange.last + 1
        while (visibleEnd > visibleRange.first && source.text[visibleEnd - 1] in "\r\n") visibleEnd--
        for (run in source.runs) {
          val fragmentStart = max(run.start, visibleRange.first)
          val fragmentEnd = min(run.end, visibleEnd)
          if (fragmentStart >= fragmentEnd) continue
          fragments += measureFragment(source, discovery, run, fragmentStart, fragmentEnd)
        }
      }

      if (ellipsisCount > 0) {
        val run = source.runs.firstOrNull { ellipsisStart >= it.start && ellipsisStart < it.end }
        val runPaint = run?.paint ?: source.base
        // StaticLayout substitutes one ellipsis at the first hidden source offset. Other hidden
        // characters are zero-width fillers: their fonts must not inflate the visible line.
        if (runPaint.paint.measureText(ELLIPSIS) > width) return null
        fragments += MeasuredFragment(
          run?.index ?: -1,
          ellipsisStart,
          ellipsisStart + ellipsisCount,
          true,
          runPaint,
          safeEnvelope(ELLIPSIS, 0, ELLIPSIS.length, runPaint, false),
        )
      }

      if (fragments.isEmpty()) {
        // Keep explicit blank lines at the base font size.
        fragments += MeasuredFragment(-1, start, end, false, source.base, source.base.metrics)
      }

      var ascent = Float.POSITIVE_INFINITY
      var descent = Float.NEGATIVE_INFINITY
      val diagnostics = fragments.map { fragment ->
        val shift = fragment.paint.shift
        val envelope = fragment.envelope
        val protectedAscent = min(envelope.ascent, if (line == 0) envelope.top else envelope.ascent) + shift
        val protectedDescent = max(
          envelope.descent,
          if (line == discovery.lineCount - 1) envelope.bottom else envelope.descent,
        ) + shift
        ascent = min(ascent, protectedAscent)
        descent = max(descent, protectedDescent)
        ActionLabelFragmentMetrics(
          fragment.runIndex,
          fragment.start,
          fragment.end,
          fragment.isEllipsis,
          shift,
          fragment.paint.metrics.ascent,
          fragment.paint.metrics.descent,
          protectedAscent,
          protectedDescent,
        )
      }
      ActionLabelLineMetrics(
        start, end, ellipsisStart, ellipsisCount,
        floor(ascent.toDouble()).toInt(), ceil(descent.toDouble()).toInt(), diagnostics.toList(),
      )
    }

    val finalPaint = TextPaint(source.base.paint).apply { baselineShift = source.base.shift }
    val result = buildLayout(
      spanned(source, centred = true, lines = lineMetrics), finalPaint, width, maxLines,
      discoveryResult.ellipsizedWidth,
    )
    // Vertical-only spans must not change shaping boundaries or line/ellipsis positions. A
    // platform inconsistency should fail closed to the next complete-line/indicator candidate.
    if (result.lineCount != discovery.lineCount) return null
    if (lineMetrics.indices.any { line ->
      result.getLineStart(line) != lineMetrics[line].start ||
        result.getLineEnd(line) != lineMetrics[line].end ||
        result.getEllipsisStart(line) != discovery.getEllipsisStart(line) ||
        result.getEllipsisCount(line) != lineMetrics[line].ellipsisCount
    }) return null
    return ActionLabelLayoutResult(result, 0f, ActionLabelLayoutKind.TEXT, source.text, lineMetrics.toList())
  }

  private fun discoveryLayout(source: Source, width: Int, maxLines: Int): Discovery? {
    val text = spanned(source, centred = false)
    val baseEllipsisWidth = source.base.paint.measureText(ELLIPSIS)
    var correction = 0
    // The first hidden character can move into an earlier run when more ellipsis width is
    // reserved. Never relax a discovered correction, so this terminates after at most the number
    // of persisted span transitions while remaining conservative at a transition.
    repeat(source.runs.size + 2) {
      val ellipsizedWidth = (width - correction).coerceAtLeast(0)
      val layout = buildLayout(text, source.base.paint, width, maxLines, ellipsizedWidth)
      if (layout.lineCount == 0 || layout.lineCount > maxLines) return null
      var requiredCorrection = correction
      for (line in 0 until layout.lineCount) {
        if (layout.getEllipsisCount(line) == 0) continue
        val ellipsisStart = layout.getLineStart(line) + layout.getEllipsisStart(line)
        val style = source.runs.firstOrNull { ellipsisStart >= it.start && ellipsisStart < it.end }?.paint
          ?: source.base
        val actualEllipsisWidth = style.paint.measureText(ELLIPSIS)
        if (actualEllipsisWidth > width) return null
        requiredCorrection = max(
          requiredCorrection,
          ceil((actualEllipsisWidth - baseEllipsisWidth).coerceAtLeast(0f).toDouble()).toInt(),
        )
      }
      if (requiredCorrection == correction) return Discovery(layout, ellipsizedWidth)
      correction = requiredCorrection
    }
    return null
  }

  private fun measureFragment(
    source: Source,
    discovery: StaticLayout,
    run: RunRange,
    start: Int,
    end: Int,
  ): MeasuredFragment {
    var envelope = run.paint.metrics
    // Font-metrics APIs take a shaping direction. Keep supplementary characters intact while
    // partitioning only this measurement into the directions already resolved by Android.
    var directionStart = start
    while (directionStart < end) {
      val rtl = discovery.isRtlCharAt(directionStart)
      var directionEnd = min(end, directionStart + Character.charCount(source.text.codePointAt(directionStart)))
      while (directionEnd < end && discovery.isRtlCharAt(directionEnd) == rtl) {
        directionEnd = min(end, directionEnd + Character.charCount(source.text.codePointAt(directionEnd)))
      }
      envelope = envelope.union(safeEnvelope(source.text, directionStart, directionEnd, run.paint, rtl))
      directionStart = directionEnd
    }
    return MeasuredFragment(run.index, start, end, false, run.paint, envelope)
  }

  private fun safeEnvelope(text: String, start: Int, end: Int, run: RunPaint, rtl: Boolean): Envelope {
    var envelope = run.metrics
    if (start >= end) return envelope
    if (apiLevel >= 33 && Build.VERSION.SDK_INT >= 33) {
      envelope = envelope.union(fallbackMetrics(text, start, end, run.paint, rtl))
    } else if (apiLevel >= 28 && Build.VERSION.SDK_INT >= 28) {
      // API28–32 exposes fallback line extents through StaticLayout, but not through Paint's
      // text-specific font-metrics overload. This probe is never used to draw or wrap the label.
      val fragment = text.substring(start, end)
      val desiredWidth = ceil(Layout.getDesiredWidth(fragment, run.paint).toDouble())
        .coerceIn(1.0, (Int.MAX_VALUE / 8).toDouble()).toInt()
      val probe = StaticLayout.Builder.obtain(fragment, 0, fragment.length, run.paint, desiredWidth)
        .setIncludePad(false)
        .setTextDirection(if (rtl) TextDirectionHeuristics.RTL else TextDirectionHeuristics.LTR)
        .setLineSpacing(0f, 1f)
        .setUseLineSpacingFromFallbacks(true)
        .build()
      for (line in 0 until probe.lineCount) {
        envelope = envelope.include(probe.getLineAscent(line).toFloat(), probe.getLineDescent(line).toFloat())
      }
    }

    // Paint's primary metrics alone omit fallback glyphs. Bounds are available on API24 and also
    // guard glyphs exceeding their font's advertised metrics. They only enlarge safety space;
    // the run's centre always comes from the stable primary ascent/descent above.
    val bounds = Rect()
    run.paint.getTextBounds(text, start, end, bounds)
    if (bounds.top < bounds.bottom) {
      envelope = envelope.include(bounds.top - 1f, bounds.bottom + 1f)
    }
    return envelope
  }

  @TargetApi(33)
  private fun fallbackMetrics(text: String, start: Int, end: Int, paint: TextPaint, rtl: Boolean): Envelope {
    val metrics = Paint.FontMetricsInt()
    paint.getFontMetricsInt(text, start, end - start, start, end - start, rtl, metrics)
    return Envelope(metrics.ascent.toFloat(), metrics.descent.toFloat(), metrics.top.toFloat(), metrics.bottom.toFloat())
  }

  private fun spanned(
    source: Source,
    centred: Boolean,
    lines: List<ActionLabelLineMetrics>? = null,
  ): SpannedString {
    val text = SpannableStringBuilder(source.text)
    for (run in source.runs) {
      text.setSpan(
        CentredLabelRunSpan(run.paint.paint.textSize, run.paint.paint.typeface, if (centred) run.paint.shift else 0),
        run.start, run.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
      )
      text.setSpan(
        ForegroundColorSpan(run.color),
        run.start, run.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
      )
    }
    if (lines != null) {
      text.setSpan(VisibleLineHeightSpan(lines), 0, text.length, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
    }
    return SpannedString(text)
  }

  private fun buildLayout(
    text: CharSequence,
    paint: TextPaint,
    width: Int,
    maxLines: Int,
    ellipsizedWidth: Int = width,
  ): StaticLayout {
    val builder = StaticLayout.Builder.obtain(text, 0, text.length, paint, width)
      .setAlignment(Layout.Alignment.ALIGN_CENTER)
      .setTextDirection(TextDirectionHeuristics.FIRSTSTRONG_LTR)
      .setBreakStrategy(Layout.BREAK_STRATEGY_HIGH_QUALITY)
      .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
      .setLineSpacing(0f, 1f)
      .setIncludePad(false)
      .setEllipsize(TextUtils.TruncateAt.END)
      .setEllipsizedWidth(ellipsizedWidth)
      .setMaxLines(maxLines)
    if (apiLevel >= 28 && Build.VERSION.SDK_INT >= 28) builder.setUseLineSpacingFromFallbacks(true)
    return builder.build()
  }

  private data class Source(val text: String, val runs: List<RunRange>, val base: RunPaint)
  private data class Discovery(val layout: StaticLayout, val ellipsizedWidth: Int)
  private data class RunRange(
    val index: Int,
    val start: Int,
    val end: Int,
    val paint: RunPaint,
    val color: Int,
  )
  private data class RunPaint(val paint: TextPaint, val metrics: Envelope, val shift: Int)
  private data class MeasuredFragment(
    val runIndex: Int,
    val start: Int,
    val end: Int,
    val isEllipsis: Boolean,
    val paint: RunPaint,
    val envelope: Envelope,
  )

  private data class Envelope(val ascent: Float, val descent: Float, val top: Float, val bottom: Float) {
    fun union(other: Envelope) = Envelope(
      min(ascent, other.ascent), max(descent, other.descent), min(top, other.top), max(bottom, other.bottom),
    )
    fun include(above: Float, below: Float) = Envelope(
      min(ascent, above), max(descent, below), min(top, above), max(bottom, below),
    )
  }

  companion object {
    private const val ELLIPSIS = "\u2026"
    private fun textPaint(style: LabelTextStyle, color: Int) = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
      textSize = style.textSize
      typeface = style.typeface
      this.color = color
      isSubpixelText = true
      isLinearText = true
    }
  }
}

internal class CentredLabelRunSpan(
  private val size: Float,
  private val face: Typeface,
  private val shift: Int,
) : MetricAffectingSpan() {
  override fun updateMeasureState(textPaint: TextPaint) = apply(textPaint)
  override fun updateDrawState(textPaint: TextPaint) = apply(textPaint)

  private fun apply(paint: TextPaint) {
    paint.textSize = size
    paint.typeface = face
    paint.baselineShift = shift
    paint.isSubpixelText = true
    paint.isLinearText = true
  }
}

private class VisibleLineHeightSpan(private val lines: List<ActionLabelLineMetrics>) : LineHeightSpan {
  override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, v: Int, fm: Paint.FontMetricsInt) {
    val line = lines.firstOrNull { it.start == start && it.end == end } ?: return
    fm.ascent = line.ascent
    fm.top = line.ascent
    fm.descent = line.descent
    fm.bottom = line.descent
    fm.leading = 0
  }
}
