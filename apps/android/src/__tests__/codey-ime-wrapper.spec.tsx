import { act, createRef } from 'react'
import { fireEvent, render } from '@testing-library/react-native'

import {
  CodeyIme,
  type CodeyImeHandle,
  type CodeyImeKeyEvent,
  type CodeyImeOrderedInputEvent
} from '../native/CodeyIme'

jest.mock('expo', () => {
  const React = require('react')
  const { View } = require('react-native')
  const focusIme = jest.fn(async () => undefined)
  const blurIme = jest.fn(async () => undefined)
  const sendOrderedInput = jest.fn(async () => undefined)
  const settleComposition = jest.fn(async () => undefined)
  const NativeIme = React.forwardRef(
    (props: Record<string, unknown>, ref: unknown) => {
      React.useImperativeHandle(ref, () => ({
        focusIme,
        blurIme,
        sendOrderedInput,
        settleComposition
      }))
      return React.createElement(View, { ...props, testID: 'native-ime-view' })
    }
  )
  return {
    requireNativeView: jest.fn(() => NativeIme),
    __imeNativeCalls: { focusIme, blurIme, sendOrderedInput, settleComposition }
  }
})

it('bridges the public IME handle to the exact private Expo view command names', async () => {
  const ref = createRef<CodeyImeHandle>()
  const onCommittedText = jest.fn()
  const onKey = jest.fn()
  const onOrderedInput = jest.fn()
  const screen = render(
    <CodeyIme
      ref={ref}
      onCommittedText={onCommittedText}
      onKey={onKey}
      onOrderedInput={onOrderedInput}
    />
  )
  const nativeCalls = (jest.requireMock('expo') as {
    __imeNativeCalls: {
      focusIme: jest.Mock
      blurIme: jest.Mock
      sendOrderedInput: jest.Mock
      settleComposition: jest.Mock
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
    await ref.current?.sendOrderedInput('<Space>sg')
    await ref.current?.settleComposition()
  })

  expect(nativeCalls.focusIme).toHaveBeenCalledTimes(1)
  expect(nativeCalls.blurIme).toHaveBeenCalledTimes(1)
  expect(nativeCalls.sendOrderedInput).toHaveBeenCalledWith('<Space>sg')
  expect(nativeCalls.settleComposition).toHaveBeenCalledTimes(1)
  expect(screen.getByTestId('native-ime-view').props.inputMode).toBe('terminal')

  fireEvent(screen.getByTestId('native-ime-view'), 'committedText', {
    nativeEvent: {
      text: '✓',
      sequence: 1,
      receivedAtUptimeMs: 10,
      connectionGeneration: 2
    }
  })
  fireEvent(screen.getByTestId('native-ime-view'), 'key', { nativeEvent: key })
  const ordered: CodeyImeOrderedInputEvent = {
    sequence: 2,
    receivedAtUptimeMs: 11,
    nativeDurationMs: 0.2,
    connectionGeneration: 2,
    compositionDrained: true,
    segments: [
      { type: 'text', text: 'ready' },
      { type: 'input', keys: '<Esc>' }
    ]
  }
  fireEvent(screen.getByTestId('native-ime-view'), 'orderedInput', { nativeEvent: ordered })
  expect(onCommittedText).toHaveBeenCalledWith('✓', {
    sequence: 1,
    receivedAtUptimeMs: 10,
    connectionGeneration: 2
  })
  expect(onKey).toHaveBeenCalledWith(key)
  expect(onOrderedInput).toHaveBeenCalledWith(ordered)

  screen.rerender(
    <CodeyIme
      ref={ref}
      inputMode="composed"
      onCommittedText={onCommittedText}
      onKey={onKey}
      onOrderedInput={onOrderedInput}
    />
  )
  expect(screen.getByTestId('native-ime-view').props.inputMode).toBe('composed')
})
