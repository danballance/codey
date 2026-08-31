import { Alert } from 'react-native'
import { act, cleanup, fireEvent, render } from '@testing-library/react-native'

import { DiagnosticsModal } from '../DiagnosticsModal'
import type {
  DiagnosticEntry,
  DiagnosticLogger,
  DiagnosticSnapshot
} from '../logger'

afterEach(() => {
  cleanup()
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe('DiagnosticsModal', () => {
  it('shows run counts, filters entries, searches raw details, and expands selectable details', () => {
    jest.useFakeTimers()
    const logger = fakeLogger([
      entry(1, 'info', 'workspace', 'workspace.list.succeeded', 'Listed documents', '{"path":"/storage/documents"}'),
      entry(2, 'error', 'transport', 'transport.write.failed', 'Socket write failed', '{"code":"EPIPE"}')
    ], 7)
    const screen = render(<DiagnosticsModal logger={logger.value} onClose={jest.fn()} visible />)

    expect(screen.getByTestId('diagnostics-counts').props.children).toBe(
      '2 retained · 2 filtered · 7 evicted'
    )
    expect(screen.getByText('workspace.list.succeeded')).toBeTruthy()
    expect(screen.getByText('transport.write.failed')).toBeTruthy()

    fireEvent.press(screen.getByTestId('diagnostics-level-info'))
    expect(screen.queryByText('workspace.list.succeeded')).toBeNull()
    expect(screen.getByTestId('diagnostics-counts').props.children).toBe(
      '2 retained · 1 filtered · 7 evicted'
    )

    fireEvent.press(screen.getByTestId('diagnostics-level-info'))
    fireEvent.changeText(screen.getByTestId('diagnostics-search'), 'DOCUMENTS')
    expect(screen.getByText('transport.write.failed')).toBeTruthy()
    act(() => { jest.advanceTimersByTime(200) })
    expect(screen.getByText('workspace.list.succeeded')).toBeTruthy()
    expect(screen.queryByText('transport.write.failed')).toBeNull()

    fireEvent.press(screen.getByTestId('diagnostics-entry-summary-1'))
    expect(screen.getByTestId('diagnostics-entry-details-1')).toBeTruthy()
    expect(screen.getByText('{"path":"/storage/documents"}').props.selectable).toBe(true)
  })

  it('distinguishes an empty run from filters that match nothing', () => {
    const empty = render(
      <DiagnosticsModal logger={fakeLogger([]).value} onClose={jest.fn()} visible />
    )
    expect(empty.getByTestId('diagnostics-empty')).toBeTruthy()
    expect(empty.queryByTestId('diagnostics-filter-empty')).toBeNull()
    empty.unmount()

    const populated = render(
      <DiagnosticsModal
        logger={fakeLogger([entry(1, 'info', 'app', 'app.started', 'Started')]).value}
        onClose={jest.fn()}
        visible
      />
    )
    fireEvent.press(populated.getByTestId('diagnostics-level-info'))
    expect(populated.getByTestId('diagnostics-filter-empty')).toBeTruthy()
    expect(populated.queryByTestId('diagnostics-empty')).toBeNull()
  })

  it('keeps viewer state across close and reopen, and reports matching entries while paused', () => {
    jest.useFakeTimers()
    const logger = fakeLogger([
      entry(1, 'info', 'app', 'app.started', 'Started'),
      entry(2, 'warn', 'workspace', 'workspace.fallback', 'Fell back')
    ])
    const onClose = jest.fn()
    const screen = render(<DiagnosticsModal logger={logger.value} onClose={onClose} visible />)

    fireEvent.changeText(screen.getByTestId('diagnostics-search'), 'workspace')
    act(() => { jest.advanceTimersByTime(200) })
    fireEvent.press(screen.getByTestId('diagnostics-entry-summary-2'))
    fireEvent.scroll(screen.getByTestId('diagnostics-list'), {
      nativeEvent: {
        contentOffset: { x: 0, y: 0 },
        contentSize: { width: 600, height: 800 },
        layoutMeasurement: { width: 600, height: 200 }
      }
    })
    expect(screen.getByText('0 new matching entries')).toBeTruthy()

    act(() => {
      logger.push(entry(3, 'info', 'workspace', 'workspace.list.succeeded', 'Listed'))
      logger.push(entry(4, 'error', 'transport', 'transport.closed', 'Closed'))
    })
    expect(screen.getByText('1 new matching entry')).toBeTruthy()

    screen.rerender(<DiagnosticsModal logger={logger.value} onClose={onClose} visible={false} />)
    screen.rerender(<DiagnosticsModal logger={logger.value} onClose={onClose} visible />)
    expect(screen.getByTestId('diagnostics-search').props.value).toBe('workspace')
    expect(screen.getByTestId('diagnostics-entry-details-2')).toBeTruthy()
    expect(screen.getByText('1 new matching entry')).toBeTruthy()

    fireEvent.press(screen.getByTestId('diagnostics-resume'))
    expect(screen.getByTestId('diagnostics-following')).toBeTruthy()
    fireEvent.press(screen.getByTestId('diagnostics-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('requires confirmation before clearing the in-app ring', () => {
    const logger = fakeLogger([entry(1, 'info', 'app', 'app.started', 'Started')])
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    const screen = render(<DiagnosticsModal logger={logger.value} onClose={jest.fn()} visible />)

    fireEvent.press(screen.getByTestId('diagnostics-clear'))
    expect(logger.clear).not.toHaveBeenCalled()
    const buttons = alert.mock.calls[0]?.[2]
    const destructive = buttons?.find((button) => button.style === 'destructive')
    act(() => { destructive?.onPress?.() })

    expect(logger.clear).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('diagnostics-empty')).toBeTruthy()
  })
})

function entry(
  sequence: number,
  level: DiagnosticEntry['level'],
  category: DiagnosticEntry['category'],
  event: string,
  message: string,
  detailsText = ''
): DiagnosticEntry {
  return {
    sequence,
    timestamp: Date.UTC(2026, 7, 31, 12, 34, 56, sequence),
    elapsedMs: sequence * 10,
    level,
    category,
    event,
    message,
    operationId: `operation-${sequence}`,
    details: detailsText.length === 0 ? undefined : JSON.parse(detailsText),
    detailsText,
    truncated: false,
    sizeBytes: 100
  }
}

function fakeLogger(initialEntries: readonly DiagnosticEntry[], evictedCount = 0) {
  const listeners = new Set<() => void>()
  let snapshot: DiagnosticSnapshot = {
    runId: 'test-run',
    runStartedAt: Date.UTC(2026, 7, 31, 12, 0, 0),
    entries: initialEntries,
    evictedCount,
    totalBytes: initialEntries.length * 100
  }
  const clear = jest.fn(() => {
    snapshot = { ...snapshot, entries: [], evictedCount: 0, totalBytes: 0 }
    listeners.forEach((listener) => listener())
  })
  const value = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    clear
  } as unknown as DiagnosticLogger

  return {
    value,
    clear,
    push(next: DiagnosticEntry) {
      snapshot = {
        ...snapshot,
        entries: [...snapshot.entries, next],
        totalBytes: snapshot.totalBytes + next.sizeBytes
      }
      listeners.forEach((listener) => listener())
    }
  }
}
