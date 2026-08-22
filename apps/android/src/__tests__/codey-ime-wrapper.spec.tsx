import { act, createRef } from 'react'
import { fireEvent, render } from '@testing-library/react-native'

import {
  CodeyIme,
  type CodeyImeHandle,
  type CodeyImeKeyEvent
} from '../native/CodeyIme'

jest.mock('expo', () => {
  const React = require('react')
  const { View } = require('react-native')
  const focusIme = jest.fn(async () => undefined)
  const blurIme = jest.fn(async () => undefined)
  const sendImeKey = jest.fn(async () => undefined)
  const NativeIme = React.forwardRef(
    (props: Record<string, unknown>, ref: unknown) => {
      React.useImperativeHandle(ref, () => ({ focusIme, blurIme, sendImeKey }))
      return React.createElement(View, { ...props, testID: 'native-ime-view' })
    }
  )
  return {
    requireNativeView: jest.fn(() => NativeIme),
    __imeNativeCalls: { focusIme, blurIme, sendImeKey }
  }
})

it('bridges the public IME handle to the exact private Expo view command names', async () => {
  const ref = createRef<CodeyImeHandle>()
  const onCommittedText = jest.fn()
  const onKey = jest.fn()
  const screen = render(
    <CodeyIme ref={ref} onCommittedText={onCommittedText} onKey={onKey} />
  )
  const nativeCalls = (jest.requireMock('expo') as {
    __imeNativeCalls: {
      focusIme: jest.Mock
      blurIme: jest.Mock
      sendImeKey: jest.Mock
    }
  }).__imeNativeCalls
  const key: CodeyImeKeyEvent = {
    key: 'Escape',
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    repeat: false
  }

  await act(async () => {
    await ref.current?.focus()
    await ref.current?.blur()
    await ref.current?.sendKey(key)
  })

  expect(nativeCalls.focusIme).toHaveBeenCalledTimes(1)
  expect(nativeCalls.blurIme).toHaveBeenCalledTimes(1)
  expect(nativeCalls.sendImeKey).toHaveBeenCalledWith(
    'Escape',
    false,
    false,
    false,
    false,
    false
  )

  fireEvent(screen.getByTestId('native-ime-view'), 'committedText', {
    nativeEvent: { text: '✓' }
  })
  fireEvent(screen.getByTestId('native-ime-view'), 'key', { nativeEvent: key })
  expect(onCommittedText).toHaveBeenCalledWith('✓')
  expect(onKey).toHaveBeenCalledWith(key)
})
