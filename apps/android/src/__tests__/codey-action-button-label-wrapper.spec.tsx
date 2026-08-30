import { StyleSheet } from 'react-native'
import { cleanup, render } from '@testing-library/react-native'

import {
  CodeyActionButtonLabel,
  type CodeyActionButtonLabelRun
} from '../native/CodeyActionButtonLabel'

jest.unmock('../native/CodeyActionButtonLabel')

jest.mock('expo', () => {
  const React = require('react')
  const { View } = require('react-native')
  return {
    requireNativeView: (moduleName: string) => (props: Record<string, unknown>) => (
      React.createElement(View, { ...props, nativeModuleName: moduleName })
    )
  }
})

afterEach(cleanup)

it('registers the exact Expo view and forwards ordered resolved runs without transforming text', () => {
  const runs: readonly CodeyActionButtonLabelRun[] = [
    { text: '\u{f01c9} ', fontSize: 22, fontFamily: 'CodeyNerdFont-Regular', fontWeight: 400 },
    { text: 'Save', fontSize: 15, fontFamily: 'CodeyNerdFont-Bold', fontWeight: 700 },
    { text: '\n all 😀', fontSize: 12, fontFamily: 'CodeyNerdFont-Regular', fontWeight: 400 },
    { text: '', fontSize: 10, fontFamily: 'CodeyNerdFont-Regular', fontWeight: 400 }
  ]
  const screen = render(
    <CodeyActionButtonLabel
      color="#c0caf5"
      defaultFontFamily="CodeyNerdFont-Regular"
      defaultFontSize={15}
      runs={runs}
      style={[{ flex: 1 }, { alignSelf: 'stretch' }]}
      testID="native-label"
    />
  )

  const view = screen.getByTestId('native-label', { includeHiddenElements: true })
  expect(view.props).toMatchObject({
    nativeModuleName: 'CodeyActionButtonLabel',
    color: '#c0caf5',
    defaultFontFamily: 'CodeyNerdFont-Regular',
    defaultFontSize: 15,
    accessible: false,
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
    pointerEvents: 'none'
  })
  expect(view.props.runs).toBe(runs)
  expect(StyleSheet.flatten(view.props.style)).toEqual({ flex: 1, alignSelf: 'stretch' })
  expect(screen.queryByTestId('native-label')).toBeNull()
  expect(view.props.onPress).toBeUndefined()
  expect(view.props.accessibilityLabel).toBeUndefined()
  expect(view.props.children).toBeUndefined()
})

it('passes system fallback weights, empty drafts and typography changes through to native', () => {
  const screen = render(
    <CodeyActionButtonLabel color="#c0caf5" defaultFontSize={13} runs={[]} testID="native-label" />
  )
  const view = () => screen.getByTestId('native-label', { includeHiddenElements: true })
  expect(view().props.runs).toEqual([])
  expect(view().props.defaultFontFamily).toBeUndefined()
  expect(view().props.defaultFontSize).toBe(13)

  const fallbackRuns: readonly CodeyActionButtonLabelRun[] = [
    { text: 'Regular ', fontSize: 9, fontWeight: 400 },
    { text: 'Bold', fontSize: 19, fontFamily: null, fontWeight: 700 }
  ]
  screen.rerender(
    <CodeyActionButtonLabel
      color="#c0caf5"
      defaultFontFamily={null}
      defaultFontSize={13}
      runs={fallbackRuns}
      testID="native-label"
    />
  )
  expect(view().props.runs).toBe(fallbackRuns)
  expect(view().props.defaultFontFamily).toBeNull()

  const loadedRuns = fallbackRuns.map((run) => ({
    ...run,
    fontFamily: run.fontWeight === 700 ? 'CodeyNerdFont-Bold' : 'CodeyNerdFont-Regular'
  }))
  screen.rerender(
    <CodeyActionButtonLabel
      color="#c0caf5"
      defaultFontFamily="CodeyNerdFont-Regular"
      defaultFontSize={15}
      runs={loadedRuns}
      style={{ width: 120, height: 50 }}
      testID="native-label"
    />
  )
  expect(view().props.runs).toBe(loadedRuns)
  expect(view().props.defaultFontSize).toBe(15)
  expect(view().props.defaultFontFamily).toBe('CodeyNerdFont-Regular')
  expect(view().props.style).toEqual({ width: 120, height: 50 })
})
