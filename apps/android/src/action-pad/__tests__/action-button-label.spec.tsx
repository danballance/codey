import { StyleSheet } from 'react-native'
import { cleanup, render } from '@testing-library/react-native'

import { CODEY_NERD_FONT_FAMILIES } from '../../fonts'
import { ActionButtonLabel } from '../ActionButtonLabel'
import { ActionPad } from '../ActionPad'
import {
  type ActionButtonLabel as ActionButtonLabelValue,
  type ActionMenu
} from '../types'

jest.mock('../../fonts', () => ({
  CODEY_NERD_FONT_FAMILIES: {
    regular: 'CodeyNerdFont-Regular',
    semiBold: 'CodeyNerdFont-SemiBold',
    bold: 'CodeyNerdFont-Bold',
    italic: 'CodeyNerdFont-Italic',
    boldItalic: 'CodeyNerdFont-BoldItalic'
  },
  useCodeyNerdFontFaces: jest.fn(() => [true, null])
}))

afterEach(cleanup)

const mixedLabel: ActionButtonLabelValue = [
  { text: ' ', fontSize: 22, bold: false },
  { text: 'Save', fontSize: 15, bold: true },
  { text: ' all', fontSize: 12, bold: false }
]

describe('ActionButtonLabel', () => {
  it('renders legacy labels in regular weight with unchanged two-line layout and sizes', () => {
    const screen = render(
      <ActionButtonLabel fontFacesLoaded label="Legacy" testID="label" />
    )

    const normal = screen.getByTestId('label')
    expect(normal.props.numberOfLines).toBe(2)
    expect(StyleSheet.flatten(normal.props.style)).toMatchObject({
      color: '#c0caf5',
      fontFamily: CODEY_NERD_FONT_FAMILIES.regular,
      fontSize: 15,
      fontWeight: 'normal',
      textAlign: 'center'
    })

    screen.rerender(
      <ActionButtonLabel compact fontFacesLoaded={false} label="Legacy" testID="label" />
    )
    expect(StyleSheet.flatten(screen.getByTestId('label').props.style)).toMatchObject({
      fontSize: 13,
      fontWeight: '400'
    })
    expect(StyleSheet.flatten(screen.getByTestId('label').props.style).fontFamily).toBeUndefined()
  })

  it('renders ordered runs with independent font sizes and concrete faces', () => {
    const screen = render(
      <ActionButtonLabel fontFacesLoaded label={mixedLabel} testID="label" />
    )

    expect(StyleSheet.flatten(screen.getByText('').props.style)).toMatchObject({
      fontFamily: CODEY_NERD_FONT_FAMILIES.regular,
      fontSize: 22,
      fontWeight: 'normal'
    })
    expect(StyleSheet.flatten(screen.getByText('Save').props.style)).toMatchObject({
      fontFamily: CODEY_NERD_FONT_FAMILIES.bold,
      fontSize: 15,
      fontWeight: 'normal'
    })
    expect(StyleSheet.flatten(screen.getByText('all').props.style)).toMatchObject({
      fontFamily: CODEY_NERD_FONT_FAMILIES.regular,
      fontSize: 12,
      fontWeight: 'normal'
    })
  })

  it('uses every fixed compact size and system-weight fallback', () => {
    const label: ActionButtonLabelValue = [
      { text: 'a', fontSize: 10, bold: false },
      { text: 'b', fontSize: 12, bold: true },
      { text: 'c', fontSize: 15, bold: false },
      { text: 'd', fontSize: 18, bold: true },
      { text: 'e', fontSize: 22, bold: false }
    ]
    const screen = render(
      <ActionButtonLabel compact fontFacesLoaded={false} label={label} />
    )

    for (const [text, fontSize, fontWeight] of [
      ['a', 9, '400'],
      ['b', 10, '700'],
      ['c', 13, '400'],
      ['d', 16, '700'],
      ['e', 19, '400']
    ] as const) {
      const style = StyleSheet.flatten(screen.getByText(text).props.style)
      expect(style).toMatchObject({ fontSize, fontWeight })
      expect(style.fontFamily).toBeUndefined()
    }
  })

  it('uses the concatenated visible text as the button accessibility fallback', () => {
    const rootMenu: ActionMenu = {
      id: 'home',
      label: 'Home',
      groups: [{
        id: 'actions',
        buttons: [{
          id: 'save',
          label: mixedLabel,
          styles: { size: '1/2' },
          tap: { type: 'input', nvimInput: ':write<CR>', after: 'stay' }
        }]
      }]
    }
    const screen = render(
      <ActionPad
        enabled
        mode="NORMAL"
        onInput={jest.fn()}
        onKeyboardPress={jest.fn()}
        rootMenu={rootMenu}
      />
    )

    expect(screen.getByRole('button', { name: ' Save all' })).toBeTruthy()
    screen.rerender(
      <ActionPad
        enabled
        interactionMode="selection"
        mode="NORMAL"
        onInput={jest.fn()}
        onKeyboardPress={jest.fn()}
        rootMenu={rootMenu}
      />
    )
    expect(screen.getByRole('button', { name: 'Edit  Save all' })).toBeTruthy()
    const label = screen.getByTestId('action-pad-save-label')
    const style = StyleSheet.flatten(label.props.style)
    expect(style.marginTop).toBeUndefined()
    expect(style.lineHeight).toBeUndefined()
  })

  it('treats blank explicit accessibility labels as absent but preserves nonblank precedence', () => {
    const rootMenu: ActionMenu = {
      id: 'home',
      label: 'Home',
      groups: [{
        id: 'actions',
        buttons: [
          {
            id: 'empty',
            label: [{ text: 'Empty fallback', fontSize: 15, bold: false }],
            accessibilityLabel: '',
            styles: { size: '1/2' },
            tap: { type: 'input', nvimInput: 'empty', after: 'stay' }
          },
          {
            id: 'whitespace',
            label: [{ text: 'Whitespace fallback', fontSize: 15, bold: false }],
            accessibilityLabel: '   ',
            styles: { size: '1/2' },
            tap: { type: 'input', nvimInput: 'whitespace', after: 'stay' }
          },
          {
            id: 'explicit',
            label: [{ text: 'Visible label', fontSize: 15, bold: false }],
            accessibilityLabel: 'Human-readable name',
            styles: { size: '1/2' },
            tap: { type: 'input', nvimInput: 'explicit', after: 'stay' }
          }
        ]
      }]
    }
    const screen = render(
      <ActionPad
        enabled
        mode="NORMAL"
        onInput={jest.fn()}
        onKeyboardPress={jest.fn()}
        rootMenu={rootMenu}
      />
    )

    expect(screen.getByRole('button', { name: 'Empty fallback' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Whitespace fallback' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Human-readable name' })).toBeTruthy()
  })
})
