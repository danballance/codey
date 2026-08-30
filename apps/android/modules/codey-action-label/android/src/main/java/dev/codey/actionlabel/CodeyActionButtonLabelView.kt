package dev.codey.actionlabel

import android.content.Context
import android.content.res.Configuration
import android.graphics.Canvas
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/**
 * One noninteractive drawing surface. Yoga supplies the existing button's
 * padded content bounds; StaticLayout owns all text flow inside those bounds.
 */
class CodeyActionButtonLabelView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private var pendingContent = ActionLabelContent()
  private val renderer = ActionLabelViewState()

  init {
    setWillNotDraw(false)
    isFocusable = false
    isFocusableInTouchMode = false
    isClickable = false
    isLongClickable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    contentDescription = null
  }

  internal fun setRuns(runs: List<ActionLabelRunSpec>) {
    pendingContent = pendingContent.copy(runs = runs.toList())
  }

  internal fun setDefaultFontSize(size: Double) {
    pendingContent = pendingContent.copy(defaultFontSize = size)
  }

  internal fun setDefaultFontFamily(family: String?) {
    pendingContent = pendingContent.copy(defaultFontFamily = family)
  }

  internal fun setLabelColor(color: String) {
    pendingContent = pendingContent.copy(
      color = resolveActionLabelColor(color, DEFAULT_ACTION_LABEL_COLOR)
    )
  }

  internal fun commitProps() {
    if (renderer.update(pendingContent)) invalidate()
  }

  internal fun releaseLayout() {
    renderer.invalidate()
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    renderer.invalidate()
    invalidate()
  }

  override fun onConfigurationChanged(configuration: Configuration) {
    super.onConfigurationChanged(configuration)
    renderer.invalidate()
    invalidate()
  }

  override fun onDetachedFromWindow() {
    renderer.invalidate()
    super.onDetachedFromWindow()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val contentWidth = width - paddingLeft - paddingRight
    val contentHeight = height - paddingTop - paddingBottom
    val result = renderer.layout(context, contentWidth, contentHeight) ?: return
    val checkpoint = canvas.save()
    try {
      canvas.translate(paddingLeft.toFloat(), paddingTop.toFloat())
      canvas.clipRect(0, 0, contentWidth, contentHeight)
      canvas.translate(0f, result.verticalOffset)
      result.layout.draw(canvas)
    } finally {
      canvas.restoreToCount(checkpoint)
    }
  }
}
