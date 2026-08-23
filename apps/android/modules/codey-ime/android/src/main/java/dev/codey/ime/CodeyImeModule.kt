package dev.codey.ime

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CodeyImeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CodeyIme")

    View(CodeyImeView::class) {
      Events("onCommittedText", "onKey", "onOrderedInput")

      Prop("inputMode") { view: CodeyImeView, inputMode: String ->
        view.setInputMode(inputMode)
      }

      AsyncFunction("focusIme") { view: CodeyImeView ->
        view.focusKeyboard()
      }

      AsyncFunction("blurIme") { view: CodeyImeView ->
        view.blurKeyboard()
      }

      AsyncFunction("sendOrderedInput") { view: CodeyImeView, keys: String ->
        view.sendOrderedInput(keys)
      }

      AsyncFunction("settleComposition") { view: CodeyImeView ->
        view.settleComposition()
      }

      OnViewDestroys { view: CodeyImeView ->
        view.blurKeyboard()
      }
    }
  }
}
