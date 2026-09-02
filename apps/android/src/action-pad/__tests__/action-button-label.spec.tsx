import { StyleSheet, Text } from 'react-native'
import { cleanup, fireEvent, render } from '@testing-library/react-native'

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
  { text: 'Save', fontSize: 15, bold: true, color: '#9ece6a' },
  { text: ' all', fontSize: 12, bold: false, color: '#e0af' }
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

  it('passes ordered runs with independent font sizes and concrete faces to Android', () => {
    const screen = render(
      <ActionButtonLabel fontFacesLoaded label={mixedLabel} testID="label" />
    )

    const native = screen.getByTestId('label', { includeHiddenElements: true })
    expect(native.props.runs).toEqual([
      { text: ' ', color: '#c0caf5', fontFamily: CODEY_NERD_FONT_FAMILIES.regular, fontSize: 22, fontWeight: 400 },
      { text: 'Save', color: '#9ece6a', fontFamily: CODEY_NERD_FONT_FAMILIES.bold, fontSize: 15, fontWeight: 700 },
      { text: ' all', color: '#c0caf5', fontFamily: CODEY_NERD_FONT_FAMILIES.regular, fontSize: 12, fontWeight: 400 }
    ])
    expect(native.props).toMatchObject({
      color: '#c0caf5',
      defaultFontSize: 15,
      defaultFontFamily: CODEY_NERD_FONT_FAMILIES.regular
    })
    expect(StyleSheet.flatten(native.props.style)).toEqual({ flex: 1, alignSelf: 'stretch' })
  })

  it.each([false, true])('resolves all preset sizes and system fallbacks (compact: %s)', (compact) => {
    const label: ActionButtonLabelValue = [
      { text: 'a', fontSize: 10, bold: false },
      { text: 'b', fontSize: 12, bold: true },
      { text: 'c', fontSize: 15, bold: false },
      { text: 'd', fontSize: 18, bold: true },
      { text: 'e', fontSize: 22, bold: false }
    ]
    const screen = render(
      <ActionButtonLabel compact={compact} fontFacesLoaded={false} label={label} testID="label" />
    )

    const native = screen.getByTestId('label', { includeHiddenElements: true })
    expect(native.props.runs).toEqual([
      { text: 'a', color: '#c0caf5', fontSize: compact ? 9 : 10, fontWeight: 400 },
      { text: 'b', color: '#c0caf5', fontSize: compact ? 10 : 12, fontWeight: 700 },
      { text: 'c', color: '#c0caf5', fontSize: compact ? 13 : 15, fontWeight: 400 },
      { text: 'd', color: '#c0caf5', fontSize: compact ? 16 : 18, fontWeight: 700 },
      { text: 'e', color: '#c0caf5', fontSize: compact ? 19 : 22, fontWeight: 400 }
    ])
    expect(native.props.defaultFontFamily).toBeUndefined()
    expect(native.props.defaultFontSize).toBe(compact ? 13 : 15)
  })

  it('uses native rendering for single and empty draft runs, but keeps scalars on Text', () => {
    const screen = render(
      <ActionButtonLabel fontFacesLoaded label="Legacy" testID="label" />
    )
    expect(screen.UNSAFE_getAllByType(Text)).toHaveLength(1)
    expect(screen.getByTestId('label').props.numberOfLines).toBe(2)

    screen.rerender(
      <ActionButtonLabel fontFacesLoaded label={[{ text: 'Legacy', fontSize: 15, bold: false }]} testID="label" />
    )
    const native = () => screen.getByTestId('label', { includeHiddenElements: true })
    expect(native().props.runs).toEqual([
      { text: 'Legacy', color: '#c0caf5', fontSize: 15, fontFamily: CODEY_NERD_FONT_FAMILIES.regular, fontWeight: 400 }
    ])
    expect(native().props.numberOfLines).toBeUndefined()
    screen.rerender(
      <ActionButtonLabel fontFacesLoaded label={[{ text: '', fontSize: 15, bold: false }]} testID="label" />
    )
    expect(native().props.runs[0].text).toBe('')
  })

  it('refreshes native fonts after loading or failure without changing run text or order', () => {
    const screen = render(
      <ActionButtonLabel fontFacesLoaded={false} label={mixedLabel} testID="label" />
    )
    const native = () => screen.getByTestId('label', { includeHiddenElements: true })
    expect(native().props.runs.map((run: { fontFamily?: string }) => run.fontFamily)).toEqual([
      undefined, undefined, undefined
    ])
    screen.rerender(<ActionButtonLabel fontFacesLoaded label={mixedLabel} testID="label" />)
    expect(native().props.runs.map((run: { fontFamily?: string }) => run.fontFamily)).toEqual([
      CODEY_NERD_FONT_FAMILIES.regular, CODEY_NERD_FONT_FAMILIES.bold, CODEY_NERD_FONT_FAMILIES.regular
    ])
    screen.rerender(<ActionButtonLabel fontFacesLoaded={false} label={mixedLabel} testID="label" />)
    expect(native().props.runs.map((run: { fontFamily?: string }) => run.fontFamily)).toEqual([
      undefined, undefined, undefined
    ])
    expect(native().props.runs.map((run: { text: string }) => run.text)).toEqual([' ', 'Save', ' all'])
  })

  it.each([false, true])('fills Half/Quarter buttons without changing gestures or selection metrics (compact: %s)', (compact) => {
    const rootMenu: ActionMenu = {
      id: 'home', label: 'Home', groups: [{
        id: 'actions', buttons: [
          {
            id: 'half', label: mixedLabel, accessibilityLabel: 'Half', styles: { size: '1/2' },
            tap: { type: 'input', nvimInput: 'tap-half', after: 'stay' },
            longPress: { type: 'input', nvimInput: 'hold-half', after: 'stay' }
          },
          {
            id: 'quarter', label: mixedLabel, accessibilityLabel: 'Quarter', styles: { size: '1/4' },
            tap: { type: 'input', nvimInput: 'tap-quarter', after: 'stay' },
            longPress: { type: 'input', nvimInput: 'hold-quarter', after: 'stay' }
          }
        ]
      }]
    }
    const onInput = jest.fn()
    const onEditButton = jest.fn()
    const padProps = { rootMenu, compact, enabled: true, onInput, onEditButton, onKeyboardPress: jest.fn() }
    const screen = render(<ActionPad {...padProps} />)

    for (const [id, name, width] of [['half', 'Half', '48%'], ['quarter', 'Quarter', '22%']] as const) {
      const button = screen.getByRole('button', { name })
      expect(StyleSheet.flatten(button.props.style)).toMatchObject({ width, height: compact ? 48 : 52 })
      const label = screen.getByTestId(`action-pad-${id}-label`, { includeHiddenElements: true })
      expect(StyleSheet.flatten(label.props.style)).toEqual({ flex: 1, alignSelf: 'stretch' })
      expect(label.props.runs[0].fontSize).toBe(compact ? 19 : 22)
      fireEvent(button, 'pressIn')
      fireEvent.press(button)
      fireEvent(button, 'pressIn')
      fireEvent(button, 'longPress')
      fireEvent.press(button)
    }
    expect(onInput.mock.calls).toEqual([['tap-half'], ['hold-half'], ['tap-quarter'], ['hold-quarter']])

    screen.rerender(<ActionPad {...padProps} interactionMode="selection" />)
    for (const [id, name, width] of [['half', 'Half', '48%'], ['quarter', 'Quarter', '22%']] as const) {
      const button = screen.getByRole('button', { name: `Edit ${name}` })
      expect(StyleSheet.flatten(button.props.style)).toMatchObject({ width, height: compact ? 48 : 52 })
      const label = screen.getByTestId(`action-pad-${id}-label`, { includeHiddenElements: true })
      expect(StyleSheet.flatten(label.props.style)).toEqual({ flex: 1, alignSelf: 'stretch' })
      const indicator = screen.getByTestId(`action-pad-${id}-edit-indicator`, { includeHiddenElements: true })
      expect(StyleSheet.flatten(indicator.props.style).position).toBe('absolute')
      fireEvent(button, 'pressIn')
      fireEvent.press(button)
    }
    expect(onInput).toHaveBeenCalledTimes(4)
    expect(onEditButton.mock.calls).toEqual([
      [{ menuId: 'home', groupId: 'actions', buttonId: 'half' }],
      [{ menuId: 'home', groupId: 'actions', buttonId: 'quarter' }]
    ])
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
        onInput={jest.fn()}
        onKeyboardPress={jest.fn()}
        rootMenu={rootMenu}
      />
    )
    expect(screen.getByRole('button', { name: 'Edit  Save all' })).toBeTruthy()
    const label = screen.getByTestId('action-pad-save-label', { includeHiddenElements: true })
    const style = StyleSheet.flatten(label.props.style)
    expect(style.marginTop).toBeUndefined()
    expect(style.lineHeight).toBeUndefined()
    expect(screen.getAllByRole('button', { name: 'Edit  Save all' })).toHaveLength(1)
    expect(label.props).toMatchObject({
      accessible: false,
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
      pointerEvents: 'none'
    })
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
