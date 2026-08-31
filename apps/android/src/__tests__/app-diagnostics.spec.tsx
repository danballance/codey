import { Dimensions, Modal } from 'react-native'
import { act, cleanup, fireEvent, render } from '@testing-library/react-native'

import App from '../../App'
import { DiagnosticsModal } from '../diagnostics/DiagnosticsModal'
import { diagnosticLogger } from '../diagnostics/logger'

const mockTabletClientRender = jest.fn()
const originalWindow = Dimensions.get('window')
const originalScreen = Dimensions.get('screen')

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }))

jest.mock('react-native-safe-area-context', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  const { View: MockView } = jest.requireActual<typeof import('react-native')>('react-native')
  return {
    SafeAreaProvider: ({ children }: { readonly children?: import('react').ReactNode }) =>
      React.createElement(MockView, { testID: 'mock-safe-area-provider' }, children),
    SafeAreaView: ({ children, accessibilityViewIsModal, testID }: {
      readonly children?: import('react').ReactNode
      readonly accessibilityViewIsModal?: boolean
      readonly testID?: string
    }) => React.createElement(
      MockView,
      { accessibilityViewIsModal, testID },
      children
    )
  }
})

jest.mock('../TabletClient', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  const {
    Pressable: MockPressable,
    Text: MockText,
    View: MockView
  } = jest.requireActual<typeof import('react-native')>('react-native')
  return {
    TabletClient: (props: {
      readonly logsVisible: boolean
      readonly onOpenLogs: () => void
    }) => {
      mockTabletClientRender(props)
      return React.createElement(
        MockView,
        { testID: 'mock-tablet-client' },
        React.createElement(
          MockText,
          null,
          props.logsVisible ? 'supported logs visible' : 'supported logs hidden'
        ),
        React.createElement(
          MockPressable,
          { accessibilityRole: 'button', onPress: props.onOpenLogs },
          React.createElement(MockText, null, 'Open supported Logs')
        )
      )
    }
  }
})

beforeEach(() => {
  diagnosticLogger.clear()
  Dimensions.set({
    window: { width: 600, height: 800, scale: 1, fontScale: 1 },
    screen: { width: 600, height: 800, scale: 1, fontScale: 1 }
  })
  mockTabletClientRender.mockClear()
  jest.spyOn(console, 'debug').mockImplementation(() => undefined)
  jest.spyOn(console, 'info').mockImplementation(() => undefined)
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  jest.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  Dimensions.set({ window: originalWindow, screen: originalScreen })
  diagnosticLogger.clear()
  jest.restoreAllMocks()
})

describe('App operational logs boundary', () => {
  it('opens the App-owned viewer from the unsupported screen and closes by button or hardware Back', () => {
    const screen = render(<App />)

    expect(screen.getByTestId('unsupported-device-screen')).toBeTruthy()
    expect(mockTabletClientRender).not.toHaveBeenCalled()
    expect(screen.queryByTestId('diagnostics-modal')).toBeNull()

    fireEvent.press(screen.getByRole('button', { name: 'Open Logs' }))
    expect(screen.getByTestId('diagnostics-modal')).toBeTruthy()
    expect(screen.getByText('logs.opened')).toBeTruthy()

    fireEvent.press(screen.getByTestId('diagnostics-close'))
    expect(screen.queryByTestId('diagnostics-modal')).toBeNull()

    fireEvent.press(screen.getByRole('button', { name: 'Open Logs' }))
    act(() => {
      screen.UNSAFE_getByType(Modal).props.onRequestClose()
    })
    expect(screen.queryByTestId('diagnostics-modal')).toBeNull()
  })

  it('constructs supported content lazily and keeps the process history above a capability change', () => {
    const screen = render(<App />)
    expect(mockTabletClientRender).not.toHaveBeenCalled()

    fireEvent.press(screen.getByRole('button', { name: 'Open Logs' }))
    const runSummary = screen.getByTestId('diagnostics-run-summary').props.children
    expect(screen.getByText('app.started')).toBeTruthy()
    expect(screen.getByText('logs.opened')).toBeTruthy()

    act(() => {
      Dimensions.set({
        window: { width: 1_280, height: 800, scale: 1, fontScale: 1 },
        screen: { width: 1_280, height: 800, scale: 1, fontScale: 1 }
      })
    })

    expect(screen.getByTestId('mock-tablet-client')).toBeTruthy()
    expect(mockTabletClientRender).toHaveBeenCalled()
    expect(screen.queryByTestId('unsupported-device-screen')).toBeNull()
    expect(screen.getByTestId('diagnostics-modal')).toBeTruthy()
    expect(screen.getByTestId('diagnostics-run-summary').props.children).toBe(runSummary)
    expect(screen.getByText('app.started')).toBeTruthy()
    expect(screen.getByText('logs.opened')).toBeTruthy()
    expect(screen.getByText('capability.changed')).toBeTruthy()

    const modal = screen.UNSAFE_getByType(DiagnosticsModal)
    expect(modal.parent?.children.at(-1)).toBe(modal)
  })
})
