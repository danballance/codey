import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import {
  getNativeWorkspaceRoot,
  listNativeWorkspaceDirectory
} from '../native/nvim'
import {
  diagnosticLogger,
  type DiagnosticLogger
} from '../diagnostics/logger'

type WorkspaceRoot = Awaited<ReturnType<typeof getNativeWorkspaceRoot>>
type WorkspaceListing = Awaited<ReturnType<typeof listNativeWorkspaceDirectory>>
type WorkspaceDirectory = WorkspaceListing['directories'][number]
type WorkspaceRequestSource = 'initial' | 'child' | 'parent' | 'retry' | 'fallback'

type WorkspaceRequestResult<T> =
  | { readonly status: 'success'; readonly value: T; readonly operationId: string }
  | { readonly status: 'failure'; readonly reason: unknown; readonly operationId: string }
  | { readonly status: 'suppressed'; readonly operationId: string }

export interface WorkspaceDirectoryPickerProps {
  readonly initialPath: string
  readonly onCancel: () => void
  readonly onOpenLogs: () => void
  readonly onSelect: (path: string) => void
  readonly purpose?: 'workspace' | 'config'
  readonly logger?: DiagnosticLogger
}

export function WorkspaceDirectoryPicker({
  initialPath,
  onCancel,
  onOpenLogs,
  onSelect,
  purpose = 'workspace',
  logger = diagnosticLogger
}: WorkspaceDirectoryPickerProps) {
  const requestId = useRef(0)
  const closed = useRef(false)
  const closeReason = useRef<'open' | 'cancelled' | 'selected'>('open')
  const initialPathAtOpen = useRef(initialPath)
  const [root, setRoot] = useState<WorkspaceRoot | null>(null)
  const [listing, setListing] = useState<WorkspaceListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retryPath, setRetryPath] = useState<string | null>(null)

  const isCurrentRequest = useCallback(
    (candidate: number) => !closed.current && candidate === requestId.current,
    []
  )

  const requestWorkspaceRoot = useCallback(async (
    candidate: number,
    source: Extract<WorkspaceRequestSource, 'initial' | 'retry'>
  ): Promise<WorkspaceRequestResult<WorkspaceRoot>> => {
    const operation = logger.operation({
      category: 'workspace',
      event: 'root.request',
      message: 'Getting the native workspace root',
      details: {
        requestId: candidate,
        requestedPath: initialPath,
        source
      }
    })

    try {
      const nextRoot = await getNativeWorkspaceRoot()
      if (!isCurrentRequest(candidate)) {
        operation.cancellation({
          event: 'root.result_suppressed',
          message: 'Suppressed a late workspace-root result',
          details: {
            requestId: candidate,
            requestedPath: initialPath,
            source,
            suppression: closed.current ? 'picker-closed' : 'newer-request',
            rawRoot: nextRoot
          }
        })
        return { status: 'suppressed', operationId: operation.id }
      }

      operation.success({
        details: {
          requestId: candidate,
          requestedPath: initialPath,
          source,
          canonicalPath: nextRoot.path,
          rootPath: nextRoot.path,
          volumeLabel: nextRoot.label,
          rawRoot: nextRoot
        }
      })
      return { status: 'success', value: nextRoot, operationId: operation.id }
    } catch (reason) {
      if (!isCurrentRequest(candidate)) {
        operation.cancellation({
          event: 'root.failure_suppressed',
          message: 'Suppressed a late workspace-root failure',
          details: {
            requestId: candidate,
            requestedPath: initialPath,
            source,
            suppression: closed.current ? 'picker-closed' : 'newer-request',
            nativeFailure: reason
          }
        })
        return { status: 'suppressed', operationId: operation.id }
      }

      operation.failure(reason, {
        details: {
          requestId: candidate,
          requestedPath: initialPath,
          source,
          nativeFailure: reason
        }
      })
      return { status: 'failure', reason, operationId: operation.id }
    }
  }, [initialPath, isCurrentRequest, logger])

  const requestDirectory = useCallback(async (
    path: string,
    source: WorkspaceRequestSource,
    candidate: number,
    workspaceRoot: WorkspaceRoot | null,
    parentOperationId?: string
  ): Promise<WorkspaceRequestResult<WorkspaceListing>> => {
    const operation = logger.operation({
      category: 'workspace',
      event: 'directory.list',
      message: 'Listing a native workspace directory',
      parentOperationId,
      details: {
        requestId: candidate,
        source,
        requestedPath: path,
        rootPath: workspaceRoot?.path,
        volumeLabel: workspaceRoot?.label
      }
    })

    try {
      const nextListing = await listNativeWorkspaceDirectory(path)
      if (!isCurrentRequest(candidate)) {
        operation.cancellation({
          event: 'directory.result_suppressed',
          message: 'Suppressed a late workspace-directory result',
          details: {
            requestId: candidate,
            source,
            requestedPath: path,
            suppression: closed.current ? 'picker-closed' : 'newer-request',
            rawListing: nextListing
          }
        })
        return { status: 'suppressed', operationId: operation.id }
      }

      operation.success({
        details: listingDiagnosticDetails(
          nextListing,
          candidate,
          source,
          path,
          workspaceRoot
        )
      })
      return { status: 'success', value: nextListing, operationId: operation.id }
    } catch (reason) {
      if (!isCurrentRequest(candidate)) {
        operation.cancellation({
          event: 'directory.failure_suppressed',
          message: 'Suppressed a late workspace-directory failure',
          details: {
            requestId: candidate,
            source,
            requestedPath: path,
            suppression: closed.current ? 'picker-closed' : 'newer-request',
            nativeFailure: reason
          }
        })
        return { status: 'suppressed', operationId: operation.id }
      }

      operation.failure(reason, {
        details: {
          requestId: candidate,
          source,
          requestedPath: path,
          rootPath: workspaceRoot?.path,
          volumeLabel: workspaceRoot?.label,
          nativeFailure: reason
        }
      })
      return { status: 'failure', reason, operationId: operation.id }
    }
  }, [isCurrentRequest, logger])

  const loadDirectory = useCallback(async (
    path: string,
    source: Extract<WorkspaceRequestSource, 'child' | 'parent' | 'retry'>
  ) => {
    if (closed.current) return
    const candidate = ++requestId.current
    setLoading(true)
    setError('')
    setListing(null)
    setRetryPath(path)

    const result = await requestDirectory(path, source, candidate, root)
    if (result.status === 'suppressed') return
    if (result.status === 'failure') {
      setError(errorMessage(result.reason))
      setLoading(false)
      return
    }

    setListing(result.value)
    setRetryPath(result.value.path)
    setLoading(false)
  }, [requestDirectory, root])

  const initialize = useCallback(async (
    source: Extract<WorkspaceRequestSource, 'initial' | 'retry'>
  ) => {
    if (closed.current) return
    const candidate = ++requestId.current
    setRoot(null)
    setListing(null)
    setLoading(true)
    setError('')
    setRetryPath(null)

    const rootResult = await requestWorkspaceRoot(candidate, source)
    if (rootResult.status === 'suppressed') return
    if (rootResult.status === 'failure') {
      setError(errorMessage(rootResult.reason))
      setLoading(false)
      return
    }

    const workspaceRoot = rootResult.value
    const initialResult = await requestDirectory(
      initialPath,
      source,
      candidate,
      workspaceRoot,
      rootResult.operationId
    )
    if (initialResult.status === 'suppressed') return

    let listingResult: WorkspaceRequestResult<WorkspaceListing> = initialResult
    if (initialResult.status === 'failure' && initialPath !== workspaceRoot.path) {
      logger.warn({
        category: 'workspace',
        event: 'directory.initial_fallback',
        message: 'Initial workspace path failed; falling back to the canonical root',
        operationId: initialResult.operationId,
        parentOperationId: rootResult.operationId,
        details: {
          requestId: candidate,
          source,
          requestedPath: initialPath,
          fallbackPath: workspaceRoot.path,
          rootPath: workspaceRoot.path,
          volumeLabel: workspaceRoot.label,
          nativeFailure: initialResult.reason
        }
      })
      listingResult = await requestDirectory(
        workspaceRoot.path,
        'fallback',
        candidate,
        workspaceRoot,
        initialResult.operationId
      )
      if (listingResult.status === 'suppressed') return
    }

    setRoot(workspaceRoot)
    if (listingResult.status === 'failure') {
      setRetryPath(workspaceRoot.path)
      setError(errorMessage(listingResult.reason))
      setLoading(false)
      return
    }

    setListing(listingResult.value)
    setRetryPath(listingResult.value.path)
    setLoading(false)
  }, [initialPath, logger, requestDirectory, requestWorkspaceRoot])

  useEffect(() => {
    logger.info({
      category: 'workspace',
      event: 'picker.opened',
      message: 'Opened the workspace directory picker',
      details: { initialPath: initialPathAtOpen.current, purpose }
    })

    return () => {
      const reason = closeReason.current
      closed.current = true
      requestId.current += 1
      logger.info({
        category: 'workspace',
        event: reason === 'open' ? 'picker.unmounted_externally' : 'picker.unmounted',
        message: reason === 'open'
          ? 'Workspace directory picker was unmounted by its owner'
          : 'Workspace directory picker was unmounted',
        details: {
          initialPath: initialPathAtOpen.current,
          closeReason: reason === 'open' ? 'external' : reason,
          lastRequestId: requestId.current,
          purpose
        }
      })
    }
  }, [logger, purpose])

  useEffect(() => {
    closed.current = false
    closeReason.current = 'open'
    void initialize('initial')
    return () => {
      requestId.current += 1
    }
  }, [initialize])

  const cancel = useCallback((source: 'button' | 'android-back') => {
    if (closed.current) return
    closed.current = true
    closeReason.current = 'cancelled'
    requestId.current += 1
    logger.info({
      category: 'workspace',
      event: 'picker.cancelled',
      message: 'Cancelled workspace directory selection',
      details: {
        source,
        path: listing?.path,
        loading,
        hadError: error.length > 0
      }
    })
    onCancel()
  }, [error.length, listing?.path, loading, logger, onCancel])

  const select = useCallback(() => {
    if (closed.current || loading || listing === null || !listing.writable) {
      logger.warn({
        category: 'workspace',
        event: 'picker.selection_rejected',
        message: 'Rejected an unavailable workspace-directory selection',
        details: {
          closed: closed.current,
          loading,
          canonicalPath: listing?.path,
          writable: listing?.writable
        }
      })
      return
    }
    closed.current = true
    closeReason.current = 'selected'
    requestId.current += 1
    logger.info({
      category: 'workspace',
      event: 'picker.directory_selected',
      message: 'Selected a workspace directory',
      details: {
        canonicalPath: listing.path,
        rootPath: listing.rootPath,
        parentPath: listing.parentPath,
        writable: listing.writable
      }
    })
    onSelect(listing.path)
  }, [listing, loading, logger, onSelect])

  const retry = useCallback(() => {
    logger.info({
      category: 'workspace',
      event: 'directory.retry_requested',
      message: 'Retrying a workspace-directory request',
      details: { requestedPath: retryPath ?? initialPath }
    })
    if (retryPath === null) void initialize('retry')
    else void loadDirectory(retryPath, 'retry')
  }, [initialPath, initialize, loadDirectory, logger, retryPath])

  const openLogs = useCallback(() => {
    Keyboard.dismiss()
    logger.info({
      category: 'workspace',
      event: 'picker.logs_opened',
      message: 'Opened Logs from the workspace directory picker',
      details: { path: listing?.path, loading, hadError: error.length > 0 }
    })
    onOpenLogs()
  }, [error.length, listing?.path, loading, logger, onOpenLogs])

  const canUseCurrentFolder = listing !== null && listing.writable && !loading
  const currentPath = listing?.path

  return (
    <Modal
      animationType="slide"
      onRequestClose={() => { cancel('android-back') }}
      presentationStyle="fullScreen"
      visible
    >
      <SafeAreaView
        accessibilityViewIsModal
        style={styles.screen}
        testID="workspace-directory-picker"
      >
        <View style={styles.header}>
          <View style={styles.titleBlock}>
            <Text accessibilityRole="header" style={styles.title}>
              {purpose === 'config' ? 'Choose Codey config folder' : 'Choose workspace'}
            </Text>
            <Text style={styles.subtitle}>
              {root === null ? 'Shared storage' : `${root.label} · ${root.path}`}
            </Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable
              accessibilityLabel="Open Logs"
              accessibilityRole="button"
              onPress={openLogs}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              testID="workspace-directory-logs"
            >
              <Text style={styles.secondaryButtonText}>Logs</Text>
            </Pressable>
            <Pressable
              accessibilityLabel={purpose === 'config'
                ? 'Cancel config folder selection'
                : 'Cancel workspace selection'}
              accessibilityRole="button"
              onPress={() => { cancel('button') }}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              testID="workspace-directory-cancel"
            >
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.locationBar}>
          <Pressable
            accessibilityLabel="Go to parent folder"
            accessibilityRole="button"
            accessibilityState={{ disabled: loading || listing?.parentPath === undefined }}
            disabled={loading || listing?.parentPath === undefined}
            onPress={() => {
              if (listing?.parentPath !== undefined) {
                void loadDirectory(listing.parentPath, 'parent')
              }
            }}
            style={({ pressed }) => [
              styles.upButton,
              (loading || listing?.parentPath === undefined) && styles.disabled,
              pressed && styles.pressed
            ]}
            testID="workspace-directory-up"
          >
            <Text style={styles.upButtonText}>Up</Text>
          </Pressable>
          <View style={styles.pathBlock}>
            <Text style={styles.pathLabel}>Current folder</Text>
            <Text
              numberOfLines={2}
              selectable
              style={styles.path}
              testID="workspace-directory-current-path"
            >
              {currentPath ?? '—'}
            </Text>
          </View>
        </View>

        <View style={styles.content}>
          {loading ? (
            <View
              accessibilityLiveRegion="polite"
              style={styles.centeredState}
              testID="workspace-directory-loading"
            >
              <ActivityIndicator color="#7aa2f7" size="large" />
              <Text style={styles.stateTitle}>Loading folders…</Text>
            </View>
          ) : error.length > 0 ? (
            <View style={styles.centeredState} testID="workspace-directory-error">
              <Text accessibilityRole="alert" style={styles.errorTitle}>Could not load folders</Text>
              <Text style={styles.errorMessage}>{error}</Text>
              <Pressable
                accessibilityLabel={purpose === 'config'
                  ? 'Retry loading config folders'
                  : 'Retry loading workspace folders'}
                accessibilityRole="button"
                onPress={retry}
                style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
                testID="workspace-directory-retry"
              >
                <Text style={styles.retryButtonText}>Retry</Text>
              </Pressable>
            </View>
          ) : listing !== null ? (
            <FlatList<WorkspaceDirectory>
              contentContainerStyle={[
                styles.directoryListContent,
                listing.directories.length === 0 && styles.emptyListContent
              ]}
              data={listing.directories}
              keyExtractor={(directory) => directory.path}
              renderItem={({ item }) => (
                <Pressable
                  accessibilityLabel={item.writable
                    ? `Open folder ${item.name}`
                    : `Open folder ${item.name}, read-only`}
                  accessibilityRole="button"
                  onPress={() => { void loadDirectory(item.path, 'child') }}
                  style={({ pressed }) => [styles.directoryRow, pressed && styles.pressed]}
                  testID={`workspace-directory-row-${item.path}`}
                >
                  <View style={styles.folderMark} />
                  <Text numberOfLines={2} style={styles.directoryName}>{item.name}</Text>
                  {!item.writable ? <Text style={styles.readOnlyLabel}>Read-only</Text> : null}
                </Pressable>
              )}
              ListEmptyComponent={(
                <View
                  accessibilityLiveRegion="polite"
                  style={styles.centeredState}
                  testID="workspace-directory-empty"
                >
                  <Text style={styles.stateTitle}>No folders here</Text>
                  <Text style={styles.stateMessage}>Use this folder, go up, or cancel.</Text>
                </View>
              )}
              style={styles.directoryList}
              testID="workspace-directory-list"
            />
          ) : null}
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerHint}>
            Choosing a folder changes the path only. It does not start NeoVim.
          </Text>
          <Pressable
            accessibilityLabel={purpose === 'config'
              ? 'Use current folder as Codey config folder'
              : 'Use current folder as workspace'}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canUseCurrentFolder }}
            disabled={!canUseCurrentFolder}
            onPress={select}
            style={({ pressed }) => [
              styles.useButton,
              !canUseCurrentFolder && styles.disabled,
              pressed && styles.pressed
            ]}
            testID="workspace-directory-use"
          >
            <Text style={styles.useButtonText}>
              {purpose === 'config' ? 'Use config folder' : 'Use this folder'}
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </Modal>
  )
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim().length > 0) return reason.message
  if (typeof reason === 'object' && reason !== null) {
    const message = (reason as { readonly message?: unknown }).message
    if (typeof message === 'string' && message.trim().length > 0) return message
  }
  if (typeof reason === 'string' && reason.trim().length > 0) return reason
  return 'Unable to read this workspace directory.'
}

function listingDiagnosticDetails(
  listing: WorkspaceListing,
  requestId: number,
  source: WorkspaceRequestSource,
  requestedPath: string,
  workspaceRoot: WorkspaceRoot | null
) {
  const readOnlyDirectoryCount = listing.directories.reduce(
    (count, directory) => count + (directory.writable ? 0 : 1),
    0
  )
  return {
    requestId,
    source,
    requestedPath,
    canonicalPath: listing.path,
    rootPath: listing.rootPath,
    parentPath: listing.parentPath,
    volumeLabel: workspaceRoot?.label,
    writable: listing.writable,
    directoryCount: listing.directories.length,
    writableDirectoryCount: listing.directories.length - readOnlyDirectoryCount,
    readOnlyDirectoryCount,
    rawListing: listing
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0b0e12'
  },
  header: {
    minHeight: 68,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#27303a'
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  title: {
    color: '#eef4fa',
    fontSize: 20,
    fontWeight: '700'
  },
  subtitle: {
    color: '#9eabb8',
    fontSize: 13
  },
  locationBar: {
    minHeight: 72,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#10151b',
    borderBottomWidth: 1,
    borderBottomColor: '#27303a'
  },
  pathBlock: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  pathLabel: {
    color: '#7f8c99',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase'
  },
  path: {
    color: '#d8e1ea',
    fontSize: 15,
    lineHeight: 20
  },
  content: {
    flex: 1,
    minHeight: 0
  },
  directoryList: {
    flex: 1
  },
  directoryListContent: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8
  },
  emptyListContent: {
    flexGrow: 1
  },
  directoryRow: {
    minHeight: 56,
    paddingHorizontal: 14,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: '#27303a',
    borderRadius: 8,
    backgroundColor: '#151b22'
  },
  folderMark: {
    width: 18,
    height: 14,
    borderWidth: 2,
    borderColor: '#7aa2f7',
    borderRadius: 2,
    backgroundColor: '#202b3b'
  },
  directoryName: {
    flex: 1,
    minWidth: 0,
    color: '#e7edf3',
    fontSize: 16,
    fontWeight: '600'
  },
  readOnlyLabel: {
    color: '#d6a85f',
    fontSize: 12,
    fontWeight: '600'
  },
  centeredState: {
    flex: 1,
    minHeight: 160,
    padding: 24,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10
  },
  stateTitle: {
    color: '#d8e1ea',
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center'
  },
  stateMessage: {
    color: '#9eabb8',
    fontSize: 14,
    textAlign: 'center'
  },
  errorTitle: {
    color: '#ff9e9e',
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center'
  },
  errorMessage: {
    maxWidth: 560,
    color: '#c5ced7',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center'
  },
  footer: {
    minHeight: 72,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    borderTopWidth: 1,
    borderTopColor: '#27303a',
    backgroundColor: '#10151b'
  },
  footerHint: {
    flex: 1,
    color: '#9eabb8',
    fontSize: 13
  },
  secondaryButton: {
    minWidth: 76,
    minHeight: 48,
    paddingHorizontal: 14,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#303946',
    borderRadius: 8,
    backgroundColor: '#24283b'
  },
  secondaryButtonText: {
    color: '#c0caf5',
    fontSize: 14,
    fontWeight: '700'
  },
  upButton: {
    minWidth: 64,
    minHeight: 48,
    paddingHorizontal: 14,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#303946',
    borderRadius: 8,
    backgroundColor: '#24283b'
  },
  upButtonText: {
    color: '#c0caf5',
    fontSize: 14,
    fontWeight: '700'
  },
  retryButton: {
    minWidth: 96,
    minHeight: 48,
    paddingHorizontal: 16,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: '#7aa2f7'
  },
  retryButtonText: {
    color: '#0b0e12',
    fontSize: 14,
    fontWeight: '800'
  },
  useButton: {
    minWidth: 156,
    minHeight: 48,
    paddingHorizontal: 16,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: '#9ece6a'
  },
  useButtonText: {
    color: '#0b0e12',
    fontSize: 14,
    fontWeight: '800'
  },
  disabled: {
    opacity: 0.38
  },
  pressed: {
    opacity: 0.72
  }
})
