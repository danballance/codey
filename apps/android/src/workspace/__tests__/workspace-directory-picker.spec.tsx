import { useState } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native'
import { Modal } from 'react-native'

jest.mock('../../native/nvim', () => ({
  getNativeWorkspaceRoot: jest.fn(),
  listNativeWorkspaceDirectory: jest.fn()
}))

import {
  getNativeWorkspaceRoot,
  listNativeWorkspaceDirectory
} from '../../native/nvim'
import {
  createDiagnosticLogger,
  type DiagnosticLogger
} from '../../diagnostics/logger'
import { DiagnosticsModal } from '../../diagnostics/DiagnosticsModal'
import { WorkspaceDirectoryPicker } from '../WorkspaceDirectoryPicker'

type WorkspaceListing = Awaited<ReturnType<typeof listNativeWorkspaceDirectory>>

const PRIMARY_ROOT = Object.freeze({
  label: 'Internal shared storage',
  path: '/storage/emulated/0'
})

const mockedGetWorkspaceRoot = jest.mocked(getNativeWorkspaceRoot)
const mockedListWorkspaceDirectory = jest.mocked(listNativeWorkspaceDirectory)

function createTestLogger(): DiagnosticLogger {
  const sink = jest.fn()
  return createDiagnosticLogger({
    console: { debug: sink, error: sink, info: sink, warn: sink }
  })
}

function workspaceListing(
  overrides: Partial<WorkspaceListing> = {}
): WorkspaceListing {
  return {
    rootPath: PRIMARY_ROOT.path,
    path: '/storage/emulated/0/Projects',
    parentPath: PRIMARY_ROOT.path,
    writable: true,
    directories: [],
    ...overrides
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function renderPicker(
  overrides: Partial<React.ComponentProps<typeof WorkspaceDirectoryPicker>> = {}
) {
  const logger = overrides.logger ?? createTestLogger()
  const props: React.ComponentProps<typeof WorkspaceDirectoryPicker> = {
    initialPath: '/storage/emulated/0/Projects',
    logger,
    onCancel: jest.fn(),
    onOpenLogs: jest.fn(),
    onSelect: jest.fn(),
    ...overrides
  }
  return { ...render(<WorkspaceDirectoryPicker {...props} />), logger, props }
}

function PickerLogsHarness({
  logger,
  initialPath = '/storage/emulated/0/Projects'
}: {
  readonly logger: DiagnosticLogger
  readonly initialPath?: string
}) {
  const [pickerVisible, setPickerVisible] = useState(true)
  const [logsVisible, setLogsVisible] = useState(false)
  return (
    <>
      {pickerVisible ? (
        <WorkspaceDirectoryPicker
          initialPath={initialPath}
          logger={logger}
          onCancel={() => setPickerVisible(false)}
          onOpenLogs={() => setLogsVisible(true)}
          onSelect={() => setPickerVisible(false)}
        />
      ) : null}
      <DiagnosticsModal
        logger={logger}
        onClose={() => setLogsVisible(false)}
        visible={logsVisible}
      />
    </>
  )
}

beforeEach(() => {
  mockedGetWorkspaceRoot.mockReset()
  mockedListWorkspaceDirectory.mockReset()
  mockedGetWorkspaceRoot.mockResolvedValue(PRIMARY_ROOT)
  mockedListWorkspaceDirectory.mockResolvedValue(workspaceListing())
})

afterEach(() => {
  cleanup()
})

describe('WorkspaceDirectoryPicker', () => {
  it('loads the initial directory, preserves hidden names, navigates, and selects explicitly', async () => {
    const initial = workspaceListing({
      directories: [
        {
          name: '.private-project',
          path: '/storage/emulated/0/Projects/.private-project',
          writable: false
        },
        {
          name: 'Codey',
          path: '/storage/emulated/0/Projects/Codey',
          writable: true
        }
      ]
    })
    const hidden = workspaceListing({
      path: '/storage/emulated/0/Projects/.private-project',
      parentPath: '/storage/emulated/0/Projects',
      writable: true,
      directories: []
    })
    mockedListWorkspaceDirectory
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(hidden)
    const onSelect = jest.fn()
    const screen = renderPicker({ onSelect })

    expect(screen.getByTestId('workspace-directory-loading')).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('workspace-directory-current-path')).toHaveTextContent(
      '/storage/emulated/0/Projects'
    ))

    expect(mockedGetWorkspaceRoot).toHaveBeenCalledTimes(1)
    expect(mockedListWorkspaceDirectory).toHaveBeenNthCalledWith(
      1,
      '/storage/emulated/0/Projects'
    )
    expect(screen.logger.getSnapshot().entries.map(({ event }) => event)).toEqual(
      expect.arrayContaining([
        'picker.opened',
        'root.request.started',
        'root.request.succeeded',
        'directory.list.started',
        'directory.list.succeeded'
      ])
    )
    expect(screen.logger.getSnapshot().entries.find(
      ({ event }) => event === 'directory.list.succeeded'
    )?.details).toMatchObject({
      source: 'initial',
      requestedPath: '/storage/emulated/0/Projects',
      canonicalPath: '/storage/emulated/0/Projects',
      directoryCount: 2,
      readOnlyDirectoryCount: 1,
      rawListing: initial
    })
    expect(screen.getByText('.private-project')).toBeTruthy()
    expect(screen.getByText('Read-only')).toBeTruthy()
    expect(screen.getByRole('button', {
      name: 'Use current folder as workspace'
    }).props.accessibilityState.disabled).toBe(false)

    fireEvent.press(screen.getByRole('button', {
      name: 'Open folder .private-project, read-only'
    }))
    expect(onSelect).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('workspace-directory-current-path')).toHaveTextContent(
      '/storage/emulated/0/Projects/.private-project'
    ))
    expect(mockedListWorkspaceDirectory).toHaveBeenNthCalledWith(
      2,
      '/storage/emulated/0/Projects/.private-project'
    )
    expect(screen.logger.getSnapshot().entries.filter(
      ({ event }) => event === 'directory.list.succeeded'
    ).at(-1)?.details).toMatchObject({
      source: 'child',
      requestedPath: '/storage/emulated/0/Projects/.private-project'
    })

    fireEvent.press(screen.getByRole('button', { name: 'Use current folder as workspace' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('/storage/emulated/0/Projects/.private-project')
  })

  it('falls back to the canonical root when the initial path cannot be listed', async () => {
    mockedListWorkspaceDirectory
      .mockRejectedValueOnce(new Error('Previous folder no longer exists'))
      .mockResolvedValueOnce(workspaceListing({
        path: PRIMARY_ROOT.path,
        parentPath: undefined,
        writable: false,
        directories: []
      }))
    const screen = renderPicker({ initialPath: '/storage/emulated/0/Missing' })

    await waitFor(() => expect(screen.getByTestId('workspace-directory-empty')).toBeTruthy())

    expect(mockedListWorkspaceDirectory.mock.calls).toEqual([
      ['/storage/emulated/0/Missing'],
      [PRIMARY_ROOT.path]
    ])
    expect(screen.getByTestId('workspace-directory-current-path')).toHaveTextContent(PRIMARY_ROOT.path)
    expect(screen.queryByText('Previous folder no longer exists')).toBeNull()
    expect(screen.getByRole('button', {
      name: 'Use current folder as workspace'
    }).props.accessibilityState.disabled).toBe(true)
    expect(screen.getByRole('button', {
      name: 'Go to parent folder'
    }).props.accessibilityState.disabled).toBe(true)
    expect(screen.logger.getSnapshot().entries.find(
      ({ event }) => event === 'directory.initial_fallback'
    )?.details).toMatchObject({
      requestedPath: '/storage/emulated/0/Missing',
      fallbackPath: PRIMARY_ROOT.path,
      nativeFailure: expect.objectContaining({ message: 'Previous folder no longer exists' })
    })
    expect(screen.logger.getSnapshot().entries.filter(
      ({ event }) => event === 'directory.list.succeeded'
    ).at(-1)?.details).toMatchObject({ source: 'fallback' })
  })

  it('records one bounded terminal listing instead of one event per child', async () => {
    const directories = Array.from({ length: 500 }, (_, index) => ({
      name: `Project ${index}`,
      path: `/storage/emulated/0/Projects/Project-${index}`,
      writable: index % 3 !== 0
    }))
    mockedListWorkspaceDirectory.mockResolvedValueOnce(workspaceListing({ directories }))
    const screen = renderPicker()

    await waitFor(() => expect(screen.getByTestId('workspace-directory-list')).toBeTruthy())

    const listEntries = screen.logger.getSnapshot().entries.filter(
      ({ event }) => event.startsWith('directory.list.')
    )
    expect(listEntries).toHaveLength(2)
    expect(listEntries[1]?.details).toMatchObject({
      directoryCount: 500,
      readOnlyDirectoryCount: 167,
      rawListing: expect.objectContaining({ directories })
    })
  })

  it('navigates to the canonical parent with Up without selecting it', async () => {
    mockedListWorkspaceDirectory
      .mockResolvedValueOnce(workspaceListing())
      .mockResolvedValueOnce(workspaceListing({
        path: PRIMARY_ROOT.path,
        parentPath: undefined,
        directories: []
      }))
    const onSelect = jest.fn()
    const screen = renderPicker({ onSelect })
    await waitFor(() => expect(screen.getByTestId('workspace-directory-list')).toBeTruthy())

    fireEvent.press(screen.getByRole('button', { name: 'Go to parent folder' }))

    await waitFor(() => expect(screen.getByTestId('workspace-directory-current-path')).toHaveTextContent(
      PRIMARY_ROOT.path
    ))
    expect(mockedListWorkspaceDirectory).toHaveBeenLastCalledWith(PRIMARY_ROOT.path)
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.logger.getSnapshot().entries.filter(
      ({ event }) => event === 'directory.list.succeeded'
    ).at(-1)?.details).toMatchObject({ source: 'parent' })
  })

  it('shows native errors and retries the failed directory', async () => {
    mockedListWorkspaceDirectory
      .mockRejectedValueOnce({ message: 'The directory was removed' })
      .mockResolvedValueOnce(workspaceListing({
        path: PRIMARY_ROOT.path,
        parentPath: undefined,
        directories: []
      }))
    const screen = renderPicker({ initialPath: PRIMARY_ROOT.path })

    await waitFor(() => expect(screen.getByTestId('workspace-directory-error')).toBeTruthy())
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load folders')
    expect(screen.getByText('The directory was removed')).toBeTruthy()
    expect(screen.getByRole('button', {
      name: 'Use current folder as workspace'
    }).props.accessibilityState.disabled).toBe(true)

    fireEvent.press(screen.getByRole('button', { name: 'Retry loading workspace folders' }))

    await waitFor(() => expect(screen.getByTestId('workspace-directory-empty')).toBeTruthy())
    expect(mockedListWorkspaceDirectory).toHaveBeenCalledTimes(2)
    expect(mockedListWorkspaceDirectory).toHaveBeenLastCalledWith(PRIMARY_ROOT.path)
    expect(screen.logger.getSnapshot().entries.map(({ event }) => event)).toEqual(
      expect.arrayContaining(['directory.retry_requested'])
    )
    expect(screen.logger.getSnapshot().entries.filter(
      ({ event }) => event === 'directory.list.succeeded'
    ).at(-1)?.details).toMatchObject({ source: 'retry' })
  })

  it('ignores an older initial-path result after the prop starts a newer request', async () => {
    const firstRequest = deferred<WorkspaceListing>()
    mockedListWorkspaceDirectory.mockImplementation((path) => {
      if (path === '/storage/emulated/0/First') return firstRequest.promise
      return Promise.resolve(workspaceListing({
        path: '/storage/emulated/0/Second',
        parentPath: PRIMARY_ROOT.path,
        directories: []
      }))
    })
    const initial = renderPicker({ initialPath: '/storage/emulated/0/First' })
    await waitFor(() => expect(mockedListWorkspaceDirectory).toHaveBeenCalledWith(
      '/storage/emulated/0/First'
    ))

    initial.rerender(
      <WorkspaceDirectoryPicker
        {...initial.props}
        initialPath="/storage/emulated/0/Second"
      />
    )
    await waitFor(() => expect(initial.getByTestId('workspace-directory-current-path')).toHaveTextContent(
      '/storage/emulated/0/Second'
    ))

    await act(async () => {
      firstRequest.resolve(workspaceListing({
        path: '/storage/emulated/0/First',
        parentPath: PRIMARY_ROOT.path,
        directories: []
      }))
      await firstRequest.promise
    })
    expect(initial.getByTestId('workspace-directory-current-path')).toHaveTextContent(
      '/storage/emulated/0/Second'
    )
    expect(initial.logger.getSnapshot().entries.find(
      ({ event }) => event === 'directory.result_suppressed'
    )?.details).toMatchObject({
      requestedPath: '/storage/emulated/0/First',
      suppression: 'newer-request'
    })
  })

  it('cancels on Android Back and ignores a request that resolves after closing', async () => {
    const pending = deferred<WorkspaceListing>()
    mockedListWorkspaceDirectory.mockReturnValue(pending.promise)
    const onCancel = jest.fn()
    const screen = renderPicker({ onCancel })
    await waitFor(() => expect(mockedListWorkspaceDirectory).toHaveBeenCalledTimes(1))

    const modal = screen.UNSAFE_getByType(Modal)
    fireEvent(modal, 'requestClose')
    expect(onCancel).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending.resolve(workspaceListing({ path: '/storage/emulated/0/Late' }))
      await pending.promise
    })
    expect(screen.getByTestId('workspace-directory-current-path')).toHaveTextContent('—')
    expect(screen.queryByText('/storage/emulated/0/Late')).toBeNull()
    expect(screen.logger.getSnapshot().entries.map(({ event }) => event)).toEqual(
      expect.arrayContaining(['picker.cancelled', 'directory.result_suppressed'])
    )
    expect(screen.logger.getSnapshot().entries.find(
      ({ event }) => event === 'picker.cancelled'
    )?.details).toMatchObject({ source: 'android-back' })
  })

  it('provides a separate accessible Cancel action', async () => {
    const onCancel = jest.fn()
    const screen = renderPicker({ onCancel })
    await waitFor(() => expect(screen.getByTestId('workspace-directory-list')).toBeTruthy())

    fireEvent.press(screen.getByRole('button', { name: 'Cancel workspace selection' }))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(screen.logger.getSnapshot().entries.find(
      ({ event }) => event === 'picker.cancelled'
    )?.details).toMatchObject({ source: 'button' })
  })

  it('opens Logs without closing or resetting the picker', async () => {
    const onCancel = jest.fn()
    const onOpenLogs = jest.fn()
    const screen = renderPicker({ onCancel, onOpenLogs })
    await waitFor(() => expect(screen.getByTestId('workspace-directory-list')).toBeTruthy())

    fireEvent.press(screen.getByRole('button', { name: 'Open Logs' }))

    expect(onOpenLogs).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByTestId('workspace-directory-current-path')).toHaveTextContent(
      '/storage/emulated/0/Projects'
    )
    expect(screen.logger.getSnapshot().entries.map(({ event }) => event)).toContain(
      'picker.logs_opened'
    )
  })

  it('layers real Logs over the picker and applies Android Back in modal order', async () => {
    const childPath = '/storage/emulated/0/Projects/Codey'
    mockedListWorkspaceDirectory
      .mockResolvedValueOnce(workspaceListing({
        directories: [{ name: 'Codey', path: childPath, writable: true }]
      }))
      .mockResolvedValueOnce(workspaceListing({
        path: childPath,
        parentPath: '/storage/emulated/0/Projects'
      }))
    const logger = createTestLogger()
    const screen = render(<PickerLogsHarness logger={logger} />)
    await waitFor(() => expect(screen.getByText('Codey')).toBeTruthy())
    fireEvent.press(screen.getByRole('button', { name: 'Open folder Codey' }))
    await waitFor(() => expect(screen.getByTestId('workspace-directory-current-path')).toHaveTextContent(
      childPath
    ))

    fireEvent.press(screen.getByRole('button', { name: 'Open Logs' }))
    expect(screen.getByTestId('diagnostics-modal')).toBeTruthy()
    expect(screen.getByTestId('workspace-directory-picker')).toBeTruthy()
    expect(screen.UNSAFE_getAllByType(Modal)).toHaveLength(2)

    fireEvent(screen.UNSAFE_getAllByType(Modal).at(-1)!, 'requestClose')
    expect(screen.queryByTestId('diagnostics-modal')).toBeNull()
    expect(screen.getByTestId('workspace-directory-current-path')).toHaveTextContent(childPath)

    fireEvent(screen.UNSAFE_getAllByType(Modal)[0]!, 'requestClose')
    expect(screen.queryByTestId('workspace-directory-picker')).toBeNull()
  })

  it('preserves loading and error states under the real Logs overlay', async () => {
    const pending = deferred<WorkspaceListing>()
    mockedListWorkspaceDirectory.mockReturnValueOnce(pending.promise)
    const logger = createTestLogger()
    const screen = render(<PickerLogsHarness logger={logger} initialPath={PRIMARY_ROOT.path} />)
    await waitFor(() => expect(mockedListWorkspaceDirectory).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('workspace-directory-loading')).toBeTruthy()

    fireEvent.press(screen.getByRole('button', { name: 'Open Logs' }))
    expect(screen.getByTestId('diagnostics-modal')).toBeTruthy()
    expect(screen.getByTestId('workspace-directory-loading')).toBeTruthy()
    await act(async () => {
      pending.reject(new Error('Raw directory failure while Logs is open'))
      await pending.promise.catch(() => undefined)
    })
    await waitFor(() => expect(screen.getByTestId('workspace-directory-error')).toBeTruthy())

    fireEvent.press(screen.getByTestId('diagnostics-close'))
    expect(screen.queryByTestId('diagnostics-modal')).toBeNull()
    expect(screen.getByTestId('workspace-directory-error')).toBeTruthy()
    expect(screen.getByText('Raw directory failure while Logs is open')).toBeTruthy()
  })
})
