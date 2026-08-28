import { act } from 'react'
import { Alert, BackHandler, StyleSheet } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react-native'
import type { HostDocument, HostDocumentWrite, RedrawBatch } from '@codey/nvim-session'
import {
  clearPerformanceRecords,
  configurePerformanceDiagnostics,
  getPerformanceRecords
} from '@codey/perf'
import type { DuplexTransport } from '@codey/transport'

import { TabletClient } from '../TabletClient'
import { DEFAULT_ACTION_PAD_CONFIG } from '../action-pad/config'
import { parseActionPadConfig, serializeActionPadConfig, type ActionPadConfig } from '../action-pad/document'
import { actionPadStorageKey } from '../action-pad/store'
import type { MobileSession } from '../controller'
import { createRuntimeConnection } from '../runtime-connection'
import { DEFAULT_ENDPOINT } from '../endpoint'
import { tabletCapability } from '../tablet'

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn()
  }
}))

jest.mock('../fonts', () => ({
  CODEY_NERD_FONT_FAMILIES: {
    regular: 'CodeyNerdFont-Regular',
    semiBold: 'CodeyNerdFont-SemiBold',
    bold: 'CodeyNerdFont-Bold',
    italic: 'CodeyNerdFont-Italic',
    boldItalic: 'CodeyNerdFont-BoldItalic'
  },
  useCodeyNerdFontFaces: jest.fn(() => [true, null])
}))

jest.mock('../editor/EditorCanvas', () => {
  const React = require('react')
  const { View } = require('react-native')
  return {
    EditorCanvas: ({
      onLayout,
      onCellPress,
      performanceSamples
    }: {
      onLayout: unknown
      onCellPress?: (position: { readonly row: number; readonly column: number }) => void
      performanceSamples: readonly unknown[]
    }) => React.createElement(View, {
      accessibilityLabel: 'Neovim editor',
      onCellPress,
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
  const settleComposition = jest.fn()
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
          },
          settleComposition: async () => {
            settleComposition()
            const prefix = orderedPrefix
            orderedPrefix = []
            props.onOrderedInput({
              sequence: sequence++,
              receivedAtUptimeMs: 10,
              nativeDurationMs: 0.1,
              connectionGeneration: 1,
              compositionDrained: prefix.length > 0,
              segments: prefix
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
    __settleComposition: settleComposition,
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
    inputMouse: jest.fn(async (): Promise<void> => undefined),
    resize: jest.fn(async (_width: number, _height: number): Promise<void> => undefined),
    defaultActionPadPath: jest.fn(async () => '/home/test/.config/nvim/codey/action-pad.yaml'),
    readHostDocument: jest.fn(async (path: string): Promise<HostDocument> => ({ path, resolvedPath: path, text: null, revision: null })),
    writeHostDocument: jest.fn(async (request: HostDocumentWrite): Promise<HostDocument> => ({
      path: request.path, resolvedPath: request.path, text: request.text, revision: 'saved'
    })),
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

function recoveryRecord(config: ActionPadConfig): string {
  return JSON.stringify({
    version: 1,
    sourcePath: '/home/test/action-pad.yaml',
    activeConfig: config,
    draft: null,
    idDrafts: {},
    baseline: null,
    pendingSave: null
  })
}

afterEach(async () => {
  await act(async () => { await Promise.resolve() })
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
    __settleComposition: jest.Mock
    __setOrderedPrefix: (segments: unknown[]) => void
  }
  nativeIme.__focus.mockClear()
  nativeIme.__blur.mockClear()
  nativeIme.__sendOrderedInput.mockClear()
  nativeIme.__settleComposition.mockClear()
  nativeIme.__setOrderedPrefix([])
})

describe('tablet client shell', () => {
  it('does not replace a newly connected host when stored endpoint loading finishes late', async () => {
    let restoreEndpoint!: (value: string) => void
    const pending = new Promise<string>((resolve) => { restoreEndpoint = resolve })
    getItem.mockImplementation((key) => key === 'codey.android.endpoint.v1' ? pending : Promise.resolve(null))
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    await act(async () => { fireEvent.press(screen.getByText('Connect')) })
    expect(mockedConnectionFactory).toHaveBeenCalledWith(DEFAULT_ENDPOINT)
    await act(async () => { restoreEndpoint(JSON.stringify({ host: 'previous.test', port: 7777 })) })
    expect(screen.getByLabelText('Neovim host').props.value).toBe(DEFAULT_ENDPOINT.host)
    await act(async () => { fireEvent(screen.getByRole('button', { name: 'Edit Action Pad' }), 'longPress') })
    const editor = within(screen.getByTestId('action-pad-editor'))
    expect(editor.getByLabelText('Host YAML path').props.value).toBe('/home/test/.config/nvim/codey/action-pad.yaml')
    expect(editor.getByTestId('action-pad-editor-save').props.accessibilityState.disabled).toBe(false)
  })

  it('waits for cold-start recovery before mounting the editor with unfinished ID text', async () => {
    const endpoint = { host: 'recovery.test', port: 6666 }
    let restoreEndpoint!: (value: string) => void
    let restoreConfig!: (value: string) => void
    const endpointRead = new Promise<string>((resolve) => { restoreEndpoint = resolve })
    const configRead = new Promise<string>((resolve) => { restoreConfig = resolve })
    getItem.mockImplementation((key) => key === actionPadStorageKey(endpoint) ? configRead : endpointRead)
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    fireEvent(screen.getByRole('button', { name: 'Edit Action Pad' }), 'longPress')
    expect(screen.queryByTestId('action-pad-editor')).toBeNull()
    await act(async () => { restoreEndpoint(JSON.stringify(endpoint)) })
    expect(getItem).toHaveBeenCalledWith(actionPadStorageKey(endpoint))
    expect(screen.queryByTestId('action-pad-editor')).toBeNull()
    await act(async () => {
      restoreConfig(JSON.stringify({
        version: 1,
        sourcePath: '/home/test/action-pad.yaml',
        activeConfig: DEFAULT_ACTION_PAD_CONFIG,
        draft: DEFAULT_ACTION_PAD_CONFIG,
        idDrafts: { 'menus[0].groups[0].buttons[0].id': '' },
        baseline: null,
        pendingSave: null
      }))
    })
    const editor = within(screen.getByTestId('action-pad-editor'))
    expect(editor.getByLabelText('Button ID').props.value).toBe('')
    expect(editor.getByTestId('action-pad-editor-save').props.accessibilityState.disabled).toBe(true)
    expect(screen.getByText('Edit Action Pad · unsaved')).toBeTruthy()
  })

  it('selects an offline button without running its action or opening the Neovim keyboard', async () => {
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    await act(async () => { await Promise.resolve() })
    fireEvent.press(screen.getByRole('button', { name: 'Edit Action Pad' }))
    expect(screen.queryByTestId('action-pad-editor')).toBeNull()
    expect(screen.getByRole('button', { name: 'Done editing' }).props.accessibilityState.selected).toBe(true)
    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Edit Enter' })) })
    const editor = within(screen.getByTestId('action-pad-editor'))
    expect(editor.getByLabelText('Button ID').props.value).toBe('enter')
    expect(editor.getByLabelText('Tap Neovim input').props.value).toBe('<CR>')
    expect(editor.getByTestId('action-pad-editor-save').props.accessibilityState.disabled).toBe(true)
    const nativeIme = jest.requireMock('../native/CodeyIme') as { __sendOrderedInput: jest.Mock; __focus: jest.Mock }
    expect(nativeIme.__sendOrderedInput).not.toHaveBeenCalled()
    expect(nativeIme.__focus).not.toHaveBeenCalled()
    expect(mockedConnectionFactory).not.toHaveBeenCalled()
    fireEvent.press(editor.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Done editing' })).toBeTruthy()
    fireEvent.press(screen.getByRole('button', { name: 'Done editing' }))
    expect(screen.getByRole('button', { name: 'Edit Action Pad' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Enter' }).props.accessibilityState.disabled).toBe(true)
  })

  it('returns to the selected submenu through editor entry, closing and rotation', async () => {
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    await act(async () => { fireEvent.press(screen.getByText('Connect')) })
    fireEvent.press(screen.getByTestId('action-pad-leader'))
    fireEvent.press(screen.getByRole('button', { name: 'Edit Action Pad' }))
    const pad = within(screen.getByTestId('action-pad-container'))
    expect(pad.getByLabelText('Current action path: Leader')).toBeTruthy()
    await act(async () => { fireEvent.press(pad.getByRole('button', { name: 'Edit Terminal' })) })
    const editor = within(screen.getByTestId('action-pad-editor'))
    expect(editor.getByLabelText('Button ID').props.value).toBe('terminal')
    expect(editor.getByLabelText('Tap Neovim input').props.value).toBe(':terminal<CR>')
    expect(pad.getByTestId('action-pad-terminal').props.accessibilityState.disabled).toBe(true)
    fireEvent.press(pad.getByTestId('action-pad-terminal'))
    screen.rerender(<TabletClient capability={tabletCapability(800, 1_280)} />)
    expect(editor.getByLabelText('Button ID').props.value).toBe('terminal')
    fireEvent.press(editor.getByRole('button', { name: 'Cancel' }))
    expect(pad.getByLabelText('Current action path: Leader')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Done editing' })).toBeTruthy()
    expect(double.session.input).not.toHaveBeenCalled()
    fireEvent.press(screen.getByRole('button', { name: 'Done editing' }))
    fireEvent.press(pad.getByTestId('action-pad-terminal'))
    await waitFor(() => expect(double.session.input).toHaveBeenCalledWith(':terminal<CR>'))
    expect(pad.queryByLabelText('Current action path: Leader')).toBeNull()
    expect(double.session.attach).toHaveBeenCalledTimes(1)
    expect(double.session.close).not.toHaveBeenCalled()
  })

  it('keeps selection active but retains the existing root reset after Save', async () => {
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    await act(async () => { fireEvent.press(screen.getByText('Connect')) })
    fireEvent.press(screen.getByTestId('action-pad-leader'))
    fireEvent.press(screen.getByRole('button', { name: 'Edit Action Pad' }))
    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Edit Terminal' })) })
    const editor = within(screen.getByTestId('action-pad-editor'))
    fireEvent.changeText(editor.getByLabelText('Button label'), 'Terminal session')
    await act(async () => { fireEvent.press(editor.getByTestId('action-pad-editor-save')) })
    expect(double.session.writeHostDocument).toHaveBeenCalledTimes(1)
    expect(editor.getByLabelText('Button ID').props.value).toBe('escape')
    fireEvent.press(editor.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Done editing' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit Esc' })).toBeTruthy()
    expect(screen.queryByLabelText('Current action path: Leader')).toBeNull()
    expect(double.session.input).not.toHaveBeenCalled()
  })

  it('keeps the saved pad visible and recovers unfinished draft fields on targeted reopening', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    try {
      const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
      await act(async () => { await Promise.resolve() })
      fireEvent.press(screen.getByRole('button', { name: 'Edit Action Pad' }))
      await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Edit Esc' })) })
      const editor = within(screen.getByTestId('action-pad-editor'))
      fireEvent.changeText(editor.getByLabelText('Button label'), 'Draft escape')
      fireEvent.changeText(editor.getByLabelText('Button ID'), 'directory')
      fireEvent.press(editor.getByRole('button', { name: 'Cancel' }))
      expect(alert.mock.calls.at(-1)?.[0]).toBe('Unsaved Action Pad edits')
      act(() => { alert.mock.calls.at(-1)?.[2]?.find((button) => button.text === 'Keep draft & close')?.onPress?.() })
      expect(screen.queryByTestId('action-pad-editor')).toBeNull()
      expect(screen.getByText('Done editing · unsaved')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Edit Esc' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Edit Draft escape' })).toBeNull()
      await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Edit Esc' })) })
      const reopened = within(screen.getByTestId('action-pad-editor'))
      expect(reopened.getByLabelText('Button label').props.value).toBe('Draft escape')
      expect(reopened.getByLabelText('Button ID').props.value).toBe('directory')
      expect(reopened.getByTestId('action-pad-editor-save').props.accessibilityState.disabled).toBe(true)
      expect(mockedConnectionFactory).not.toHaveBeenCalled()
    } finally {
      alert.mockRestore()
    }
  })

  it('opens the general editor on hold without also toggling selection on release', async () => {
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    await act(async () => { await Promise.resolve() })
    const control = screen.getByRole('button', { name: 'Edit Action Pad' })
    await act(async () => {
      fireEvent(control, 'pressIn')
      fireEvent(control, 'longPress')
      fireEvent.press(control)
    })
    const editor = within(screen.getByTestId('action-pad-editor'))
    expect(editor.getByLabelText('Button ID').props.value).toBe('escape')
    fireEvent.press(editor.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Done editing' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit Action Pad' })).toBeTruthy()
  })

  it('keeps the general editor accessible without a hold and from an empty pad', async () => {
    const empty: ActionPadConfig = { version: 1, rootMenuId: 'empty', menus: [{ id: 'empty', label: 'Empty', groups: [] }] }
    getItem.mockImplementation(async (key) => key === actionPadStorageKey(DEFAULT_ENDPOINT) ? recoveryRecord(empty) : null)
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    await act(async () => { await Promise.resolve() })
    expect(within(screen.getByTestId('action-pad')).queryAllByRole('button')).toHaveLength(0)
    const control = screen.getByRole('button', { name: 'Edit Action Pad' })
    expect(control.props.accessibilityActions).toContainEqual({ name: 'openEditor', label: 'Open full Action Pad editor' })
    await act(async () => { fireEvent(control, 'accessibilityAction', { nativeEvent: { actionName: 'openEditor' } }) })
    fireEvent.press(within(screen.getByTestId('action-pad-editor')).getByRole('button', { name: 'Cancel' }))
    fireEvent.press(screen.getByRole('button', { name: 'Edit Action Pad' }))
    const done = screen.getByRole('button', { name: 'Done editing' })
    await act(async () => {
      fireEvent(done, 'pressIn')
      fireEvent(done, 'longPress')
      fireEvent.press(done)
    })
    const editor = within(screen.getByTestId('action-pad-editor'))
    expect(editor.getByTestId('action-pad-menu-form')).toBeTruthy()
    fireEvent.press(editor.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Done editing' })).toBeTruthy()
  })

  it('exits selection on Android Back without discarding a recovered draft', async () => {
    let back: Parameters<typeof BackHandler.addEventListener>[1] | undefined
    const remove = jest.fn()
    const listener = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
      back = handler
      return { remove }
    })
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    getItem.mockImplementation(async (key) => key === actionPadStorageKey(DEFAULT_ENDPOINT)
      ? JSON.stringify({ ...JSON.parse(recoveryRecord(DEFAULT_ACTION_PAD_CONFIG)), draft: DEFAULT_ACTION_PAD_CONFIG, idDrafts: { 'menus[0].groups[0].buttons[0].id': '' } })
      : null)
    try {
      const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
      await act(async () => { await Promise.resolve() })
      fireEvent.press(screen.getByRole('button', { name: 'Edit Action Pad' }))
      expect(back).toBeDefined()
      act(() => { expect(back?.({ type: 'hardwareBackPress', timeStamp: 0 })).toBe(true) })
      expect(remove).toHaveBeenCalledTimes(1)
      expect(screen.getByText('Edit Action Pad · unsaved')).toBeTruthy()
      expect(alert).not.toHaveBeenCalled()
      await act(async () => { fireEvent(screen.getByRole('button', { name: 'Edit Action Pad' }), 'longPress') })
      expect(within(screen.getByTestId('action-pad-editor')).getByLabelText('Button ID').props.value).toBe('')
    } finally {
      listener.mockRestore()
      alert.mockRestore()
    }
  })

  it.each([
    { endpoint: DEFAULT_ENDPOINT, control: 'Done editing', changed: 'configuration' },
    { endpoint: { host: 'another.test', port: 7777 }, control: 'Edit Action Pad', changed: 'endpoint' }
  ])('rejects a targeted opening when recovery changes the $changed', async ({ endpoint, control }) => {
    let finishEndpoint!: (value: string) => void
    const endpointRead = new Promise<string>((resolve) => { finishEndpoint = resolve })
    const replacement: ActionPadConfig = {
      version: 1, rootMenuId: 'home', menus: [{ id: 'home', label: 'Home', groups: [{
        id: 'leading', buttons: [{ id: 'escape', label: 'Recovered escape', tap: { type: 'input', nvimInput: '<Esc>', after: 'stay' } }]
      }] }]
    }
    getItem.mockImplementation((key) => key === 'codey.android.endpoint.v1' ? endpointRead : Promise.resolve(recoveryRecord(replacement)))
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    fireEvent.press(screen.getByRole('button', { name: 'Edit Action Pad' }))
    fireEvent.press(screen.getByRole('button', { name: 'Edit Esc' }))
    await act(async () => { finishEndpoint(JSON.stringify(endpoint)) })
    expect(screen.queryByTestId('action-pad-editor')).toBeNull()
    expect(screen.getByText('The Action Pad changed before the button editor opened. Select the button again.')).toBeTruthy()
    expect(screen.getByRole('button', { name: control })).toBeTruthy()
    expect(mockedConnectionFactory).not.toHaveBeenCalled()
  })

  it('cancels a pending targeted opening when selection mode is switched off', async () => {
    let finishEndpoint!: (value: string) => void
    const endpointRead = new Promise<string>((resolve) => { finishEndpoint = resolve })
    getItem.mockImplementation((key) => key === 'codey.android.endpoint.v1' ? endpointRead : Promise.resolve(null))
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    fireEvent.press(screen.getByRole('button', { name: 'Edit Action Pad' }))
    fireEvent.press(screen.getByRole('button', { name: 'Edit Esc' }))
    fireEvent.press(screen.getByRole('button', { name: 'Done editing' }))
    await act(async () => { finishEndpoint(JSON.stringify(DEFAULT_ENDPOINT)) })
    expect(screen.queryByTestId('action-pad-editor')).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit Action Pad' })).toBeTruthy()
  })

  it('opens the configuration editor offline and isolates every preview action from Neovim', async () => {
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    await act(async () => { await Promise.resolve() })
    fireEvent(screen.getByRole('button', { name: 'Edit Action Pad' }), 'longPress')
    await waitFor(() => expect(screen.getByTestId('action-pad-editor')).toBeTruthy())
    const editor = within(screen.getByTestId('action-pad-editor'))
    const preview = within(screen.getByTestId('action-pad-editor-preview'))
    fireEvent.changeText(editor.getByLabelText('Button label'), 'Escape now')
    expect(preview.getByText('Escape now')).toBeTruthy()
    fireEvent.press(preview.getByTestId('action-pad-escape'))
    fireEvent.press(preview.getByTestId('action-pad-keyboard'))
    const nativeIme = jest.requireMock('../native/CodeyIme') as { __sendOrderedInput: jest.Mock; __focus: jest.Mock }
    expect(nativeIme.__sendOrderedInput).not.toHaveBeenCalled()
    expect(nativeIme.__focus).not.toHaveBeenCalled()
    expect(mockedConnectionFactory).not.toHaveBeenCalled()
    expect(editor.getByTestId('action-pad-editor-save').props.accessibilityState.disabled).toBe(true)
  })

  it('keeps an offline draft when closing and can connect from inside the editor', async () => {
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    try {
      const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
      await act(async () => { await Promise.resolve() })
      fireEvent(screen.getByRole('button', { name: 'Edit Action Pad' }), 'longPress')
      await waitFor(() => expect(screen.getByTestId('action-pad-editor')).toBeTruthy())
      fireEvent.changeText(within(screen.getByTestId('action-pad-editor')).getByLabelText('Button label'), 'Offline edit')
      fireEvent.press(within(screen.getByTestId('action-pad-editor')).getByRole('button', { name: 'Cancel' }))
      const keep = alert.mock.calls.at(-1)?.[2]?.find((button) => button.text === 'Keep draft & close')
      expect(keep).toBeDefined()
      act(() => { keep?.onPress?.() })
      expect(screen.queryByTestId('action-pad-editor')).toBeNull()
      fireEvent(screen.getByRole('button', { name: 'Edit Action Pad' }), 'longPress')
      await waitFor(() => expect(screen.getByTestId('action-pad-editor')).toBeTruthy())
      expect(within(screen.getByTestId('action-pad-editor')).getByLabelText('Button label').props.value).toBe('Offline edit')
      await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Connect configuration host' })) })
      expect(mockedConnectionFactory).toHaveBeenCalledTimes(1)
      expect(double.session.connect).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Connect configuration host' })).toBeNull())
      expect(within(screen.getByTestId('action-pad-editor')).getByLabelText('Button label').props.value).toBe('Offline edit')
      expect(double.session.writeHostDocument).not.toHaveBeenCalled()
      expect(double.session.close).not.toHaveBeenCalled()
    } finally {
      alert.mockRestore()
    }
  })

  it('settles composition on entry, keeps the session mounted, and never routes form input to it', async () => {
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    await act(async () => { await Promise.resolve() })
    fireEvent.press(screen.getByText('Connect'))
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())
    const nativeIme = jest.requireMock('../native/CodeyIme') as {
      __settleComposition: jest.Mock
      __setOrderedPrefix: (segments: unknown[]) => void
    }
    nativeIme.__setOrderedPrefix([{ type: 'text', text: 'before editor' }])
    fireEvent(screen.getByRole('button', { name: 'Edit Action Pad' }), 'longPress')
    await waitFor(() => expect(screen.getByTestId('action-pad-editor')).toBeTruthy())
    expect(nativeIme.__settleComposition).toHaveBeenCalledTimes(1)
    expect(double.session.input).toHaveBeenCalledWith('before editor')
    const inputCount = jest.mocked(double.session.input).mock.calls.length
    const editor = within(screen.getByTestId('action-pad-editor'))
    fireEvent.changeText(editor.getByLabelText('Tap Neovim input'), ':write<CR>')
    fireEvent.press(within(screen.getByTestId('action-pad-editor-preview')).getByTestId('action-pad-escape'))
    // Even a delayed native callback is ignored while ordinary form fields own focus.
    fireEvent(screen.getByTestId('mock-codey-ime'), 'committedText', 'form text')
    expect(double.session.input).toHaveBeenCalledTimes(inputCount)
    expect(double.session.close).not.toHaveBeenCalled()
    expect(mockedConnectionFactory).toHaveBeenCalledTimes(1)
  })

  it('loads, edits, saves, reloads and exports through the mounted host session', async () => {
    const double = connectionDouble()
    const path = '/home/test/pad.yaml'
    const exportPath = '/home/test/pad-export.yaml'
    const config: ActionPadConfig = {
      version: 1, rootMenuId: 'home', menus: [{
        id: 'home', label: 'Home', groups: [{
          id: 'main', buttons: [{ id: 'escape', label: 'Esc', tap: { type: 'input', nvimInput: '<Esc>', after: 'root' } }]
        }]
      }]
    }
    let revision = 1
    const files = new Map<string, HostDocument>([[path, {
      path, resolvedPath: path, text: serializeActionPadConfig(config), revision: String(revision)
    }]])
    jest.mocked(double.session.readHostDocument).mockImplementation(async (filename) => files.get(filename) ?? {
      path: filename, resolvedPath: filename, text: null, revision: null
    })
    jest.mocked(double.session.writeHostDocument).mockImplementation(async (request) => {
      expect(request.expectedRevision).toBe(files.get(request.path)?.revision ?? null)
      const document = { path: request.path, resolvedPath: request.path, text: request.text, revision: String(++revision) }
      files.set(request.path, document)
      return document
    })
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(<TabletClient capability={tabletCapability(800, 1_280)} />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { fireEvent.press(screen.getByText('Connect')) })
    await act(async () => { fireEvent(screen.getByRole('button', { name: 'Edit Action Pad' }), 'longPress') })
    const editor = within(screen.getByTestId('action-pad-editor'))
    fireEvent.changeText(editor.getByLabelText('Host YAML path'), path)
    await act(async () => { fireEvent.press(editor.getByRole('button', { name: 'Load' })) })
    expect(editor.getByLabelText('Button label').props.value).toBe('Esc')
    const input = "  <Esc>:echo 'λ'<CR>\n\t "
    fireEvent.changeText(editor.getByLabelText('Button label'), '001 λ')
    fireEvent.changeText(editor.getByLabelText('Tap Neovim input'), input)
    await act(async () => { fireEvent.press(editor.getByTestId('action-pad-editor-save')) })
    expect(parseActionPadConfig(files.get(path)!.text!).menus[0]?.groups[0]?.buttons[0]).toMatchObject({
      label: '001 λ', tap: { nvimInput: input }
    })
    await act(async () => { fireEvent.press(editor.getByRole('button', { name: 'Load / Reload' })) })
    expect(editor.getByLabelText('Tap Neovim input').props.value).toBe(input)
    fireEvent.press(editor.getByRole('button', { name: 'Export copy…' }))
    fireEvent.changeText(editor.getByLabelText('Export YAML path'), exportPath)
    await act(async () => { fireEvent.press(editor.getByRole('button', { name: 'Write exported copy' })) })
    expect(files.get(exportPath)?.text).toBe(files.get(path)?.text)
    expect(editor.getByLabelText('Host YAML path').props.value).toBe(path)
    fireEvent.press(editor.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('action-pad-editor')).toBeNull()
    expect(within(screen.getByTestId('action-pad')).getByText('001 λ')).toBeTruthy()
    expect(double.session.input).not.toHaveBeenCalled()
    expect(double.session.close).not.toHaveBeenCalled()
  })

  it('keeps portrait and square workspaces stacked while grouping the landscape rail', async () => {
    const portrait = render(
      <TabletClient capability={tabletCapability(800, 1_280)} />
    )
    await act(async () => { await Promise.resolve() })
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
    await act(async () => { await Promise.resolve() })
    expect(StyleSheet.flatten(square.getByTestId('tablet-client-screen').props.style).paddingHorizontal).toBe(16)
    expect(StyleSheet.flatten(square.getByTestId('tablet-client-workspace').props.style).flexDirection).toBe('column')
    square.unmount()

    const landscape = render(
      <TabletClient capability={tabletCapability(1_280, 800)} />
    )
    await act(async () => { await Promise.resolve() })
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
    expect(StyleSheet.flatten(landscape.getByTestId('action-pad-flow-scroll').props.contentContainerStyle)).toMatchObject({
      flexGrow: 1,
      justifyContent: 'space-between'
    })
    expect(StyleSheet.flatten(landscape.getByTestId('action-pad-core-group').props.style)).toMatchObject({
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
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-horizontal-scroll').props.style).height).toBe(110)
    fireEvent(screen.getByTestId('tablet-client-screen'), 'layout', {
      persist: jest.fn(),
      nativeEvent: { layout: { width: 800, height: 1_160, x: 0, y: 0 } }
    })

    await waitFor(() => {
      expect(StyleSheet.flatten(screen.getByTestId('tablet-client-screen').props.style).gap).toBe(4)
      expect(StyleSheet.flatten(screen.getByTestId('action-pad').props.style).minHeight).toBe(144)
    })
    expect(StyleSheet.flatten(screen.getByTestId('editor-frame').props.style).minHeight).toBe(48)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-horizontal-scroll').props.style).height).toBe(102)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-core-row-1').props.style).height).toBe(48)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-core-row-2').props.style).height).toBe(48)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-navigation-row-1').props.style).height).toBe(48)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-navigation-row-2').props.style).height).toBe(48)
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
      expect(StyleSheet.flatten(screen.getByTestId('editor-frame').props.style).minHeight).toBe(48)
      expect(StyleSheet.flatten(screen.getByTestId('action-pad').props.style).padding).toBe(8)
    })
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-flow-scroll').props.contentContainerStyle).gap).toBe(6)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-core-group').props.style).rowGap).toBe(6)
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

  it('preserves the session, menu, and endpoint state while resizing the editor after rotation', async () => {
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
    expect(screen.getByTestId('action-pad-escape')).toBeTruthy()
    expect(screen.queryByTestId('action-pad-ctrl')).toBeNull()

    fireEvent(screen.getByTestId('mock-editor-canvas'), 'layout', {
      nativeEvent: { layout: { width: 900, height: 440, x: 0, y: 0 } }
    })
    await waitFor(() => {
      expect(double.session.resize).toHaveBeenCalledWith(90, 20)
    })
    expect(double.session.attach).toHaveBeenCalledTimes(1)
    expect(double.session.close).not.toHaveBeenCalled()
  })

  it('keeps hardware modifiers and configured control mappings as ordinary input', async () => {
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

    fireEvent.press(screen.getByTestId('action-pad-keyboard'))
    const nativeIme = jest.requireMock('../native/CodeyIme') as { __focus: jest.Mock }
    expect(nativeIme.__focus).toHaveBeenCalledTimes(1)

    act(() => {
      const ime = screen.getByTestId('mock-codey-ime')
      ime.props.onCommittedText('c')
      ime.props.onKey({
        key: 'ArrowLeft',
        ctrl: true,
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
      expect(double.session.input).toHaveBeenNthCalledWith(2, '<C-Left>')
    })

    fireEvent.press(screen.getByText('Esc'))
    const actionIme = jest.requireMock('../native/CodeyIme') as { __sendOrderedInput: jest.Mock }
    await waitFor(() => {
      expect(actionIme.__sendOrderedInput).toHaveBeenCalledWith('<Esc>')
      expect(double.session.input).toHaveBeenNthCalledWith(3, '<Esc>')
    })

    fireEvent.press(screen.getByTestId('action-pad-command'))
    fireEvent.press(screen.getByTestId('action-pad-redo'))
    await waitFor(() => {
      expect(actionIme.__sendOrderedInput).toHaveBeenLastCalledWith('<C-r>')
      expect(double.session.input).toHaveBeenNthCalledWith(4, '<C-r>')
    })
  })

  it('settles composition before a tap click without focusing the IME', async () => {
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(
      <TabletClient capability={tabletCapability(1_280, 800)} />
    )
    fireEvent.press(screen.getByText('Connect'))
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())

    const nativeIme = jest.requireMock('../native/CodeyIme') as {
      __focus: jest.Mock
      __settleComposition: jest.Mock
      __setOrderedPrefix: (segments: unknown[]) => void
    }
    nativeIme.__setOrderedPrefix([{ type: 'text', text: 'ready' }])
    fireEvent(screen.getByTestId('mock-editor-canvas'), 'cellPress', {
      row: 3,
      column: 5
    })

    await waitFor(() => {
      expect(nativeIme.__settleComposition).toHaveBeenCalledTimes(1)
      expect(double.session.input).toHaveBeenCalledWith('ready')
      expect(double.session.inputMouse).toHaveBeenCalledWith({
        button: 'left',
        action: 'press',
        modifier: '',
        gridId: 0,
        row: 3,
        column: 5
      })
    })
    expect(jest.mocked(double.session.input).mock.invocationCallOrder[0]!).toBeLessThan(
      jest.mocked(double.session.inputMouse).mock.invocationCallOrder[0]!
    )
    expect(nativeIme.__focus).not.toHaveBeenCalled()

    fireEvent.press(screen.getByTestId('action-pad-keyboard'))
    expect(nativeIme.__focus).toHaveBeenCalledTimes(1)
    expect(double.session.inputMouse).toHaveBeenCalledTimes(1)
  })

  it('orders composition before a configured action and enters the controller exactly once', async () => {
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
    fireEvent.press(screen.getByText('Esc'))

    await waitFor(() => {
      expect(nativeIme.__sendOrderedInput).toHaveBeenCalledWith('<Esc>')
      expect(double.session.input).toHaveBeenCalledTimes(1)
      expect(double.session.input).toHaveBeenCalledWith('ready<Esc>')
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

  it('opens transient navigation on hold, keeps it open for repeated moves, and returns through a clean page', async () => {
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(
      <TabletClient capability={tabletCapability(1_280, 800)} />
    )

    fireEvent.press(screen.getByText('Connect'))
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())

    fireEvent(screen.getByTestId('action-pad-up'), 'longPress')
    expect(screen.getByText('› Home · Up Arrow – Navigation')).toBeTruthy()
    expect(screen.getByText('gg Top')).toBeTruthy()
    expect(screen.queryByTestId('action-pad-back')).toBeNull()

    fireEvent.press(screen.getByText('+5 Lines'))
    const nativeIme = jest.requireMock('../native/CodeyIme') as {
      __sendOrderedInput: jest.Mock
    }
    await waitFor(() => expect(double.session.input).toHaveBeenCalledWith('5k'))
    expect(nativeIme.__sendOrderedInput).toHaveBeenCalledWith('5k')
    expect(screen.getByText('+5 Lines')).toBeTruthy()

    fireEvent.press(screen.getByTestId('action-pad-command'))
    expect(screen.getByText('› Cmd')).toBeTruthy()
    expect(screen.queryByText('+5 Lines')).toBeNull()
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
