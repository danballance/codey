import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
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

type WorkspaceRoot = Awaited<ReturnType<typeof getNativeWorkspaceRoot>>
type WorkspaceListing = Awaited<ReturnType<typeof listNativeWorkspaceDirectory>>
type WorkspaceDirectory = WorkspaceListing['directories'][number]

export interface WorkspaceDirectoryPickerProps {
  readonly initialPath: string
  readonly onCancel: () => void
  readonly onSelect: (path: string) => void
}

export function WorkspaceDirectoryPicker({
  initialPath,
  onCancel,
  onSelect
}: WorkspaceDirectoryPickerProps) {
  const requestId = useRef(0)
  const closed = useRef(false)
  const [root, setRoot] = useState<WorkspaceRoot | null>(null)
  const [listing, setListing] = useState<WorkspaceListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retryPath, setRetryPath] = useState<string | null>(null)

  const isCurrentRequest = useCallback(
    (candidate: number) => !closed.current && candidate === requestId.current,
    []
  )

  const loadDirectory = useCallback(async (path: string) => {
    if (closed.current) return
    const candidate = ++requestId.current
    setLoading(true)
    setError('')
    setListing(null)
    setRetryPath(path)

    try {
      const nextListing = await listNativeWorkspaceDirectory(path)
      if (!isCurrentRequest(candidate)) return
      setListing(nextListing)
      setRetryPath(nextListing.path)
      setLoading(false)
    } catch (reason) {
      if (!isCurrentRequest(candidate)) return
      setError(errorMessage(reason))
      setLoading(false)
    }
  }, [isCurrentRequest])

  const initialize = useCallback(async () => {
    if (closed.current) return
    const candidate = ++requestId.current
    setRoot(null)
    setListing(null)
    setLoading(true)
    setError('')
    setRetryPath(null)

    let workspaceRoot: WorkspaceRoot | null = null
    try {
      workspaceRoot = await getNativeWorkspaceRoot()
      if (!isCurrentRequest(candidate)) return

      let initialFailure: unknown
      let nextListing: WorkspaceListing
      try {
        nextListing = await listNativeWorkspaceDirectory(initialPath)
      } catch (reason) {
        initialFailure = reason
        if (!isCurrentRequest(candidate)) return
        if (initialPath === workspaceRoot.path) throw reason
        nextListing = await listNativeWorkspaceDirectory(workspaceRoot.path)
      }
      if (!isCurrentRequest(candidate)) return

      setRoot(workspaceRoot)
      setListing(nextListing)
      setRetryPath(nextListing.path)
      setLoading(false)
      // Retain no warning when the requested path was stale or invalid and the
      // canonical shared-storage root loaded successfully.
      void initialFailure
    } catch (reason) {
      if (!isCurrentRequest(candidate)) return
      setRoot(workspaceRoot)
      setRetryPath(workspaceRoot?.path ?? null)
      setError(errorMessage(reason))
      setLoading(false)
    }
  }, [initialPath, isCurrentRequest])

  useEffect(() => {
    closed.current = false
    void initialize()
    return () => {
      closed.current = true
      requestId.current += 1
    }
  }, [initialize])

  const cancel = useCallback(() => {
    if (closed.current) return
    closed.current = true
    requestId.current += 1
    onCancel()
  }, [onCancel])

  const select = useCallback(() => {
    if (closed.current || loading || listing === null || !listing.writable) return
    closed.current = true
    requestId.current += 1
    onSelect(listing.path)
  }, [listing, loading, onSelect])

  const retry = useCallback(() => {
    if (retryPath === null) void initialize()
    else void loadDirectory(retryPath)
  }, [initialize, loadDirectory, retryPath])

  const canUseCurrentFolder = listing !== null && listing.writable && !loading
  const currentPath = listing?.path

  return (
    <Modal
      animationType="slide"
      onRequestClose={cancel}
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
            <Text accessibilityRole="header" style={styles.title}>Choose workspace</Text>
            <Text style={styles.subtitle}>
              {root === null ? 'Shared storage' : `${root.label} · ${root.path}`}
            </Text>
          </View>
          <Pressable
            accessibilityLabel="Cancel workspace selection"
            accessibilityRole="button"
            onPress={cancel}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
            testID="workspace-directory-cancel"
          >
            <Text style={styles.secondaryButtonText}>Cancel</Text>
          </Pressable>
        </View>

        <View style={styles.locationBar}>
          <Pressable
            accessibilityLabel="Go to parent folder"
            accessibilityRole="button"
            accessibilityState={{ disabled: loading || listing?.parentPath === undefined }}
            disabled={loading || listing?.parentPath === undefined}
            onPress={() => {
              if (listing?.parentPath !== undefined) void loadDirectory(listing.parentPath)
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
                accessibilityLabel="Retry loading workspace folders"
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
                  onPress={() => { void loadDirectory(item.path) }}
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
            accessibilityLabel="Use current folder as workspace"
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
            <Text style={styles.useButtonText}>Use this folder</Text>
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
