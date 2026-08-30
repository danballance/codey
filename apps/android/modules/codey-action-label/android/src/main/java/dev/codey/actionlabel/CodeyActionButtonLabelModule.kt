package dev.codey.actionlabel

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** Private bridge data. The version-1 action document does not use this type. */
class ActionLabelRunRecord : Record {
  @Field var text: String = ""
  @Field var fontSize: Double = 15.0
  @Field var fontFamily: String? = null
  @Field var fontWeight: Int = 400
}

class CodeyActionButtonLabelModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CodeyActionButtonLabel")

    View(CodeyActionButtonLabelView::class) {
      Prop("runs") { view: CodeyActionButtonLabelView, runs: List<ActionLabelRunRecord> ->
        view.setRuns(runs.map { ActionLabelRunSpec(it.text, it.fontSize, it.fontFamily, it.fontWeight) })
      }
      Prop("defaultFontSize") { view: CodeyActionButtonLabelView, size: Double ->
        view.setDefaultFontSize(size)
      }
      Prop("defaultFontFamily") { view: CodeyActionButtonLabelView, family: String? ->
        view.setDefaultFontFamily(family)
      }
      Prop("color") { view: CodeyActionButtonLabelView, color: String ->
        view.setLabelColor(color)
      }
      OnViewDidUpdateProps { view: CodeyActionButtonLabelView ->
        view.commitProps()
      }
      OnViewDestroys { view: CodeyActionButtonLabelView ->
        view.releaseLayout()
      }
    }
  }
}
