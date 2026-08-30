package dev.codey.actionlabel

import android.content.Context
import android.content.res.AssetManager
import android.graphics.Color
import android.graphics.Typeface
import android.util.TypedValue
import com.facebook.react.common.assets.ReactFontManager
import kotlin.math.ceil

internal data class ActionLabelRunSpec(
  val text: String,
  val fontSize: Double,
  val fontFamily: String?,
  val fontWeight: Int
)

internal data class ActionLabelContent(
  val runs: List<ActionLabelRunSpec> = emptyList(),
  val defaultFontSize: Double = 15.0,
  val defaultFontFamily: String? = null,
  val color: Int = Color.rgb(192, 202, 245)
)

/** Keeps Expo/Yoga lifecycle concerns out of the native text-layout engine. */
internal class ActionLabelViewState(
  private val engine: ActionLabelLayoutEngine = ActionLabelLayoutEngine(),
  private val typefaceResolver: (String?, Int, AssetManager) -> Typeface = ::resolveActionLabelTypeface
) {
  private var content = ActionLabelContent()
  private var cachedKey: LayoutKey? = null
  private var cachedLayout: ActionLabelLayoutResult? = null

  fun update(next: ActionLabelContent): Boolean {
    // Do not retain a mutable bridge list after the property transaction.
    val snapshot = next.copy(runs = next.runs.toList())
    if (snapshot == content) return false
    content = snapshot
    invalidate()
    return true
  }

  fun invalidate() {
    cachedKey = null
    cachedLayout = null
  }

  fun layout(context: Context, width: Int, height: Int): ActionLabelLayoutResult? {
    val resources = context.resources
    val metrics = resources.displayMetrics
    val configuration = resources.configuration
    val key = LayoutKey(
      width, height, metrics.densityDpi, metrics.density,
      configuration.fontScale, metrics.scaledDensity,
      configuration.locales.toLanguageTags(), configuration.layoutDirection
    )
    if (cachedKey == key) return cachedLayout

    // Use current resources (including Android's nonlinear SP conversion),
    // rounding like RN's TextAttributeProps. JS has only applied compact presets.
    fun pixels(size: Double): Float {
      val safeSize = if (size.isFinite() && size > 0.0) size else content.defaultFontSize
      val validSize = if (safeSize.isFinite() && safeSize > 0.0) safeSize else 15.0
      return ceil(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, validSize.toFloat(), metrics))
    }

    val defaultStyle = LabelTextStyle(
      pixels(content.defaultFontSize),
      typefaceResolver(content.defaultFontFamily, 400, context.assets)
    )
    val runs = content.runs.map { run ->
      ResolvedLabelRun(
        run.text,
        pixels(run.fontSize),
        typefaceResolver(run.fontFamily, run.fontWeight, context.assets)
      )
    }
    cachedLayout = engine.layout(runs, defaultStyle, content.color, width, height)
    cachedKey = key
    return cachedLayout
  }

  private data class LayoutKey(
    val width: Int,
    val height: Int,
    val densityDpi: Int,
    val density: Float,
    val fontScale: Float,
    val scaledDensity: Float,
    val locales: String,
    val layoutDirection: Int
  )
}

/** Expo Font registers each concrete face in this cache as Typeface.NORMAL. */
internal fun resolveActionLabelTypeface(family: String?, weight: Int, assets: AssetManager): Typeface =
  if (family.isNullOrBlank()) {
    Typeface.create(Typeface.DEFAULT, if (weight == 700) Typeface.BOLD else Typeface.NORMAL)
  } else {
    ReactFontManager.getInstance().getTypeface(family, Typeface.NORMAL, assets)
  }
