import { act } from 'react'
import { StyleSheet } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native'
import type { RedrawBatch } from '@codey/nvim-session'
import {
  clearPerformanceRecords,
  configurePerformanceDiagnostics,
  getPerformanceRecords
} from '@codey/perf'
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
    EditorCanvas: ({
      onLayout,
      performanceSamples
    }: {
      onLayout: unknown
      performanceSamples: readonly unknown[]
    }) => React.createElement(View, {
      onLayout,
      performanceSamples,
      testID: 'mock-editor-canvas'
    })
  }
})

jest.mock('../native/CodeyIme', () => {
  const React = require('react')
  const { View } = require('react-native')
  const focus = jest.fn(async () => undefined)
  const blur = jest.fn(async () => undefined)
  const sendOrderedInput = jest.fn()
  let orderedPrefix: unknown[] = []
  let sequence = 1
  return {
    CodeyIme: React.forwardRef(
      (
        props: {
          onCommittedText: (text: string) => void
          onKey: (event: unknown) => void
          onOrderedInput: (event: unknown) => void
        },
        ref: unknown
      ) => {
        React.useImperativeHandle(ref, () => ({
          focus,
          blur,
          sendOrderedInput: async (keys: string) => {
            sendOrderedInput(keys)
            const prefix = orderedPrefix
            orderedPrefix = []
            props.onOrderedInput({
              sequence: sequence++,
              receivedAtUptimeMs: 10,
              nativeDurationMs: 0.1,
              connectionGeneration: 1,
              compositionDrained: prefix.length > 0,
              segments: [...prefix, { type: 'input', keys }]
            })
          }
        }))
        return React.createElement(View, {
          onCommittedText: props.onCommittedText,
          onKey: props.onKey,
          onOrderedInput: props.onOrderedInput,
          testID: 'mock-codey-ime'
        })
      }
    ),
    __focus: focus,
    __blur: blur,
    __sendOrderedInput: sendOrderedInput,
    __setOrderedPrefix: (segments: unknown[]) => {
      orderedPrefix = segments
    }
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

afterEach(() => {
  cleanup()
  configurePerformanceDiagnostics({ enabled: false })
  clearPerformanceRecords()
})

beforeEach(() => {
  getItem.mockResolvedValue(null)
  mockedConnectionFactory.mockReset()
  const nativeIme = jest.requireMock('../native/CodeyIme') as {
    __focus: jest.Mock
    __blur: jest.Mock
    __sendOrderedInput: jest.Mock
    __setOrderedPrefix: (segments: unknown[]) => void
  }
  nativeIme.__focus.mockClear()
  nativeIme.__blur.mockClear()
  nativeIme.__sendOrderedInput.mockClear()
  nativeIme.__setOrderedPrefix([])
})

describe('tablet client shell', () => {
  it('keeps portrait and square workspaces stacked while using a flowing landscape rail', () => {
    const portrait = render(
      <TabletClient capability={tabletCapability(800, 1_280)} />
    )
    expect(StyleSheet.flatten(portrait.getByTestId('tablet-client-screen').props.style).paddingHorizontal).toBe(8)
    expect(StyleSheet.flatten(portrait.getByTestId('tablet-client-workspace').props.style)).toMatchObject({
      flexDirection: 'column'
    })
    expect(StyleSheet.flatten(portrait.getByTestId('action-pad-container').props.style).width).toBeUndefined()
    expect(StyleSheet.flatten(portrait.getByTestId('action-pad').props.style).minHeight).toBe(213)
    portrait.unmount()

    const square = render(
      <TabletClient capability={tabletCapability(840, 840)} />
    )
    expect(StyleSheet.flatten(square.getByTestId('tablet-client-screen').props.style).paddingHorizontal).toBe(16)
    expect(StyleSheet.flatten(square.getByTestId('tablet-client-workspace').props.style).flexDirection).toBe('column')
    square.unmount()

    const landscape = render(
      <TabletClient capability={tabletCapability(1_280, 800)} />
    )
    expect(StyleSheet.flatten(landscape.getByTestId('tablet-client-workspace').props.style)).toMatchObject({
      flexDirection: 'row'
    })
    expect(StyleSheet.flatten(landscape.getByTestId('action-pad-container').props.style).width).toBe(336)
    expect(StyleSheet.flatten(landscape.getByTestId('action-pad').props.style)).toMatchObject({
      flex: 1,
      minHeight: 0,
      padding: 24,
      borderTopWidth: 0,
      borderLeftWidth: 2
    })
    expect(StyleSheet.flatten(landscape.getByTestId('action-pad-flow').props.style)).toMatchObject({
      flexDirection: 'row',
      flexWrap: 'wrap',
      rowGap: 12
    })
    expect(StyleSheet.flatten(landscape.getByTestId('action-pad-escape').props.style)).toMatchObject({
      width: '48%',
      height: 52
    })
    expect(landscape.getByTestId('action-pad-flow-scroll')).toBeTruthy()
    expect(mockedConnectionFactory).not.toHaveBeenCalled()
  })

  it('preserves two usable action rows when the software keyboard reduces portrait height', async () => {
    const screen = render(
      <TabletClient capability={tabletCapability(800, 1_280)} />
    )

    expect(StyleSheet.flatten(screen.getByTestId('action-pad').props.style).minHeight).toBe(213)
    fireEvent(screen.getByTestId('tablet-client-screen'), 'layout', {
      persist: jest.fn(),
      nativeEvent: { layout: { width: 800, height: 1_160, x: 0, y: 0 } }
    })

    await waitFor(() => {
      expect(StyleSheet.flatten(screen.getByTestId('tablet-client-screen').props.style).gap).toBe(4)
      expect(StyleSheet.flatten(screen.getByTestId('action-pad').props.style).minHeight).toBe(144)
    })
    expect(StyleSheet.flatten(screen.getByLabelText('Neovim editor').props.style).minHeight).toBe(48)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-row-1').props.style).height).toBe(48)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-row-2').props.style).height).toBe(48)
  })

  it('applies keyboard compaction to the landscape shell while retaining rail controls', async () => {
    const screen = render(
      <TabletClient capability={tabletCapability(1_280, 800)} />
    )

    expect(StyleSheet.flatten(screen.getByTestId('action-pad-escape').props.style).height).toBe(52)
    expect(StyleSheet.flatten(screen.getByTestId('tablet-client-screen').props.style).gap).toBe(8)
    fireEvent(screen.getByTestId('tablet-client-screen'), 'layout', {
      persist: jest.fn(),
      nativeEvent: { layout: { width: 1_280, height: 680, x: 0, y: 0 } }
    })

    await waitFor(() => {
      expect(StyleSheet.flatten(screen.getByTestId('tablet-client-screen').props.style).gap).toBe(4)
      expect(StyleSheet.flatten(screen.getByLabelText('Neovim editor').props.style).minHeight).toBe(48)
      expect(StyleSheet.flatten(screen.getByTestId('action-pad').props.style).padding).toBe(8)
    })
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-flow').props.style).rowGap).toBe(6)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-escape').props.style)).toMatchObject({
      width: '48%',
      height: 48
    })
  })

  it('does not reuse a stale keyboard height measurement after orientation changes', async () => {
    const screen = render(
      <TabletClient capability={tabletCapability(1_280, 800)} />
    )
    fireEvent(screen.getByTestId('tablet-client-screen'), 'layout', {
      persist: jest.fn(),
      nativeEvent: { layout: { width: 1_280, height: 500, x: 0, y: 0 } }
    })
    await waitFor(() => {
      expect(StyleSheet.flatten(screen.getByTestId('tablet-client-screen').props.style).gap).toBe(4)
    })

    screen.rerender(
      <TabletClient capability={tabletCapability(800, 1_280)} />
    )

    expect(StyleSheet.flatten(screen.getByTestId('tablet-client-workspace').props.style).flexDirection).toBe('column')
    expect(StyleSheet.flatten(screen.getByTestId('tablet-client-screen').props.style).gap).toBe(5)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad').props.style).minHeight).toBe(213)

    fireEvent(screen.getByTestId('tablet-client-screen'), 'layout', {
      persist: jest.fn(),
      nativeEvent: { layout: { width: 800, height: 1_160, x: 0, y: 0 } }
    })
    await waitFor(() => {
      expect(StyleSheet.flatten(screen.getByTestId('action-pad').props.style).minHeight).toBe(144)
    })
  })

  it('preserves the session, menu, and input state while resizing the editor after rotation', async () => {
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(
      <TabletClient capability={tabletCapability(800, 1_280)} />
    )

    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.changeText(screen.getByLabelText('Neovim host'), '192.168.0.42')
    fireEvent.changeText(screen.getByLabelText('Neovim port'), '7777')
    fireEvent(screen.getByTestId('mock-editor-canvas'), 'layout', {
      nativeEvent: { layout: { width: 700, height: 550, x: 0, y: 0 } }
    })
    fireEvent.press(screen.getByText('Connect'))
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())
    expect(double.session.attach).toHaveBeenCalledWith(70, 25)

    fireEvent.press(screen.getByTestId('action-pad-ctrl'))
    fireEvent.press(screen.getByTestId('action-pad-leader'))
    fireEvent.press(screen.getByTestId('action-pad-search'))
    expect(screen.getByLabelText('Current action path: Leader / Search')).toBeTruthy()

    screen.rerender(
      <TabletClient capability={tabletCapability(1_280, 800)} />
    )

    expect(StyleSheet.flatten(screen.getByTestId('tablet-client-workspace').props.style).flexDirection).toBe('row')
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-container').props.style).width).toBe(336)
    expect(screen.getByLabelText('Current action path: Leader / Search')).toBeTruthy()
    expect(screen.getByLabelText('Neovim host').props.value).toBe('192.168.0.42')
    expect(screen.getByLabelText('Neovim port').props.value).toBe('7777')
    expect(mockedConnectionFactory).toHaveBeenCalledTimes(1)
    expect(double.session.attach).toHaveBeenCalledTimes(1)
    expect(double.session.close).not.toHaveBeenCalled()

    fireEvent.press(screen.getByTestId('action-pad-back'))
    fireEvent.press(screen.getByTestId('action-pad-back'))
    expect(screen.getByTestId('action-pad-ctrl').props.accessibilityState).toEqual({
      disabled: false,
      selected: true
    })

    fireEvent(screen.getByTestId('mock-editor-canvas'), 'layout', {
      nativeEvent: { layout: { width: 900, height: 440, x: 0, y: 0 } }
    })
    await waitFor(() => {
      expect(double.session.resize).toHaveBeenCalledWith(90, 20)
    })
    expect(double.session.attach).toHaveBeenCalledTimes(1)
    expect(double.session.close).not.toHaveBeenCalled()
  })

  it('keeps one-shot Ctrl for the requested Action Pad action across IME and hardware input', async () => {
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
    await waitFor(() => expect(screen.getByText('INSERT')).toBeTruthy())

    fireEvent.press(screen.getByLabelText('Neovim editor'))
    const nativeIme = jest.requireMock('../native/CodeyIme') as { __focus: jest.Mock }
    expect(nativeIme.__focus).toHaveBeenCalledTimes(1)

    fireEvent.press(screen.getByText('Ctrl'))
    act(() => {
      const ime = screen.getByTestId('mock-codey-ime')
      ime.props.onCommittedText('c')
      ime.props.onKey({
        key: 'ArrowLeft',
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
        repeat: false,
        sequence: 1,
        receivedAtUptimeMs: 10,
        connectionGeneration: 1
      })
    })
    await waitFor(() => {
      expect(double.session.input).toHaveBeenNthCalledWith(1, 'c')
      expect(double.session.input).toHaveBeenNthCalledWith(2, '<Left>')
    })

    fireEvent.press(screen.getByText('Esc'))
    const actionIme = jest.requireMock('../native/CodeyIme') as { __sendOrderedInput: jest.Mock }
    await waitFor(() => {
      expect(actionIme.__sendOrderedInput).toHaveBeenCalledWith('<C-Esc>')
      expect(double.session.input).toHaveBeenNthCalledWith(3, '<C-Esc>')
    })

    fireEvent.press(screen.getByText('Tab'))
    await waitFor(() => {
      expect(actionIme.__sendOrderedInput).toHaveBeenLastCalledWith('<Tab>')
      expect(double.session.input).toHaveBeenNthCalledWith(4, '<Tab>')
    })
  })

  it('orders composition before a Ctrl action and enters the controller exactly once', async () => {
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(
      <TabletClient capability={tabletCapability(1_280, 800)} />
    )
    fireEvent.press(screen.getByText('Connect'))
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())

    const nativeIme = jest.requireMock('../native/CodeyIme') as {
      __sendOrderedInput: jest.Mock
      __setOrderedPrefix: (segments: unknown[]) => void
    }
    nativeIme.__setOrderedPrefix([{ type: 'text', text: 'ready' }])
    fireEvent.press(screen.getByText('Ctrl'))
    fireEvent.press(screen.getByText('Esc'))

    await waitFor(() => {
      expect(nativeIme.__sendOrderedInput).toHaveBeenCalledWith('<C-Esc>')
      expect(double.session.input).toHaveBeenCalledTimes(1)
      expect(double.session.input).toHaveBeenCalledWith('ready<C-Esc>')
    })
  })

  it('carries one sanitized input sample from native receipt to the published flush', async () => {
    configurePerformanceDiagnostics({ enabled: true, log: false, build: 'release' })
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(
      <TabletClient capability={tabletCapability(1_280, 800)} />
    )
    fireEvent.press(screen.getByText('Connect'))
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())

    act(() => {
      screen.getByTestId('mock-codey-ime').props.onCommittedText('private', {
        sequence: 9,
        receivedAtUptimeMs: 10,
        connectionGeneration: 1
      })
    })
    await waitFor(() => expect(double.session.input).toHaveBeenCalledWith('private'))
    act(() => {
      double.redraw([['flush', []]])
    })
    await waitFor(() => {
      expect(screen.getByTestId('mock-editor-canvas').props.performanceSamples).toHaveLength(1)
    })

    const records = getPerformanceRecords()
    const receipt = records.find((record) => record.stage === 'input_receipt')
    const published = screen.getByTestId('mock-editor-canvas').props.performanceSamples[0]
    expect(published).toMatchObject({
      sampleId: receipt?.tags.sampleId,
      source: 'ime',
      inputLength: 7,
      connectionGeneration: 1,
      sequence: 9,
      flushCount: 1
    })
    expect(JSON.stringify(records)).not.toContain('private')
  })

  it('drills into Leader search, sends one complete mapping, and returns to root', async () => {
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(
      <TabletClient capability={tabletCapability(1_280, 800)} />
    )

    fireEvent.press(screen.getByText('Connect'))
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())

    fireEvent.press(screen.getByTestId('action-pad-leader'))
    expect(screen.queryByText('Esc')).toBeNull()
    expect(screen.getByText('› Leader')).toBeTruthy()

    fireEvent.press(screen.getByTestId('action-pad-search'))
    expect(screen.getByText('› Leader / Search')).toBeTruthy()
    fireEvent.press(screen.getByText('Grep (Live)'))

    const nativeIme = jest.requireMock('../native/CodeyIme') as { __sendOrderedInput: jest.Mock }
    await waitFor(() => {
      expect(nativeIme.__sendOrderedInput).toHaveBeenCalledWith('<Space>sg')
      expect(double.session.input).toHaveBeenCalledWith('<Space>sg')
    })
    expect(screen.getByText('Esc')).toBeTruthy()
    expect(screen.queryByText('› Leader / Search')).toBeNull()
  })

  it('opens navigation on hold, keeps it open for repeated moves, and backs out locally', async () => {
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(
      <TabletClient capability={tabletCapability(1_280, 800)} />
    )

    fireEvent.press(screen.getByText('Connect'))
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())

    fireEvent(screen.getByTestId('action-pad-up'), 'longPress')
    expect(screen.getByText('› Up Arrow – Navigation')).toBeTruthy()
    expect(screen.getByText('gg Top')).toBeTruthy()

    fireEvent.press(screen.getByText('+5 Lines'))
    const nativeIme = jest.requireMock('../native/CodeyIme') as {
      __sendOrderedInput: jest.Mock
    }
    await waitFor(() => expect(double.session.input).toHaveBeenCalledWith('5k'))
    expect(nativeIme.__sendOrderedInput).toHaveBeenCalledWith('5k')
    expect(screen.getByText('+5 Lines')).toBeTruthy()

    fireEvent.press(screen.getByTestId('action-pad-back'))
    expect(screen.getByText('Esc')).toBeTruthy()
    expect(double.session.input).toHaveBeenCalledTimes(1)
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
