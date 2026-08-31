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
import { WorkspaceDirectoryPicker } from '../WorkspaceDirectoryPicker'

type WorkspaceListing = Awaited<ReturnType<typeof listNativeWorkspaceDirectory>>

const PRIMARY_ROOT = Object.freeze({
  label: 'Internal shared storage',
  path: '/storage/emulated/0'
})

const mockedGetWorkspaceRoot = jest.mocked(getNativeWorkspaceRoot)
const mockedListWorkspaceDirectory = jest.mocked(listNativeWorkspaceDirectory)

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
  const props: React.ComponentProps<typeof WorkspaceDirectoryPicker> = {
    initialPath: '/storage/emulated/0/Projects',
    onCancel: jest.fn(),
    onSelect: jest.fn(),
    ...overrides
  }
  return { ...render(<WorkspaceDirectoryPicker {...props} />), props }
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
  })

  it('provides a separate accessible Cancel action', async () => {
    const onCancel = jest.fn()
    const screen = renderPicker({ onCancel })
    await waitFor(() => expect(screen.getByTestId('workspace-directory-list')).toBeTruthy())

    fireEvent.press(screen.getByRole('button', { name: 'Cancel workspace selection' }))

    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
