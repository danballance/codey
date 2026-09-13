import { act, cleanup, fireEvent, render } from '@testing-library/react-native'
import { Modal } from 'react-native'

jest.mock('../../native/nvim', () => ({ getNativeRepositoryClone: jest.fn() }))
jest.mock('../WorkspaceDirectoryPicker', () => {
  const { View } = require('react-native')
  return { WorkspaceDirectoryPicker: (props: object) => <View testID="directory-picker" {...props} /> }
})

import type {
  NativeRepositoryCloneModule,
  NativeRepositoryCloneProgress,
  NativeRepositoryCloneResult
} from '../../native/nvim'
import { createDiagnosticLogger } from '../../diagnostics/logger'
import { WorkspacePicker } from '../WorkspacePicker'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function setup() {
  const result = deferred<NativeRepositoryCloneResult>()
  const cancellation = deferred<void>()
  let progress: ((event: NativeRepositoryCloneProgress) => void) | undefined
  const remove = jest.fn()
  const sink = jest.fn()
  const logger = createDiagnosticLogger({ console: { debug: sink, info: sink, warn: sink, error: sink } })
  const module: NativeRepositoryCloneModule = {
    cloneRepository: jest.fn(() => result.promise),
    cancelRepositoryClone: jest.fn(() => cancellation.promise),
    addListener: jest.fn((_event, listener) => { progress = listener; return { remove } })
  }
  const props = {
    initialPath: '/storage/emulated/0/Current',
    onCancel: jest.fn(), onSelect: jest.fn(), onOpenLogs: jest.fn(), onBusyChange: jest.fn(), module, logger
  }
  const screen = render(<WorkspacePicker {...props} />)
  function openClone() {
    fireEvent.press(screen.getByRole('button', { name: 'Clone GitHub repository' }))
  }
  function configure() {
    openClone()
    fireEvent.changeText(screen.getByLabelText('GitHub repository'), 'owner/repo')
    fireEvent.press(screen.getByRole('button', { name: 'Choose parent folder' }))
    fireEvent(screen.getByTestId('directory-picker'), 'select', '/storage/emulated/0/Projects')
  }
  function start() {
    configure()
    fireEvent.press(screen.getByRole('button', { name: 'Clone repository' }))
    return jest.mocked(module.cloneRepository).mock.calls[0]![0]
  }
  return { ...screen, props, module, result, cancellation, remove, logger, openClone, configure, start,
    emitProgress: (event: NativeRepositoryCloneProgress) => progress?.(event) }
}

afterEach(cleanup)

describe('WorkspacePicker', () => {
  it('routes local folder selection through the existing picker and closes on Cancel', () => {
    const screen = setup()
    fireEvent.press(screen.getByRole('button', { name: 'Choose existing folder' }))
    const picker = screen.getByTestId('directory-picker')
    expect(picker.props.initialPath).toBe(screen.props.initialPath)
    fireEvent(picker, 'select', '/storage/emulated/0/Existing')
    expect(screen.props.onSelect).toHaveBeenCalledWith('/storage/emulated/0/Existing')
    fireEvent(picker, 'cancel')
    expect(screen.props.onCancel).toHaveBeenCalledTimes(1)
    expect(screen.module.cloneRepository).not.toHaveBeenCalled()
  })

  it('requires an explicit parent choice, derives names until edited, and preserves draft under Logs', () => {
    const screen = setup()
    screen.openClone()
    fireEvent.changeText(screen.getByLabelText('GitHub repository'), 'owner/first')
    expect(screen.getByLabelText('Repository folder name').props.value).toBe('first')
    fireEvent.changeText(screen.getByLabelText('GitHub repository'), 'owner/second.git')
    expect(screen.getByLabelText('Repository folder name').props.value).toBe('second')
    fireEvent.press(screen.getByRole('button', { name: 'Clone repository' }))
    expect(screen.getByRole('alert').props.children).toBe('Choose a parent folder for the repository.')
    expect(screen.module.cloneRepository).not.toHaveBeenCalled()
    fireEvent.changeText(screen.getByLabelText('Repository folder name'), 'My copy')
    fireEvent.changeText(screen.getByLabelText('GitHub repository'), 'owner/third')
    expect(screen.getByLabelText('Repository folder name').props.value).toBe('My copy')
    fireEvent.press(screen.getByRole('button', { name: 'Choose parent folder' }))
    expect(screen.getByTestId('directory-picker').props).toMatchObject({
      initialPath: screen.props.initialPath, purpose: 'clone-destination'
    })
    fireEvent(screen.getByTestId('directory-picker'), 'cancel')
    expect(screen.props.onCancel).not.toHaveBeenCalled()
    fireEvent.press(screen.getByRole('button', { name: 'Choose parent folder' }))
    fireEvent(screen.getByTestId('directory-picker'), 'select', '/storage/emulated/0/Projects')
    expect(screen.getByTestId('repository-destination').props.children).toBe('/storage/emulated/0/Projects/My copy')
    expect(screen.props.onSelect).not.toHaveBeenCalled()
    fireEvent.press(screen.getByRole('button', { name: 'Open Logs' }))
    expect(screen.props.onOpenLogs).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Repository folder name').props.value).toBe('My copy')
  })

  it('normalizes clone arguments, bounds matching progress, prevents duplicates and selects only on success', async () => {
    const screen = setup()
    const id = screen.start()
    expect(screen.module.cloneRepository).toHaveBeenCalledWith(id, 'https://github.com/owner/repo.git',
      '/storage/emulated/0/Projects', 'repo')
    expect(screen.props.onBusyChange).toHaveBeenCalledWith(true)
    expect(screen.props.onSelect).not.toHaveBeenCalled()
    expect(screen.getByLabelText('GitHub repository').props.editable).toBe(false)
    fireEvent.press(screen.getByRole('button', { name: 'Clone repository' }))
    expect(screen.module.cloneRepository).toHaveBeenCalledTimes(1)
    act(() => screen.emitProgress({ operationId: 'old', message: 'stale' }))
    expect(screen.queryByText('stale')).toBeNull()
    act(() => screen.emitProgress({ operationId: id, message: 'x'.repeat(5_000) }))
    expect(screen.getByTestId('repository-clone-progress').props.children).toHaveLength(2_000)
    await act(async () => screen.result.resolve({ status: 'success', path: '/storage/emulated/0/Projects/repo' }))
    expect(screen.props.onSelect).toHaveBeenCalledWith('/storage/emulated/0/Projects/repo')
    expect(screen.props.onBusyChange).toHaveBeenLastCalledWith(false)
    expect(screen.remove).toHaveBeenCalled()
    expect(screen.logger.getSnapshot().entries.map(({ event }) => event)).toEqual([
      'repository_clone.started', 'repository_clone.succeeded'
    ])
    expect(screen.logger.getSnapshot().entries.every(({ operationId }) => operationId === id)).toBe(true)
    expect(screen.logger.getSnapshot().entries[0]?.details).toMatchObject({
      repositoryUrl: 'https://github.com/owner/repo.git', parentPath: '/storage/emulated/0/Projects', directoryName: 'repo'
    })
  })

  it('preserves form and old selection after error and allows a new operation to retry', async () => {
    const screen = setup()
    const firstId = screen.start()
    await act(async () => screen.result.resolve({ status: 'error', code: 'clone_failed', message: 'Repository not found.' }))
    expect(screen.getByRole('alert').props.children).toBe('Repository not found.')
    expect(screen.props.onSelect).not.toHaveBeenCalled()
    expect(screen.props.onCancel).not.toHaveBeenCalled()
    const retry = deferred<NativeRepositoryCloneResult>()
    jest.mocked(screen.module.cloneRepository).mockReturnValueOnce(retry.promise)
    fireEvent.press(screen.getByRole('button', { name: 'Retry clone' }))
    const secondId = jest.mocked(screen.module.cloneRepository).mock.calls[1]![0]
    expect(secondId).not.toBe(firstId)
    act(() => screen.emitProgress({ operationId: firstId, message: 'old failure' }))
    expect(screen.queryByText('old failure')).toBeNull()
    await act(async () => retry.resolve({ status: 'success', path: '/storage/emulated/0/Projects/repo' }))
    expect(screen.props.onSelect).toHaveBeenCalledTimes(1)
  })

  it('uses the latest owner selection guard when props change during a clone', async () => {
    const screen = setup()
    screen.start()
    const latestSelection = jest.fn()
    screen.rerender(<WorkspacePicker {...screen.props} onSelect={latestSelection} />)
    await act(async () => screen.result.resolve({ status: 'success', path: '/storage/emulated/0/Projects/repo' }))
    expect(screen.props.onSelect).not.toHaveBeenCalled()
    expect(latestSelection).toHaveBeenCalledWith('/storage/emulated/0/Projects/repo')
  })

  it('waits for native cancellation cleanup after Android Back and suppresses late success', async () => {
    const screen = setup()
    const id = screen.start()
    fireEvent(screen.UNSAFE_getByType(Modal), 'requestClose')
    expect(screen.module.cancelRepositoryClone).toHaveBeenCalledWith(id)
    expect(screen.getByText('Cancelling and cleaning up…')).toBeTruthy()
    expect(screen.props.onCancel).not.toHaveBeenCalled()
    expect(screen.props.onBusyChange).toHaveBeenLastCalledWith(true)
    await act(async () => screen.cancellation.resolve())
    expect(screen.props.onCancel).toHaveBeenCalledTimes(1)
    expect(screen.logger.getSnapshot().entries.map(({ event }) => event)).toEqual([
      'repository_clone.started', 'repository_clone.cancel_requested', 'repository_clone.cancelled'
    ])
    expect(screen.props.onBusyChange).toHaveBeenLastCalledWith(false)
    await act(async () => screen.result.resolve({ status: 'success', path: '/late' }))
    expect(screen.props.onSelect).not.toHaveBeenCalled()
    expect(screen.props.onCancel).toHaveBeenCalledTimes(1)
  })

  it('cancels on owner unmount, releases busy after cleanup and ignores late events/results', async () => {
    const screen = setup()
    const id = screen.start()
    screen.unmount()
    expect(screen.module.cancelRepositoryClone).toHaveBeenCalledWith(id)
    expect(screen.props.onBusyChange).toHaveBeenLastCalledWith(true)
    act(() => screen.emitProgress({ operationId: id, message: 'late progress' }))
    await act(async () => screen.cancellation.resolve())
    expect(screen.props.onBusyChange).toHaveBeenLastCalledWith(false)
    await act(async () => screen.result.resolve({ status: 'success', path: '/late' }))
    expect(screen.props.onSelect).not.toHaveBeenCalled()
    expect(screen.props.onCancel).not.toHaveBeenCalled()
    expect(screen.logger.getSnapshot().entries.map(({ event }) => event)).toEqual([
      'repository_clone.started', 'repository_clone.unmounted', 'repository_clone.cancel_requested', 'repository_clone.cancelled'
    ])
  })

  it('rejects credential URLs without exposing their contents in errors or calling native code', () => {
    const screen = setup()
    screen.configure()
    fireEvent.changeText(screen.getByLabelText('GitHub repository'), 'https://secret@github.com/owner/repo')
    fireEvent.press(screen.getByRole('button', { name: 'Clone repository' }))
    expect(screen.getByRole('alert').props.children).not.toContain('secret')
    expect(screen.module.cloneRepository).not.toHaveBeenCalled()
    expect(JSON.stringify(screen.logger.getSnapshot())).not.toContain('secret')
    expect(screen.logger.getSnapshot().entries.map(({ event }) => event)).toEqual(['repository_clone.input_rejected'])
  })
})
