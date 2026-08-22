package dev.codey.ime

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CodeyImeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CodeyIme")

    View(CodeyImeView::class) {
      Events("onCommittedText", "onKey")

      AsyncFunction("focusIme") { view: CodeyImeView ->
        view.focusKeyboard()
      }

      AsyncFunction("blurIme") { view: CodeyImeView ->
        view.blurKeyboard()
      }

      AsyncFunction("sendImeKey") {
          view: CodeyImeView,
          key: String,
          ctrl: Boolean,
          alt: Boolean,
          shift: Boolean,
          meta: Boolean,
          repeat: Boolean ->
        view.sendImeKey(key, ctrl, alt, shift, meta, repeat)
      }

      OnViewDestroys { view: CodeyImeView ->
        view.blurKeyboard()
      }
    }
  }
}
