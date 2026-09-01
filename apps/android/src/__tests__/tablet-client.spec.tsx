import { act, useState, type ComponentProps } from 'react'
import {
  Alert,
  AppState,
  BackHandler,
  Keyboard,
  Modal,
  StyleSheet,
  type AppStateStatus
} from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react-native'
import type { HostDocument, HostDocumentWrite, RedrawBatch } from '@codey/nvim-session'
import {
  clearPerformanceRecords,
  configurePerformanceDiagnostics,
  getPerformanceRecords
} from '@codey/perf'
import type { DuplexTransport } from '@codey/transport'

import { TabletClient as TabletClientComponent } from '../TabletClient'
import { parseActionPadConfig, serializeActionPadConfig, type ActionPadConfig } from '../action-pad/document'
import { actionPadPathStorageKey } from '../action-pad/store'
import {
  CONNECTION_SETTINGS_STORAGE_KEY,
  DEFAULT_CONNECTION_SETTINGS,
  LEGACY_ENDPOINT_STORAGE_KEY
} from '../connection-settings-store'
import {
  actionPadEndpointForTarget,
  DEFAULT_CONNECTION_TARGET,
  type ConnectionTarget
} from '../connection-target'
import type { MobileSession } from '../controller'
import { DiagnosticsModal } from '../diagnostics/DiagnosticsModal'
import { diagnosticLogger } from '../diagnostics/logger'
import { createRuntimeConnection } from '../runtime-connection'
import { getNativeNvimStatus, openNativeNvimAllFilesSettings } from '../native/nvim'
import { tabletCapability } from '../tablet'

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn()
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
            await settleComposition()
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

jest.mock('../native/nvim', () => ({
  getNativeNvimStatus: jest.fn(),
  openNativeNvimAllFilesSettings: jest.fn()
}))

jest.mock('../workspace/WorkspaceDirectoryPicker', () => {
  const React = require('react')
  const { View } = require('react-native')
  return {
    WorkspaceDirectoryPicker: ({
      initialPath,
      onCancel,
      onOpenLogs,
      onSelect,
      purpose
    }: {
      initialPath: string
      onCancel: () => void
      onOpenLogs: () => void
      onSelect: (path: string) => void
      purpose?: 'workspace' | 'config'
    }) => React.createElement(View, {
      initialPath,
      onCancel,
      onOpenLogs,
      onSelect,
      purpose,
      testID: 'mock-workspace-directory-picker'
    })
  }
})

const mockedConnectionFactory = jest.mocked(createRuntimeConnection)
const mockedNativeNvimStatus = jest.mocked(getNativeNvimStatus)
const mockedOpenAllFilesSettings = jest.mocked(openNativeNvimAllFilesSettings)
const mockedAppStateAddEventListener = jest.mocked(AppState.addEventListener)
const getItem = jest.mocked(AsyncStorage.getItem)
const setItem = jest.mocked(AsyncStorage.setItem)
const DEFAULT_ACTION_PAD_ENDPOINT = actionPadEndpointForTarget(DEFAULT_CONNECTION_TARGET)
const TEST_CONFIG_DIRECTORY = '/storage/emulated/0/Codey'
const TEST_ACTION_PAD_PATH = `${TEST_CONFIG_DIRECTORY}/action-pad.yaml`
const DEFAULT_TEST_SETTINGS = {
  version: 3 as const,
  selectedKind: 'local' as const,
  local: {
    workspacePath: '/storage/emulated/0',
    configDirectory: TEST_CONFIG_DIRECTORY
  },
  remote: DEFAULT_CONNECTION_SETTINGS.remote
}

type TabletClientTestProps = Omit<
  ComponentProps<typeof TabletClientComponent>,
  'logsVisible' | 'onOpenLogs'
> & Partial<Pick<
  ComponentProps<typeof TabletClientComponent>,
  'logsVisible' | 'onOpenLogs'
>>

function TabletClient({
  logsVisible = false,
  onOpenLogs = () => undefined,
  ...props
}: TabletClientTestProps) {
  return (
    <TabletClientComponent
      {...props}
      logsVisible={logsVisible}
      onOpenLogs={onOpenLogs}
    />
  )
}

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
    readHostDocument: jest.fn(async (path: string): Promise<HostDocument> => ({ path, text: null })),
    writeHostDocument: jest.fn(async (_request: HostDocumentWrite): Promise<void> => undefined),
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => { resolve = finish })
  return { promise, resolve }
}

function storedSettings(target: ConnectionTarget): string {
  return JSON.stringify({
    ...DEFAULT_TEST_SETTINGS,
    selectedKind: target.kind,
    ...(target.kind === 'local'
      ? { local: {
          workspacePath: target.workspacePath,
          configDirectory: target.configDirectory ?? TEST_CONFIG_DIRECTORY
        } }
      : { remote: { host: target.host, port: target.port } })
  })
}

function openManagedButton(editor: ReturnType<typeof within>, menu = 'Home (home)') {
  fireEvent.press(editor.getByRole('button', { name: `Edit ${menu}` }))
  fireEvent.press(editor.getByRole('button', { name: 'Button settings' }))
}

async function connectConfiguredLocal(screen: ReturnType<typeof render>) {
  await waitFor(() => expect(
    screen.getByLabelText('Neovim config folder').props.value
  ).not.toBe(''))
  await act(async () => { fireEvent.press(screen.getByText('Connect')) })
}

function TabletLogsHarness() {
  const [logsVisible, setLogsVisible] = useState(false)
  return (
    <>
      <TabletClient
        capability={tabletCapability(1_280, 800)}
        logsVisible={logsVisible}
        onOpenLogs={() => setLogsVisible(true)}
      />
      <DiagnosticsModal
        onClose={() => setLogsVisible(false)}
        visible={logsVisible}
      />
    </>
  )
}

afterEach(async () => {
  await act(async () => { await Promise.resolve() })
  cleanup()
  configurePerformanceDiagnostics({ enabled: false })
  clearPerformanceRecords()
})

beforeEach(() => {
  mockedAppStateAddEventListener.mockReset()
  mockedAppStateAddEventListener.mockReturnValue({ remove: jest.fn() })
  getItem.mockImplementation(async (key) => key === CONNECTION_SETTINGS_STORAGE_KEY
    ? JSON.stringify(DEFAULT_TEST_SETTINGS)
    : null)
  mockedConnectionFactory.mockReset()
  mockedNativeNvimStatus.mockReset()
  mockedNativeNvimStatus.mockResolvedValue({
    supported: true,
    running: false,
    allFilesAccess: true
  })
  mockedOpenAllFilesSettings.mockReset()
  mockedOpenAllFilesSettings.mockResolvedValue()
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
  it('requires and persists a Local config folder before connecting', async () => {
    getItem.mockResolvedValue(null)
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)

    await waitFor(() => expect(screen.getByText('Choose a Neovim config folder')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Connect' }).props.accessibilityState.disabled).toBe(true)
    fireEvent.changeText(screen.getByLabelText('Neovim config folder'), TEST_CONFIG_DIRECTORY)
    expect(screen.getByRole('button', { name: 'Connect' }).props.accessibilityState.disabled).toBe(false)

    await act(async () => { fireEvent.press(screen.getByText('Connect')) })

    await waitFor(() => expect(mockedConnectionFactory).toHaveBeenCalledWith(
      {
        kind: 'local',
        workspacePath: '/storage/emulated/0',
        configDirectory: TEST_CONFIG_DIRECTORY
      },
      expect.objectContaining({ generation: 1, operationId: expect.any(String) })
    ))
    expect(setItem).toHaveBeenCalledWith(
      CONNECTION_SETTINGS_STORAGE_KEY,
      expect.stringContaining(`"configDirectory":"${TEST_CONFIG_DIRECTORY}"`)
    )
  })

  it('routes local all-files permission recovery through Android settings', async () => {
    mockedNativeNvimStatus.mockResolvedValue({
      supported: true,
      running: false,
      allFilesAccess: false
    })
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)

    await waitFor(() => expect(screen.getByText('Grant files')).toBeTruthy())
    expect(screen.getByRole('tab', { name: 'Use local Neovim' }).props.accessibilityState.selected).toBe(true)
    expect(screen.getByLabelText('Local workspace path').props.value).toBe('/storage/emulated/0')
    expect(screen.getByRole('button', { name: 'Browse local workspaces' }).props.accessibilityState.disabled).toBe(true)
    fireEvent.press(screen.getByText('Grant files'))
    expect(mockedOpenAllFilesSettings).toHaveBeenCalledTimes(1)
    expect(mockedConnectionFactory).not.toHaveBeenCalled()
  })

  it('opens and cancels the available local workspace browser without changing the path', async () => {
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    const browse = screen.getByRole('button', { name: 'Browse local workspaces' })

    expect(browse.props.accessibilityState.disabled).toBe(true)
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Browse local workspaces' }).props.accessibilityState.disabled
    ).toBe(false))
    fireEvent.press(screen.getByRole('button', { name: 'Browse local workspaces' }))

    const picker = screen.getByTestId('mock-workspace-directory-picker')
    expect(picker.props.initialPath).toBe('/storage/emulated/0')
    fireEvent(picker, 'cancel')

    expect(screen.queryByTestId('mock-workspace-directory-picker')).toBeNull()
    expect(screen.getByLabelText('Local workspace path').props.value).toBe('/storage/emulated/0')
    expect(mockedConnectionFactory).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
  })

  it('stores a browsed local workspace while retaining Remote and does not connect', async () => {
    getItem.mockImplementation(async (key) => key === CONNECTION_SETTINGS_STORAGE_KEY
      ? JSON.stringify({
          version: 3,
          selectedKind: 'local',
          local: {
            workspacePath: '/storage/emulated/0/Old',
            configDirectory: TEST_CONFIG_DIRECTORY
          },
          remote: { host: 'saved-remote.test', port: 7331 }
        })
      : null)
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)

    await waitFor(() => expect(screen.getByLabelText('Local workspace path').props.value).toBe(
      '/storage/emulated/0/Old'
    ))
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Browse local workspaces' }).props.accessibilityState.disabled
    ).toBe(false))
    fireEvent.press(screen.getByRole('button', { name: 'Browse local workspaces' }))
    fireEvent(
      screen.getByTestId('mock-workspace-directory-picker'),
      'select',
      '/storage/emulated/0/Projects'
    )

    await waitFor(() => expect(screen.getByLabelText('Local workspace path').props.value).toBe(
      '/storage/emulated/0/Projects'
    ))
    await waitFor(() => expect(setItem).toHaveBeenCalledWith(
      CONNECTION_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 3,
        selectedKind: 'local',
        local: {
          workspacePath: '/storage/emulated/0/Projects',
          configDirectory: TEST_CONFIG_DIRECTORY
        },
        remote: { host: 'saved-remote.test', port: 7331 }
      })
    ))
    expect(setItem.mock.calls.filter(([key]) => (
      key === CONNECTION_SETTINGS_STORAGE_KEY
    ))).toHaveLength(1)
    expect(screen.queryByTestId('mock-workspace-directory-picker')).toBeNull()
    expect(mockedConnectionFactory).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent(screen.getByRole('button', { name: 'Edit Action Pad' }), 'longPress')
    })
    expect(screen.getByText('Local (/storage/emulated/0/Projects) · Offline editing')).toBeTruthy()
    expect(mockedConnectionFactory).not.toHaveBeenCalled()
  })

  it('uses and logs the selected canonical workspace on a later explicit Connect', async () => {
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)

    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Browse local workspaces' }).props.accessibilityState.disabled
    ).toBe(false))
    fireEvent.press(screen.getByRole('button', { name: 'Browse local workspaces' }))
    fireEvent(
      screen.getByTestId('mock-workspace-directory-picker'),
      'select',
      '/storage/emulated/0/Canonical'
    )
    await waitFor(() => expect(screen.getByLabelText('Local workspace path').props.value).toBe(
      '/storage/emulated/0/Canonical'
    ))
    expect(mockedConnectionFactory).not.toHaveBeenCalled()

    diagnosticLogger.clear()
    await connectConfiguredLocal(screen)

    await waitFor(() => expect(mockedConnectionFactory).toHaveBeenCalledWith(
      {
        kind: 'local',
        workspacePath: '/storage/emulated/0/Canonical',
        configDirectory: TEST_CONFIG_DIRECTORY
      },
      { generation: 1, operationId: expect.any(String) }
    ))
    expect(diagnosticLogger.getSnapshot().entries.find(
      ({ event }) => event === 'connection.connect.started'
    )?.details).toMatchObject({
      generation: 1,
      target: {
        kind: 'local',
        workspacePath: '/storage/emulated/0/Canonical',
        configDirectory: TEST_CONFIG_DIRECTORY
      }
    })
  })

  it('waits for saved connection settings before browsing and preserves the hydrated Remote target', async () => {
    let resolveSettings!: (value: string) => void
    const settingsRead = new Promise<string>((resolve) => { resolveSettings = resolve })
    getItem.mockImplementation((key) => key === CONNECTION_SETTINGS_STORAGE_KEY
      ? settingsRead
      : Promise.resolve(null))
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)

    await waitFor(() => expect(mockedNativeNvimStatus).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', {
      name: 'Browse local workspaces'
    }).props.accessibilityState.disabled).toBe(true)

    await act(async () => {
      resolveSettings(JSON.stringify({
        version: 3,
        selectedKind: 'local',
        local: {
          workspacePath: '/storage/emulated/0/Previous',
          configDirectory: TEST_CONFIG_DIRECTORY
        },
        remote: { host: 'hydrated-remote.test', port: 7444 }
      }))
      await settingsRead
    })
    await waitFor(() => expect(screen.getByRole('button', {
      name: 'Browse local workspaces'
    }).props.accessibilityState.disabled).toBe(false))

    fireEvent.press(screen.getByRole('button', { name: 'Browse local workspaces' }))
    fireEvent(
      screen.getByTestId('mock-workspace-directory-picker'),
      'select',
      '/storage/emulated/0/New'
    )

    await waitFor(() => expect(setItem).toHaveBeenCalledWith(
      CONNECTION_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 3,
        selectedKind: 'local',
        local: {
          workspacePath: '/storage/emulated/0/New',
          configDirectory: TEST_CONFIG_DIRECTORY
        },
        remote: { host: 'hydrated-remote.test', port: 7444 }
      })
    ))
    expect(mockedConnectionFactory).not.toHaveBeenCalled()
  })

  it('keeps Browse disabled during startup and a session, and hides it in Remote', async () => {
    let resolveConnect!: () => void
    const connectGate = new Promise<void>((resolve) => { resolveConnect = resolve })
    const double = connectionDouble()
    jest.mocked(double.session.connect).mockImplementation(() => connectGate)
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)

    expect(screen.getByRole('button', { name: 'Browse local workspaces' }).props.accessibilityState.disabled).toBe(true)
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Browse local workspaces' }).props.accessibilityState.disabled
    ).toBe(false))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    await connectConfiguredLocal(screen)
    await waitFor(() => expect(screen.getByText('Starting Local (/storage/emulated/0)…')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Browse local workspaces' }).props.accessibilityState.disabled).toBe(true)

    await act(async () => { resolveConnect() })
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Browse local workspaces' }).props.accessibilityState.disabled).toBe(true)
    await act(async () => { fireEvent.press(screen.getByText('Disconnect')) })
    await waitFor(() => expect(screen.getByText('Disconnected')).toBeTruthy())
    await act(async () => {
      fireEvent.press(screen.getByRole('tab', { name: 'Use remote Neovim' }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.queryByRole('button', { name: 'Browse local workspaces' })).toBeNull()
  })

  it('closes the workspace browser when refreshed status revokes local access', async () => {
    let appStateListener: ((state: AppStateStatus) => void) | undefined
    mockedAppStateAddEventListener.mockImplementation((type, listener) => {
      if (type === 'change') appStateListener = listener
      return { remove: jest.fn() }
    })
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Browse local workspaces' }).props.accessibilityState.disabled
    ).toBe(false))
    fireEvent.press(screen.getByRole('button', { name: 'Browse local workspaces' }))
    expect(screen.getByTestId('mock-workspace-directory-picker')).toBeTruthy()

    mockedNativeNvimStatus.mockResolvedValueOnce({
      supported: true,
      running: false,
      allFilesAccess: false
    })
    await act(async () => { appStateListener?.('active') })

    await waitFor(() => expect(screen.queryByTestId('mock-workspace-directory-picker')).toBeNull())
    expect(screen.getByRole('button', { name: 'Browse local workspaces' }).props.accessibilityState.disabled).toBe(true)
  })

  it('tears down the picker under visible Logs without clearing process history', async () => {
    let appStateListener: ((state: AppStateStatus) => void) | undefined
    mockedAppStateAddEventListener.mockImplementation((type, listener) => {
      if (type === 'change') appStateListener = listener
      return { remove: jest.fn() }
    })
    diagnosticLogger.clear()
    diagnosticLogger.info({
      category: 'app',
      event: 'test.history_before_permission_change',
      message: 'History retained while permission changes under Logs'
    })
    const screen = render(
      <TabletClient
        capability={tabletCapability(1_280, 800)}
        logsVisible
        onOpenLogs={jest.fn()}
      />
    )
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Browse local workspaces' }).props.accessibilityState.disabled
    ).toBe(false))
    fireEvent.press(screen.getByRole('button', { name: 'Browse local workspaces' }))
    expect(screen.getByTestId('mock-workspace-directory-picker')).toBeTruthy()

    mockedNativeNvimStatus.mockResolvedValueOnce({
      supported: true,
      running: false,
      allFilesAccess: false
    })
    await act(async () => { appStateListener?.('active') })

    await waitFor(() => expect(screen.queryByTestId('mock-workspace-directory-picker')).toBeNull())
    expect(diagnosticLogger.getSnapshot().entries.map(({ event }) => event)).toEqual(
      expect.arrayContaining([
        'test.history_before_permission_change',
        'picker.permission_closed'
      ])
    )
  })

  it('routes the offline Action Pad connection through local file-access settings', async () => {
    mockedNativeNvimStatus.mockResolvedValue({
      supported: true,
      running: false,
      allFilesAccess: false
    })
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)

    await waitFor(() => expect(screen.getByText('Grant files')).toBeTruthy())
    await act(async () => {
      fireEvent(screen.getByRole('button', { name: 'Edit Action Pad' }), 'longPress')
    })
    const grant = screen.getByRole('button', { name: 'Grant local workspace file access' })
    fireEvent.press(grant)

    expect(mockedOpenAllFilesSettings).toHaveBeenCalledTimes(1)
    expect(mockedConnectionFactory).not.toHaveBeenCalled()
  })

  it('keeps the newest native status when an earlier refresh finishes late', async () => {
    let resolveFirstStatus!: (status: Awaited<ReturnType<typeof getNativeNvimStatus>>) => void
    const firstStatus = new Promise<Awaited<ReturnType<typeof getNativeNvimStatus>>>((resolve) => {
      resolveFirstStatus = resolve
    })
    mockedNativeNvimStatus
      .mockImplementationOnce(() => firstStatus)
      .mockResolvedValueOnce({
        supported: false,
        running: false,
        allFilesAccess: false,
        unavailableReason: 'Newest device status'
      })
    let appStateListener: ((state: AppStateStatus) => void) | undefined
    mockedAppStateAddEventListener.mockImplementation((type, listener) => {
      if (type === 'change') appStateListener = listener
      return { remove: jest.fn() }
    })

    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    await waitFor(() => expect(mockedNativeNvimStatus).toHaveBeenCalledTimes(1))
    await act(async () => { appStateListener?.('active') })
    await waitFor(() => expect(screen.getByText('Newest device status')).toBeTruthy())

    await act(async () => {
      resolveFirstStatus({ supported: true, running: false, allFilesAccess: true })
    })
    expect(screen.getByText('Newest device status')).toBeTruthy()
  })

  it('keeps Disconnect available when local file access is revoked mid-session', async () => {
    let appStateListener: ((state: AppStateStatus) => void) | undefined
    mockedAppStateAddEventListener.mockImplementation((type, listener) => {
      if (type === 'change') appStateListener = listener
      return { remove: jest.fn() }
    })
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    await waitFor(() => expect(mockedNativeNvimStatus).toHaveBeenCalledTimes(1))
    await connectConfiguredLocal(screen)
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())

    mockedNativeNvimStatus.mockResolvedValueOnce({
      supported: true,
      running: true,
      allFilesAccess: false
    })
    await act(async () => { appStateListener?.('active') })
    await waitFor(() => expect(mockedNativeNvimStatus).toHaveBeenCalledTimes(2))

    expect(screen.getByText('Disconnect')).toBeTruthy()
    fireEvent.press(screen.getByText('Disconnect'))
    await waitFor(() => expect(double.session.close).toHaveBeenCalledTimes(1))
    expect(mockedOpenAllFilesSettings).not.toHaveBeenCalled()
  })

  it('does not replace a newly connected target when legacy endpoint loading finishes late', async () => {
    let restoreEndpoint!: (value: string) => void
    const pending = new Promise<string>((resolve) => { restoreEndpoint = resolve })
    getItem.mockImplementation((key) => key === LEGACY_ENDPOINT_STORAGE_KEY ? pending : Promise.resolve(null))
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    fireEvent.changeText(screen.getByLabelText('Neovim config folder'), TEST_CONFIG_DIRECTORY)
    await connectConfiguredLocal(screen)
    await waitFor(() => expect(mockedConnectionFactory).toHaveBeenCalledWith(
      {
        kind: 'local',
        workspacePath: '/storage/emulated/0',
        configDirectory: TEST_CONFIG_DIRECTORY
      },
      expect.objectContaining({ generation: 1, operationId: expect.any(String) })
    ))
    await act(async () => { restoreEndpoint(JSON.stringify({ host: 'previous.test', port: 7777 })) })
    expect(screen.getByLabelText('Local workspace path').props.value).toBe('/storage/emulated/0')
    await act(async () => { fireEvent(screen.getByRole('button', { name: 'Edit Action Pad' }), 'longPress') })
    const editor = within(screen.getByTestId('action-pad-editor'))
    expect(editor.getByText(`Saves to ${TEST_ACTION_PAD_PATH}`)).toBeTruthy()
    expect(editor.queryByLabelText('Codey config folder')).toBeNull()
    expect(editor.getByTestId('action-pad-editor-save').props.accessibilityState.disabled).toBe(false)
  })

  it('waits for cold-start path restoration before mounting the editor', async () => {
    const endpoint = { host: 'remembered.test', port: 6666 }
    let restoreEndpoint!: (value: string) => void
    let restorePath!: (value: string) => void
    const endpointRead = new Promise<string>((resolve) => { restoreEndpoint = resolve })
    const pathRead = new Promise<string>((resolve) => { restorePath = resolve })
    getItem.mockImplementation((key) => {
      if (key === CONNECTION_SETTINGS_STORAGE_KEY) return Promise.resolve(null)
      if (key === LEGACY_ENDPOINT_STORAGE_KEY) return endpointRead
      if (key === actionPadPathStorageKey(endpoint)) return pathRead
      return Promise.resolve(null)
    })
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    fireEvent(screen.getByRole('button', { name: 'Edit Action Pad' }), 'longPress')
    expect(screen.queryByTestId('action-pad-editor')).toBeNull()
    await act(async () => { restoreEndpoint(JSON.stringify(endpoint)) })
    expect(getItem).toHaveBeenCalledWith(actionPadPathStorageKey(endpoint))
    expect(screen.queryByTestId('action-pad-editor')).toBeNull()
    await act(async () => { restorePath('/home/test/action-pad.yaml') })
    const editor = within(screen.getByTestId('action-pad-editor'))
    openManagedButton(editor)
    expect(editor.getByLabelText('Host YAML path').props.value).toBe('/home/test/action-pad.yaml')
    expect(editor.getByLabelText('Button ID').props.value).toBe('escape')
    expect(editor.getByTestId('action-pad-editor-save').props.accessibilityState.disabled).toBe(true)
    expect(screen.getAllByText('Edit Action Pad')).not.toHaveLength(0)
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

  it('outlines the idle edit control without changing selected or host-connect styling', async () => {
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    await act(async () => { await Promise.resolve() })

    const edit = screen.getByRole('button', { name: 'Edit Action Pad' })
    expect(StyleSheet.flatten(edit.props.style)).toMatchObject({
      backgroundColor: 'transparent',
      borderColor: '#353b52'
    })

    fireEvent.press(edit)
    expect(StyleSheet.flatten(screen.getByRole('button', { name: 'Done editing' }).props.style)).toMatchObject({
      backgroundColor: '#20343d',
      borderColor: '#73daca'
    })

    fireEvent.press(screen.getByRole('button', { name: 'Done editing' }))
    await act(async () => { fireEvent(screen.getByRole('button', { name: 'Edit Action Pad' }), 'longPress') })
    expect(StyleSheet.flatten(screen.getByRole('button', { name: 'Connect configuration session' }).props.style)).toMatchObject({
      backgroundColor: '#1b2030',
      borderColor: '#353b52'
    })
  })

  it('returns to the selected submenu through editor entry, closing and a supported landscape resize', async () => {
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(<TabletClient capability={tabletCapability(800, 600)} />)
    await connectConfiguredLocal(screen)
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
    screen.rerender(<TabletClient capability={tabletCapability(1_280, 800)} />)
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
    await connectConfiguredLocal(screen)
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

  it('keeps the saved pad visible and discards unfinished local ID text when closing', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    try {
      const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
      await act(async () => { await Promise.resolve() })
      fireEvent.press(screen.getByRole('button', { name: 'Edit Action Pad' }))
      await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Edit Esc' })) })
      const editor = within(screen.getByTestId('action-pad-editor'))
      fireEvent.changeText(editor.getByLabelText('Button ID'), 'directory')
      fireEvent.press(editor.getByRole('button', { name: 'Cancel' }))
      expect(alert.mock.calls.at(-1)?.[0]).toBe('Unsaved Action Pad edits')
      expect(alert.mock.calls.at(-1)?.[2]?.map((button) => button.text)).toEqual(['Keep editing', 'Discard and close'])
      act(() => { alert.mock.calls.at(-1)?.[2]?.find((button) => button.text === 'Keep editing')?.onPress?.() })
      expect(screen.getByTestId('action-pad-editor')).toBeTruthy()
      expect(within(screen.getByTestId('action-pad-editor')).getByLabelText('Button ID').props.value).toBe('directory')
      fireEvent.press(within(screen.getByTestId('action-pad-editor')).getByRole('button', { name: 'Cancel' }))
      act(() => { alert.mock.calls.at(-1)?.[2]?.find((button) => button.text === 'Discard and close')?.onPress?.() })
      expect(screen.queryByTestId('action-pad-editor')).toBeNull()
      expect(screen.getByText('Done editing')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Edit Esc' })).toBeTruthy()
      await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Edit Esc' })) })
      const reopened = within(screen.getByTestId('action-pad-editor'))
      expect(reopened.getByLabelText('Button label').props.value).toBe('Esc')
      expect(reopened.getByLabelText('Button ID').props.value).toBe('escape')
      expect(mockedConnectionFactory).not.toHaveBeenCalled()
    } finally {
      alert.mockRestore()
    }
  })

  it('selects the Local config folder before opening the simplified Action Pad editor', async () => {
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    await waitFor(() => expect(screen.getByRole('button', {
      name: 'Browse Neovim config folders'
    }).props.accessibilityState.disabled).toBe(false))
    fireEvent.press(screen.getByRole('button', { name: 'Browse Neovim config folders' }))
    const picker = screen.getByTestId('mock-workspace-directory-picker')
    expect(picker.props).toMatchObject({
      initialPath: TEST_CONFIG_DIRECTORY,
      purpose: 'config'
    })
    fireEvent(picker, 'select', '/home/test/another')

    expect(screen.getByLabelText('Neovim config folder').props.value).toBe('/home/test/another')
    expect(mockedConnectionFactory).not.toHaveBeenCalled()
    fireEvent(screen.getByRole('button', { name: 'Edit Action Pad' }), 'longPress')
    await waitFor(() => expect(screen.getByTestId('action-pad-editor')).toBeTruthy())
    const editor = within(screen.getByTestId('action-pad-editor'))
    expect(editor.getByText('Saves to /home/test/another/action-pad.yaml')).toBeTruthy()
    expect(editor.queryByRole('button', { name: 'Browse' })).toBeNull()
    expect(editor.queryByRole('button', { name: 'Load' })).toBeNull()
    expect(editor.queryByRole('button', { name: 'Load / Reload' })).toBeNull()
    expect(editor.queryByLabelText('Codey config folder')).toBeNull()

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Connect configuration session' }))
    })

    await waitFor(() => expect(mockedConnectionFactory).toHaveBeenCalledWith(
      {
        kind: 'local',
        workspacePath: '/storage/emulated/0',
        configDirectory: '/home/test/another'
      },
      { generation: 1, operationId: expect.any(String) }
    ))
    await waitFor(() => expect(double.session.readHostDocument).toHaveBeenCalledWith(
      '/home/test/another/action-pad.yaml'
    ))
    expect(double.session.defaultActionPadPath).not.toHaveBeenCalled()
    expect(setItem).toHaveBeenCalledWith(
      CONNECTION_SETTINGS_STORAGE_KEY,
      expect.stringContaining('"configDirectory":"/home/test/another"')
    )
    expect(setItem).not.toHaveBeenCalledWith(
      actionPadPathStorageKey(DEFAULT_ACTION_PAD_ENDPOINT),
      expect.any(String)
    )
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
    expect(editor.getByTestId('action-pad-menu-manager')).toBeTruthy()
    expect(editor.getByRole('button', { name: 'Manage menus' }).props.accessibilityState.selected).toBe(true)
    expect(editor.queryByLabelText('Button ID')).toBeNull()
    fireEvent.press(editor.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Done editing' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit Action Pad' })).toBeTruthy()
  })

  it('keeps the general editor accessible without a hold and from an empty pad', async () => {
    const empty: ActionPadConfig = { version: 1, rootMenuId: 'empty', menus: [{ id: 'empty', label: 'Empty', groups: [] }] }
    const double = connectionDouble()
    jest.mocked(double.session.readHostDocument).mockResolvedValue({
      path: '/home/test/.config/nvim/codey/action-pad.yaml',
      text: serializeActionPadConfig(empty)
    })
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    await connectConfiguredLocal(screen)
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())
    await waitFor(() => expect(within(screen.getByTestId('action-pad')).queryAllByRole('button')).toHaveLength(0))
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
    expect(editor.getByTestId('action-pad-menu-manager')).toBeTruthy()
    fireEvent.press(editor.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Done editing' })).toBeTruthy()
  })

  it('exits selection on Android Back without opening a discard prompt', async () => {
    let back: Parameters<typeof BackHandler.addEventListener>[1] | undefined
    const remove = jest.fn()
    const listener = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
      back = handler
      return { remove }
    })
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    try {
      const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
      await act(async () => { await Promise.resolve() })
      fireEvent.press(screen.getByRole('button', { name: 'Edit Action Pad' }))
      expect(back).toBeDefined()
      act(() => { expect(back?.({ type: 'hardwareBackPress', timeStamp: 0 })).toBe(true) })
      expect(remove).toHaveBeenCalledTimes(1)
      expect(screen.getByText('Edit Action Pad')).toBeTruthy()
      expect(alert).not.toHaveBeenCalled()
      await act(async () => { fireEvent(screen.getByRole('button', { name: 'Edit Action Pad' }), 'longPress') })
      const editor = within(screen.getByTestId('action-pad-editor'))
      openManagedButton(editor)
      expect(editor.getByLabelText('Button ID').props.value).toBe('escape')
    } finally {
      listener.mockRestore()
      alert.mockRestore()
    }
  })

  it('rejects a targeted opening when path initialization changes the endpoint', async () => {
    let finishSettings!: (value: string) => void
    const settingsRead = new Promise<string>((resolve) => { finishSettings = resolve })
    getItem.mockImplementation((key) => key === CONNECTION_SETTINGS_STORAGE_KEY ? settingsRead : Promise.resolve(null))
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    fireEvent.press(screen.getByRole('button', { name: 'Edit Action Pad' }))
    fireEvent.press(screen.getByRole('button', { name: 'Edit Esc' }))
    await act(async () => { finishSettings(storedSettings({ kind: 'remote', host: 'another.test', port: 7777 })) })
    expect(screen.queryByTestId('action-pad-editor')).toBeNull()
    expect(screen.getByText('The Action Pad changed before the button editor opened. Select the button again.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit Action Pad' })).toBeTruthy()
    expect(mockedConnectionFactory).not.toHaveBeenCalled()
  })

  it('cancels a pending targeted opening when selection mode is switched off', async () => {
    let finishSettings!: (value: string) => void
    const settingsRead = new Promise<string>((resolve) => { finishSettings = resolve })
    getItem.mockImplementation((key) => key === CONNECTION_SETTINGS_STORAGE_KEY ? settingsRead : Promise.resolve(null))
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    fireEvent.press(screen.getByRole('button', { name: 'Edit Action Pad' }))
    fireEvent.press(screen.getByRole('button', { name: 'Edit Esc' }))
    fireEvent.press(screen.getByRole('button', { name: 'Done editing' }))
    await act(async () => { finishSettings(storedSettings(DEFAULT_CONNECTION_TARGET)) })
    expect(screen.queryByTestId('action-pad-editor')).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit Action Pad' })).toBeTruthy()
  })

  it('opens the configuration editor offline without changing the saved pad', async () => {
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    await act(async () => { await Promise.resolve() })
    fireEvent(screen.getByRole('button', { name: 'Edit Action Pad' }), 'longPress')
    await waitFor(() => expect(screen.getByTestId('action-pad-editor')).toBeTruthy())
    const editor = within(screen.getByTestId('action-pad-editor'))
    openManagedButton(editor)
    fireEvent.changeText(editor.getByLabelText('Button label'), 'Escape now')
    expect(screen.queryByTestId('action-pad-editor-preview')).toBeNull()
    expect(within(screen.getByTestId('action-pad-container')).getByText('Esc')).toBeTruthy()
    expect(within(screen.getByTestId('action-pad-container')).queryByText('Escape now')).toBeNull()
    const nativeIme = jest.requireMock('../native/CodeyIme') as { __sendOrderedInput: jest.Mock; __focus: jest.Mock }
    expect(nativeIme.__sendOrderedInput).not.toHaveBeenCalled()
    expect(nativeIme.__focus).not.toHaveBeenCalled()
    expect(mockedConnectionFactory).not.toHaveBeenCalled()
    expect(editor.getByTestId('action-pad-editor-save').props.accessibilityState.disabled).toBe(true)
  })

  it('resumes the deferred first load when an incomplete ID edit is undone', async () => {
    const double = connectionDouble()
    const read = deferred<HostDocument>()
    jest.mocked(double.session.readHostDocument).mockImplementation(() => read.promise)
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    await act(async () => { await Promise.resolve() })
    fireEvent(screen.getByRole('button', { name: 'Edit Action Pad' }), 'longPress')
    await waitFor(() => expect(screen.getByTestId('action-pad-editor')).toBeTruthy())
    const editor = within(screen.getByTestId('action-pad-editor'))
    openManagedButton(editor)
    fireEvent.changeText(editor.getByLabelText('Button ID'), 'directory')
    expect(editor.getByLabelText('Button ID').props.value).toBe('directory')
    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Connect configuration session' })) })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Connect configuration session' })).toBeNull())
    expect(editor.getByLabelText('Button ID').props.value).toBe('directory')
    expect(double.session.defaultActionPadPath).not.toHaveBeenCalled()
    expect(double.session.readHostDocument).not.toHaveBeenCalled()

    fireEvent.press(editor.getByRole('button', { name: 'Undo Button ID edit' }))
    await waitFor(() => expect(double.session.readHostDocument).toHaveBeenCalledWith(
      TEST_ACTION_PAD_PATH
    ))
    expect(editor.getByTestId('action-pad-editor-save').props.accessibilityState.disabled).toBe(true)

    await act(async () => {
      read.resolve({ path: TEST_ACTION_PAD_PATH, text: null })
    })
    await waitFor(() => expect(editor.getByTestId(
      'action-pad-editor-save'
    ).props.accessibilityState.disabled).toBe(false))
  })

  it('resumes the deferred first load when a valid config edit is reverted', async () => {
    const double = connectionDouble()
    const read = deferred<HostDocument>()
    jest.mocked(double.session.readHostDocument).mockImplementation(() => read.promise)
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    await act(async () => { await Promise.resolve() })
    fireEvent(screen.getByRole('button', { name: 'Edit Action Pad' }), 'longPress')
    await waitFor(() => expect(screen.getByTestId('action-pad-editor')).toBeTruthy())
    const editor = within(screen.getByTestId('action-pad-editor'))
    openManagedButton(editor)
    fireEvent.changeText(editor.getByLabelText('Button label'), 'Offline edit')

    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Connect configuration session' })) })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Connect configuration session' })).toBeNull())
    expect(double.session.defaultActionPadPath).not.toHaveBeenCalled()
    expect(double.session.readHostDocument).not.toHaveBeenCalled()

    fireEvent.changeText(editor.getByLabelText('Button label'), 'Esc')
    await waitFor(() => expect(double.session.readHostDocument).toHaveBeenCalledWith(
      TEST_ACTION_PAD_PATH
    ))
    expect(editor.getByTestId('action-pad-editor-save').props.accessibilityState.disabled).toBe(true)

    await act(async () => {
      read.resolve({ path: TEST_ACTION_PAD_PATH, text: null })
    })
    await waitFor(() => expect(editor.getByTestId(
      'action-pad-editor-save'
    ).props.accessibilityState.disabled).toBe(false))
  })

  it('settles composition on entry, keeps the session mounted, and never routes form input to it', async () => {
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    await act(async () => { await Promise.resolve() })
    await connectConfiguredLocal(screen)
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
    openManagedButton(editor)
    fireEvent.changeText(editor.getByLabelText('Tap Neovim input'), ':write<CR>')
    // The saved pad remains mounted beneath the editor, but is suspended.
    fireEvent.press(within(screen.getByTestId('action-pad-container')).getByTestId('action-pad-escape'))
    // Even a delayed native callback is ignored while ordinary form fields own focus.
    fireEvent(screen.getByTestId('mock-codey-ime'), 'committedText', 'form text')
    expect(double.session.input).toHaveBeenCalledTimes(inputCount)
    expect(double.session.close).not.toHaveBeenCalled()
    expect(mockedConnectionFactory).toHaveBeenCalledTimes(1)
  })

  it('loads, edits and saves the fixed Local Action Pad file through the mounted host session', async () => {
    const double = connectionDouble()
    const path = TEST_ACTION_PAD_PATH
    const config: ActionPadConfig = {
      version: 1, rootMenuId: 'home', menus: [
        {
          id: 'home', label: 'Home', groups: [{
            id: 'main', buttons: [{
              id: 'escape', label: 'Esc', styles: { size: '1/2' },
              tap: { type: 'input', nvimInput: '<Esc>', after: 'root' }
            }]
          }]
        },
        {
          id: 'unused', label: 'Unused', groups: [{
            id: 'tools', buttons: [{
              id: 'noop', label: 'No-op', styles: { size: '1/2' },
              tap: { type: 'input', nvimInput: '<Nop>', after: 'stay' }
            }]
          }]
        }
      ]
    }
    const files = new Map<string, string>([[path, serializeActionPadConfig(config)]])
    jest.mocked(double.session.readHostDocument).mockImplementation(async (filename) => ({
      path: filename,
      text: files.get(filename) ?? null
    }))
    jest.mocked(double.session.writeHostDocument).mockImplementation(async (request) => {
      files.set(request.path, request.text)
    })
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(<TabletClient capability={tabletCapability(1_280, 800)} />)
    await act(async () => { await Promise.resolve() })
    await connectConfiguredLocal(screen)
    await act(async () => { fireEvent(screen.getByRole('button', { name: 'Edit Action Pad' }), 'longPress') })
    const editor = within(screen.getByTestId('action-pad-editor'))
    expect(editor.getByTestId('action-pad-menu-manager')).toBeTruthy()
    await waitFor(() => expect(editor.getByText('Unused (unused)')).toBeTruthy())
    fireEvent.press(editor.getByTestId('action-pad-remove-unused-menus'))
    fireEvent.press(editor.getByTestId('action-pad-confirm-remove-unused-menus'))
    expect(editor.queryByText('Unused (unused)')).toBeNull()
    openManagedButton(editor)
    expect(editor.getByLabelText('Button label').props.value).toBe('Esc')
    const input = "  <Esc>:echo 'λ'<CR>\n\t "
    fireEvent.changeText(editor.getByLabelText('Button label'), '001 λ')
    fireEvent.changeText(editor.getByLabelText('Tap Neovim input'), input)
    await act(async () => { fireEvent.press(editor.getByTestId('action-pad-editor-save')) })
    const saved = parseActionPadConfig(files.get(path)!)
    expect(saved.menus.map((menu) => menu.id)).toEqual(['home'])
    expect(saved.menus[0]?.groups[0]?.buttons[0]).toMatchObject({
      label: '001 λ', tap: { nvimInput: input }
    })
    expect(editor.getByTestId('action-pad-menu-manager')).toBeTruthy()
    expect(parseActionPadConfig(files.get(path)!).menus.map((menu) => menu.id)).toEqual(['home'])
    expect(editor.queryByText('Unused (unused)')).toBeNull()
    openManagedButton(editor)
    expect(editor.getByLabelText('Tap Neovim input').props.value).toBe(input)
    expect(editor.getByText(`Saves to ${TEST_ACTION_PAD_PATH}`)).toBeTruthy()
    expect(setItem).not.toHaveBeenCalledWith(
      actionPadPathStorageKey(DEFAULT_ACTION_PAD_ENDPOINT),
      expect.any(String)
    )
    fireEvent.press(editor.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('action-pad-editor')).toBeNull()
    expect(within(screen.getByTestId('action-pad')).getByText('001 λ')).toBeTruthy()
    expect(double.session.input).not.toHaveBeenCalled()
    expect(double.session.close).not.toHaveBeenCalled()
  }, 15_000)

  it('uses the same fixed right rail in condensed and expanded landscape layouts', async () => {
    const landscape = render(<TabletClient capability={tabletCapability(601, 600)} />)
    await act(async () => { await Promise.resolve() })
    expect(StyleSheet.flatten(landscape.getByTestId('tablet-client-screen').props.style).paddingHorizontal).toBe(8)
    expect(StyleSheet.flatten(landscape.getByTestId('local-workspace-controls').props.style)).toMatchObject({
      width: 320,
      flexShrink: 1,
      minWidth: 160
    })
    expect(StyleSheet.flatten(landscape.getByTestId('tablet-client-workspace').props.style)).toMatchObject({
      flexDirection: 'row'
    })
    expect(StyleSheet.flatten(landscape.getByTestId('action-pad-container').props.style).width).toBe(336)
    expect(StyleSheet.flatten(landscape.getByTestId('action-pad').props.style)).toMatchObject({
      flex: 1,
      minHeight: 0,
      padding: 24,
      borderLeftWidth: 2
    })
    expect(landscape.queryByTestId('action-pad-horizontal-scroll')).toBeNull()
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

    landscape.rerender(<TabletClient capability={tabletCapability(1_280, 800)} />)
    expect(StyleSheet.flatten(landscape.getByTestId('tablet-client-screen').props.style).paddingHorizontal).toBe(16)
    expect(StyleSheet.flatten(landscape.getByTestId('local-workspace-controls').props.style)).toMatchObject({
      width: 320
    })
    expect(StyleSheet.flatten(
      landscape.getByTestId('local-workspace-controls').props.style
    ).flexShrink).toBeUndefined()
    expect(StyleSheet.flatten(landscape.getByTestId('tablet-client-workspace').props.style).flexDirection).toBe('row')
    expect(StyleSheet.flatten(landscape.getByTestId('action-pad-container').props.style).width).toBe(336)
    expect(mockedConnectionFactory).not.toHaveBeenCalled()
  })

  it('keeps the remote toolbar and Logs action within the condensed layout budget', async () => {
    const screen = render(<TabletClient capability={tabletCapability(601, 600)} />)
    await act(async () => { await Promise.resolve() })

    fireEvent.press(screen.getByRole('tab', { name: 'Use remote Neovim' }))

    expect(StyleSheet.flatten(screen.getByTestId('main-toolbar').props.style).gap).toBe(5)
    expect(StyleSheet.flatten(
      screen.getByRole('tab', { name: 'Use remote Neovim' }).props.style
    )).toMatchObject({ minWidth: 50, paddingHorizontal: 4 })
    expect(StyleSheet.flatten(screen.getByLabelText('Neovim host').props.style).width).toBe(104)
    expect(StyleSheet.flatten(screen.getByLabelText('Neovim port').props.style).width).toBe(68)
    expect(StyleSheet.flatten(
      screen.getByRole('button', { name: 'Connect' }).props.style
    )).toMatchObject({ minWidth: 88, paddingHorizontal: 10 })
    expect(screen.getByTestId('main-open-logs')).toBeTruthy()
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

  it('preserves the session, menu, and endpoint state across supported landscape tiers', async () => {
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(<TabletClient capability={tabletCapability(800, 600)} />)

    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.press(screen.getByRole('tab', { name: 'Use remote Neovim' }))
    fireEvent.changeText(screen.getByLabelText('Neovim host'), '192.168.0.42')
    fireEvent.changeText(screen.getByLabelText('Neovim port'), '7777')
    fireEvent(screen.getByTestId('mock-editor-canvas'), 'layout', {
      nativeEvent: { layout: { width: 700, height: 550, x: 0, y: 0 } }
    })
    await act(async () => { fireEvent.press(screen.getByText('Connect')) })
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
    expect(mockedConnectionFactory).toHaveBeenCalledWith({
      kind: 'remote', host: '192.168.0.42', port: 7777
    }, expect.objectContaining({ generation: 1, operationId: expect.any(String) }))
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
    expect(screen.queryByText('100 × 20 · 1280 × 800dp')).toBeNull()

    await connectConfiguredLocal(screen)
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
    await connectConfiguredLocal(screen)
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
    await connectConfiguredLocal(screen)
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
    await connectConfiguredLocal(screen)
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

    await connectConfiguredLocal(screen)
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

    await connectConfiguredLocal(screen)
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

    await connectConfiguredLocal(screen)

    await waitFor(() => expect(screen.getByText('connection refused')).toBeTruthy())
    expect(screen.getByText('Connect')).toBeTruthy()
    expect(double.session.close).toHaveBeenCalledTimes(1)
    expect(mockedConnectionFactory).toHaveBeenCalledTimes(1)
  })

  it('settles ordered composition and blurs before opening Logs from the main toolbar', async () => {
    const double = connectionDouble()
    const order: string[] = []
    const onOpenLogs = jest.fn(() => { order.push('open') })
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(
      <TabletClient
        capability={tabletCapability(1_280, 800)}
        logsVisible={false}
        onOpenLogs={onOpenLogs}
      />
    )
    const nativeIme = jest.requireMock('../native/CodeyIme') as {
      __blur: jest.Mock
      __settleComposition: jest.Mock
    }

    await connectConfiguredLocal(screen)
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())
    nativeIme.__blur.mockClear()
    nativeIme.__settleComposition.mockClear()
    nativeIme.__settleComposition.mockImplementationOnce(() => { order.push('settle') })
    nativeIme.__blur.mockImplementationOnce(async () => { order.push('blur') })
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {
      order.push('dismiss')
    })

    fireEvent.press(screen.getByTestId('main-open-logs'))

    await waitFor(() => expect(onOpenLogs).toHaveBeenCalledTimes(1))
    expect(nativeIme.__settleComposition).toHaveBeenCalledTimes(1)
    expect(nativeIme.__blur).toHaveBeenCalledTimes(1)
    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['settle', 'blur', 'dismiss', 'open'])
  })

  it('opens Logs after settlement and blur failures and dismisses a focused toolbar keyboard', async () => {
    const double = connectionDouble()
    const onOpenLogs = jest.fn()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(
      <TabletClient
        capability={tabletCapability(1_280, 800)}
        logsVisible={false}
        onOpenLogs={onOpenLogs}
      />
    )
    const nativeIme = jest.requireMock('../native/CodeyIme') as {
      __blur: jest.Mock
      __settleComposition: jest.Mock
    }
    await connectConfiguredLocal(screen)
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())
    diagnosticLogger.clear()
    nativeIme.__settleComposition.mockRejectedValueOnce(new Error('settlement failed'))
    nativeIme.__blur.mockRejectedValueOnce(new Error('blur failed'))
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined)

    fireEvent.press(screen.getByTestId('main-open-logs'))

    await waitFor(() => expect(onOpenLogs).toHaveBeenCalledTimes(1))
    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(diagnosticLogger.getSnapshot().entries.map(({ event }) => event)).toEqual(
      expect.arrayContaining([
        'logs_composition_settlement.failed',
        'logs_blur.failed',
        'logs.opened'
      ])
    )

    screen.rerender(
      <TabletClient
        capability={tabletCapability(1_280, 800)}
        logsVisible={false}
        onOpenLogs={onOpenLogs}
      />
    )
    fireEvent.press(screen.getByText('Disconnect'))
    await waitFor(() => expect(screen.getByText('Disconnected')).toBeTruthy())
    fireEvent(screen.getByLabelText('Local workspace path'), 'focus')
    fireEvent.press(screen.getByTestId('main-open-logs'))
    await waitFor(() => expect(onOpenLogs).toHaveBeenCalledTimes(2))
    expect(dismiss).toHaveBeenCalledTimes(2)
  })

  it('forwards the workspace Logs action without closing or changing the picker', async () => {
    const onOpenLogs = jest.fn()
    const screen = render(
      <TabletClient
        capability={tabletCapability(1_280, 800)}
        logsVisible={false}
        onOpenLogs={onOpenLogs}
      />
    )

    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Browse local workspaces' }).props.accessibilityState.disabled
    ).toBe(false))
    fireEvent.press(screen.getByRole('button', { name: 'Browse local workspaces' }))
    const picker = screen.getByTestId('mock-workspace-directory-picker')
    fireEvent(picker, 'openLogs')

    expect(onOpenLogs).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('mock-workspace-directory-picker').props.initialPath).toBe(
      '/storage/emulated/0'
    )
    expect(mockedConnectionFactory).not.toHaveBeenCalled()
  })

  it('layers real Logs over the Action Pad editor and preserves its form state', async () => {
    const screen = render(<TabletLogsHarness />)
    await act(async () => { await Promise.resolve() })
    await act(async () => {
      fireEvent(screen.getByRole('button', { name: 'Edit Action Pad' }), 'longPress')
    })
    const editor = within(await screen.findByTestId('action-pad-editor'))
    openManagedButton(editor)
    fireEvent.changeText(editor.getByLabelText('Button label'), 'Kept under logs')

    fireEvent.press(editor.getByRole('button', { name: 'Logs' }))

    expect(screen.getByTestId('diagnostics-modal')).toBeTruthy()
    expect(screen.getByTestId('action-pad-editor')).toBeTruthy()
    expect(screen.UNSAFE_getAllByType(Modal).length).toBeGreaterThanOrEqual(2)
    fireEvent(screen.UNSAFE_getAllByType(Modal).at(-1)!, 'requestClose')

    expect(screen.queryByTestId('diagnostics-modal')).toBeNull()
    expect(within(screen.getByTestId('action-pad-editor')).getByLabelText(
      'Button label'
    ).props.value).toBe('Kept under logs')
  })

  it('suspends editor and Action Pad input while Logs is visible', async () => {
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(
      <TabletClient capability={tabletCapability(1_280, 800)} logsVisible={false} />
    )

    await connectConfiguredLocal(screen)
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())
    screen.rerender(
      <TabletClient capability={tabletCapability(1_280, 800)} logsVisible />
    )

    fireEvent(screen.getByTestId('mock-codey-ime'), 'onCommittedText', 'blocked text')
    fireEvent.press(screen.getByText('Esc'))

    expect(double.session.input).not.toHaveBeenCalled()
  })

  it('disposes a connected session when the supported client unmounts', async () => {
    const double = connectionDouble()
    mockedConnectionFactory.mockReturnValue(double)
    const screen = render(
      <TabletClient capability={tabletCapability(1_280, 800)} />
    )

    await connectConfiguredLocal(screen)
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())

    screen.unmount()

    await waitFor(() => expect(double.session.close).toHaveBeenCalledTimes(1))
  })
})
