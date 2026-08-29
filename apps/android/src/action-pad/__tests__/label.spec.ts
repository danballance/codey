import {
  DEFAULT_ACTION_BUTTON_LABEL_RUN,
  actionButtonLabelRuns,
  compactActionButtonFontSize,
  containsPrivateUseGlyph,
  plainActionButtonLabel
} from '../label'
import { ACTION_BUTTON_FONT_SIZES, type ActionButtonLabel } from '../types'

describe('action button label utilities', () => {
  it('presents legacy strings as one default virtual run', () => {
    expect(Object.isFrozen(DEFAULT_ACTION_BUTTON_LABEL_RUN)).toBe(true)
    expect(actionButtonLabelRuns('Save')).toEqual([
      { ...DEFAULT_ACTION_BUTTON_LABEL_RUN, text: 'Save' }
    ])
  })

  it('preserves rich runs and derives their plain text', () => {
    const label: ActionButtonLabel = [
      { text: '\uf07c ', fontSize: 22, bold: false },
      { text: 'Save', fontSize: 15, bold: true },
      { text: ' all', fontSize: 15, bold: false }
    ]

    expect(actionButtonLabelRuns(label)).toBe(label)
    expect(plainActionButtonLabel(label)).toBe('\uf07c Save all')
    expect(plainActionButtonLabel('Legacy')).toBe('Legacy')
  })

  it('uses the fixed compact size for every supported normal size', () => {
    expect(ACTION_BUTTON_FONT_SIZES.map((size) => [size, compactActionButtonFontSize(size)])).toEqual([
      [10, 9], [12, 10], [15, 13], [18, 16], [22, 19]
    ])
  })

  it('detects glyphs in every Unicode Private Use Area without treating emoji as private-use', () => {
    expect(containsPrivateUseGlyph('plain 😀')).toBe(false)
    expect(containsPrivateUseGlyph(`BMP ${String.fromCodePoint(0xe000)}`)).toBe(true)
    expect(containsPrivateUseGlyph(`plane 15 ${String.fromCodePoint(0xf0000)}`)).toBe(true)
    expect(containsPrivateUseGlyph(`plane 16 ${String.fromCodePoint(0x100000)}`)).toBe(true)
    expect(containsPrivateUseGlyph([
      { text: String.fromCodePoint(0x10fffd), fontSize: 22, bold: false }
    ])).toBe(true)
  })
})
