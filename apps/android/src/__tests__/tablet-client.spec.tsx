import { act } from 'react'
import { StyleSheet } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native'
import type { RedrawBatch } from '@codey/nvim-session'
import type { DuplexTransport } from '@codey/transport'

import { TabletClient } from '../TabletClient'
import type { MobileSession } from '../controller'
import { createRuntimeConnection } from '../runtime-connection'
import { tabletCapability } from '../tablet'

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn()
  }
}))

jest.mock('../editor/EditorCanvas', () => {
  const React = require('react')
  const { View } = require('react-native')
  return {
    EditorCanvas: ({ onLayout }: { onLayout: unknown }) =>
      React.createElement(View, { onLayout, testID: 'mock-editor-canvas' })
  }
})

jest.mock('../native/CodeyIme', () => {
  const React = require('react')
  const { View } = require('react-native')
  const focus = jest.fn(async () => undefined)
  const blur = jest.fn(async () => undefined)
  const sendKey = jest.fn()
  return {
    CodeyIme: React.forwardRef(
      (
        props: {
          onCommittedText: (text: string) => void
          onKey: (event: unknown) => void
        },
        ref: unknown
      ) => {
        React.useImperativeHandle(ref, () => ({
          focus,
          blur,
          sendKey: async (event: unknown) => {
            sendKey(event)
            props.onKey(event)
          }
        }))
        return React.createElement(View, {
          onCommittedText: props.onCommittedText,
          onKey: props.onKey,
          testID: 'mock-codey-ime'
        })
      }
    ),
    __focus: focus,
    __blur: blur,
    __sendKey: sendKey
  }
})

jest.mock('../runtime-connection', () => ({
  createRuntimeConnection: jest.fn()
}))

const mockedConnectionFactory = jest.mocked(createRuntimeConnection)
const getItem = jest.mocked(AsyncStorage.getItem)

interface ConnectionDouble {
  readonly transport: DuplexTransport
  readonly session: MobileSession
  redraw(batch: RedrawBatch): void
}

function connectionDouble(connectError?: Error): ConnectionDouble {
  let redrawListener: ((batch: RedrawBatch) => void) | undefined
  const session = {
    connect: jest.fn(async (): Promise<void> => {
      if (connectError !== undefined) throw connectError
    }),
    attach: jest.fn(async (_width: number, _height: number): Promise<void> => undefined),
    input: jest.fn(async (_keys: string): Promise<void> => undefined),
    resize: jest.fn(async (_width: number, _height: number): Promise<void> => undefined),
    onRedraw: jest.fn((listener: (batch: RedrawBatch) => void) => {
      redrawListener = listener
      return jest.fn()
    }),
    close: jest.fn(async (): Promise<void> => undefined)
  } satisfies MobileSession
  const transport = {
    connect: jest.fn(async (): Promise<void> => undefined),
    write: jest.fn(async (_data: Uint8Array): Promise<void> => undefined),
    onData: jest.fn((_listener: (chunk: Uint8Array) => void) => jest.fn()),
    onClose: jest.fn((_listener: (error?: Error) => void) => jest.fn()),
    close: jest.fn(async (): Promise<void> => undefined)
  } satisfies DuplexTransport
  return {
    transport,
    session,
    redraw(batch) {
      redrawListener?.(batch)
    }
  }
}

afterEach(cleanup)

beforeEach(() => {
  getItem.mockResolvedValue(null)
  mockedConnectionFactory.mockReset()
  const nativeIme = jest.requireMock('../native/CodeyIme') as {
    __focus: jest.Mock
    __blur: jest.Mock
    __sendKey: jest.Mock
  }
  nativeIme.__focus.mockClear()
  nativeIme.__blur.mockClear()
  nativeIme.__sendKey.mockClear()
})

describe('tablet client shell', () => {
  it('uses keyboard-aware expanded and condensed tablet layouts', () => {
    const expanded = render(
      <TabletClient capability={tabletCapability(1_280, 800)} />
    )
    const expandedStyle = StyleSheet.flatten(expanded.getByTestId('tablet-client-screen').props.style)
    expect(expandedStyle.paddingHorizontal).toBe(16)
    expanded.unmount()

    const condensed = render(
      <TabletClient capability={tabletCapability(800, 600)} />
    )
    const condensedStyle = StyleSheet.flatten(condensed.getByTestId('tablet-client-screen').props.style)
    expect(condensedStyle.paddingHorizontal).toBe(8)
    expect(mockedConnectionFactory).not.toHaveBeenCalled()
  })

  it('connects at measured grid size, focuses IME, displays flushed mode, and applies Ctrl once', async () => {
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(
      <TabletClient capability={tabletCapability(1_280, 800)} />
    )

    fireEvent(screen.getByTestId('mock-editor-canvas'), 'layout', {
      nativeEvent: { layout: { width: 1_000, height: 440, x: 0, y: 0 } }
    })
    expect(screen.getByText('100 × 20 · 1280 × 800dp')).toBeTruthy()

    fireEvent.press(screen.getByText('Connect'))
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())
    expect(double.session.attach).toHaveBeenCalledWith(100, 20)

    act(() => {
      double.redraw([
        ['mode_change', ['insert', 0]],
        ['flush', []]
      ])
    })
    expect(screen.getByText('INSERT')).toBeTruthy()

    fireEvent.press(screen.getByLabelText('Neovim editor'))
    const nativeIme = jest.requireMock('../native/CodeyIme') as { __focus: jest.Mock }
    expect(nativeIme.__focus).toHaveBeenCalledTimes(1)

    fireEvent.press(screen.getByText('Ctrl'))
    act(() => {
      const ime = screen.getByTestId('mock-codey-ime')
      ime.props.onCommittedText('c')
      ime.props.onCommittedText('x')
    })
    await waitFor(() => {
      expect(double.session.input).toHaveBeenNthCalledWith(1, '<C-c>')
      expect(double.session.input).toHaveBeenNthCalledWith(2, 'x')
    })

    fireEvent.press(screen.getByText('Esc'))
    const imeWithKey = jest.requireMock('../native/CodeyIme') as { __sendKey: jest.Mock }
    await waitFor(() => {
      expect(imeWithKey.__sendKey).toHaveBeenCalledWith({
        key: 'Escape',
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
        repeat: false
      })
      expect(double.session.input).toHaveBeenNthCalledWith(3, '<Esc>')
    })
  })

  it('shows connection failures and leaves reconnection explicit', async () => {
    const double = connectionDouble(new Error('connection refused'))
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(
      <TabletClient capability={tabletCapability(1_280, 800)} />
    )

    fireEvent.press(screen.getByText('Connect'))

    await waitFor(() => expect(screen.getByText('connection refused')).toBeTruthy())
    expect(screen.getByText('Connect')).toBeTruthy()
    expect(double.session.close).toHaveBeenCalledTimes(1)
    expect(mockedConnectionFactory).toHaveBeenCalledTimes(1)
  })

  it('disposes a connected session when the supported client unmounts', async () => {
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(
      <TabletClient capability={tabletCapability(1_280, 800)} />
    )

    fireEvent.press(screen.getByText('Connect'))
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())

    screen.unmount()

    await waitFor(() => expect(double.session.close).toHaveBeenCalledTimes(1))
  })
})
