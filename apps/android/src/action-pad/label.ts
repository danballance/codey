import type {
  ActionButtonFontSize,
  ActionButtonLabel,
  ActionButtonLabelRun
} from './types'

export const DEFAULT_ACTION_BUTTON_LABEL_RUN: ActionButtonLabelRun = Object.freeze({
  text: '',
  fontSize: 15,
  bold: false
})

const COMPACT_ACTION_BUTTON_FONT_SIZES: Readonly<Record<ActionButtonFontSize, number>> = {
  10: 9,
  12: 10,
  15: 13,
  18: 16,
  22: 19
}

/** Presents a legacy string label as a single virtual run without changing its stored form. */
export function actionButtonLabelRuns(label: ActionButtonLabel): readonly ActionButtonLabelRun[] {
  if (typeof label !== 'string') return label
  return [{ ...DEFAULT_ACTION_BUTTON_LABEL_RUN, text: label }]
}

export function plainActionButtonLabel(label: ActionButtonLabel): string {
  if (typeof label === 'string') return label
  return label.map((run) => run.text).join('')
}

export function compactActionButtonFontSize(fontSize: ActionButtonFontSize): number {
  return COMPACT_ACTION_BUTTON_FONT_SIZES[fontSize]
}

/** Detects BMP and supplementary Unicode Private Use Area characters. */
export function containsPrivateUseGlyph(label: ActionButtonLabel): boolean {
  for (const character of plainActionButtonLabel(label)) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined) continue
    if (
      (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
      (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
      (codePoint >= 0x100000 && codePoint <= 0x10fffd)
    ) return true
  }
  return false
}
