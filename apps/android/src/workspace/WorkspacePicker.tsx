import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { diagnosticLogger, type DiagnosticLogger } from '../diagnostics/logger'
import {
  getNativeRepositoryClone,
  type NativeRepositoryCloneModule,
  type NativeSubscription
} from '../native/nvim'
import {
  cloneDestinationPath,
  normalizeGitHubRepository,
  validateCloneDirectoryName
} from './github-repository'
import { WorkspaceDirectoryPicker } from './WorkspaceDirectoryPicker'

export interface WorkspacePickerProps {
  readonly initialPath: string
  readonly onCancel: () => void
  readonly onOpenLogs: () => void
  /** Called only for an existing folder selection or a successfully completed clone. */
  readonly onSelect: (path: string) => void
  /** True while native cloning or cancellation is in progress. */
  readonly onBusyChange?: (busy: boolean) => void
  readonly module?: NativeRepositoryCloneModule
  readonly logger?: DiagnosticLogger
}

type Mode = 'source' | 'existing' | 'clone' | 'parent'
interface ActiveClone {
  readonly id: string
  readonly module: NativeRepositoryCloneModule
  readonly subscription: NativeSubscription
  readonly logger: DiagnosticLogger
  readonly repositoryUrl: string
  readonly parentPath: string
  readonly directoryName: string
  readonly startedAt: number
  cancelRequested: boolean
}

let nextOperation = 0
const MAX_MESSAGE_LENGTH = 2_000

export function WorkspacePicker({
  initialPath,
  onCancel,
  onOpenLogs,
  onSelect,
  onBusyChange,
  module: injectedModule,
  logger = diagnosticLogger
}: WorkspacePickerProps) {
  const moduleRef = useRef(injectedModule)
  const [mode, setMode] = useState<Mode>('source')
  const [repository, setRepository] = useState('')
  const [directoryName, setDirectoryName] = useState('')
  const nameEdited = useRef(false)
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [phase, setPhase] = useState<'idle' | 'cloning' | 'cancelling'>('idle')
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const active = useRef<ActiveClone | null>(null)
  const busyCallback = useRef(onBusyChange)
  const selectionCallback = useRef(onSelect)
  const cancelCallback = useRef(onCancel)
  busyCallback.current = onBusyChange
  selectionCallback.current = onSelect
  cancelCallback.current = onCancel

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const operation = active.current
      if (operation === null) return
      logClone(operation, 'unmounted', 'Repository clone form was unmounted')
      if (!operation.cancelRequested) {
        logClone(operation, 'cancel_requested', 'Cancelling repository clone after form unmount', { source: 'unmount' })
      }
      operation.cancelRequested = true
      operation.subscription.remove()
      void operation.module.cancelRepositoryClone(operation.id).then(() => {
        finish(operation, 'cancelled')
      }).catch(() => {
        // The terminal clone result still releases busy state if cancellation fails.
      })
    }
  }, [])

  function finish(operation: ActiveClone, outcome: 'succeeded' | 'failed' | 'cancelled', details?: Record<string, unknown>): boolean {
    if (active.current !== operation) return false
    const message = outcome === 'succeeded' ? 'Repository clone completed'
      : outcome === 'cancelled' ? 'Repository clone cancellation completed' : 'Repository clone failed'
    logClone(operation, outcome, message, details, outcome === 'failed')
    active.current = null
    operation.subscription.remove()
    busyCallback.current?.(false)
    if (mounted.current) setPhase('idle')
    return mounted.current
  }

  async function cancel() {
    const operation = active.current
    if (operation === null) {
      onCancel()
      return
    }
    if (operation.cancelRequested) return
    logClone(operation, 'cancel_requested', 'Repository clone cancellation requested', { source: 'user' })
    operation.cancelRequested = true
    setPhase('cancelling')
    setError('')
    try {
      await operation.module.cancelRepositoryClone(operation.id)
      if (finish(operation, 'cancelled')) cancelCallback.current()
    } catch {
      if (!mounted.current || active.current !== operation) return
      logClone(operation, 'cancel_failed', 'Unable to cancel repository clone; user can retry', undefined, true)
      operation.cancelRequested = false
      setPhase('cloning')
      setError('Could not cancel the clone. Try Cancel again.')
    }
  }

  function changeRepository(value: string) {
    setRepository(value)
    setError('')
    if (nameEdited.current) return
    try {
      setDirectoryName(normalizeGitHubRepository(value).name)
    } catch {
      setDirectoryName('')
    }
  }

  async function clone() {
    if (active.current !== null) return
    let url: string
    let name: string
    try {
      url = normalizeGitHubRepository(repository).url
      name = validateCloneDirectoryName(directoryName)
      if (parentPath === null) throw new Error('Choose a parent folder for the repository.')
    } catch (reason) {
      logger.warn({ category: 'workspace', event: 'repository_clone.input_rejected',
        message: 'Repository clone input was rejected' })
      setError(reason instanceof Error ? reason.message : 'Check the repository and destination.')
      return
    }
    Keyboard.dismiss()
    const id = `repository-${Date.now()}-${++nextOperation}`
    let module: NativeRepositoryCloneModule
    let subscription: NativeSubscription
    try {
      module = moduleRef.current ?? getNativeRepositoryClone()
      moduleRef.current = module
      subscription = module.addListener('repositoryCloneProgress', (event) => {
        if (!mounted.current || active.current?.id !== event.operationId) return
        setProgress(event.message.slice(-MAX_MESSAGE_LENGTH))
      })
    } catch {
      logger.error({ category: 'workspace', event: 'repository_clone.start_failed', operationId: id,
        message: 'Unable to prepare the native repository clone bridge',
        details: { repositoryUrl: url, parentPath, directoryName: name } })
      setError('Could not start cloning. Try again.')
      return
    }
    const operation: ActiveClone = { id, module, subscription, logger, repositoryUrl: url,
      parentPath, directoryName: name, startedAt: Date.now(), cancelRequested: false }
    active.current = operation
    logClone(operation, 'started', 'Cloning public GitHub repository into a new local folder')
    setError('')
    setProgress('Preparing Git…')
    setPhase('cloning')
    busyCallback.current?.(true)
    try {
      const result = await module.cloneRepository(id, url, parentPath, name)
      const outcome = operation.cancelRequested || result.status === 'cancelled' ? 'cancelled'
        : result.status === 'success' ? 'succeeded' : 'failed'
      if (!finish(operation, outcome, result.status === 'success' ? { path: result.path }
        : result.status === 'error' ? { code: result.code } : undefined)) return
      if (operation.cancelRequested || result.status === 'cancelled') {
        cancelCallback.current()
      } else if (result.status === 'success') {
        selectionCallback.current(result.path)
      } else {
        setError(result.message.slice(-MAX_MESSAGE_LENGTH))
      }
    } catch {
      if (!finish(operation, operation.cancelRequested ? 'cancelled' : 'failed', { code: 'E_CLONE_BRIDGE' })) return
      if (operation.cancelRequested) cancelCallback.current()
      else setError('Could not clone the repository. Check your connection and try again.')
    }
  }

  if (mode === 'existing') {
    return <WorkspaceDirectoryPicker initialPath={initialPath} onCancel={onCancel}
      onOpenLogs={onOpenLogs} onSelect={onSelect} />
  }
  if (mode === 'parent') {
    return <WorkspaceDirectoryPicker initialPath={parentPath ?? initialPath}
      onCancel={() => setMode('clone')} onOpenLogs={onOpenLogs} purpose="clone-destination"
      onSelect={(path) => { setParentPath(path); setMode('clone'); setError('') }} />
  }

  const busy = phase !== 'idle'
  const preview = parentPath !== null && directoryName.trim().length > 0
    ? cloneDestinationPath(parentPath, directoryName.trim()) : null
  return (
    <Modal animationType="slide" onRequestClose={() => { void cancel() }}
      presentationStyle="fullScreen" visible>
      <SafeAreaView accessibilityViewIsModal style={styles.screen} testID="workspace-picker">
        <KeyboardAvoidingView behavior="height" style={styles.screen}>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>
              {mode === 'source' ? 'Set workspace' : 'Clone GitHub repository'}
            </Text>
            <View style={styles.headerActions}>
              <Pressable accessibilityLabel="Open Logs" accessibilityRole="button"
                onPress={() => { Keyboard.dismiss(); onOpenLogs() }} style={styles.secondaryButton}>
                <Text style={styles.buttonText}>Logs</Text>
              </Pressable>
              <Pressable accessibilityLabel={busy ? 'Cancel repository clone' : 'Cancel workspace selection'}
                accessibilityRole="button" disabled={phase === 'cancelling'}
                accessibilityState={{ disabled: phase === 'cancelling' }}
                onPress={() => { void cancel() }} style={[styles.secondaryButton, phase === 'cancelling' && styles.disabled]}>
                <Text style={styles.buttonText}>{phase === 'cancelling' ? 'Cancelling…' : 'Cancel'}</Text>
              </Pressable>
            </View>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            {mode === 'source' ? <>
              <Text style={styles.hint}>Choose a folder on this device or clone a public GitHub repository.</Text>
              <Pressable accessibilityLabel="Choose existing folder" accessibilityRole="button" onPress={() => setMode('existing')} style={styles.sourceButton}>
                <Text style={styles.sourceTitle}>Choose existing folder</Text>
                <Text style={styles.hint}>Use code already on this device.</Text>
              </Pressable>
              <Pressable accessibilityLabel="Clone GitHub repository" accessibilityRole="button" onPress={() => setMode('clone')} style={styles.sourceButton}>
                <Text style={styles.sourceTitle}>Clone GitHub repository</Text>
                <Text style={styles.hint}>Download a repository into a new local folder.</Text>
              </Pressable>
            </> : <>
              <Text style={styles.hint}>Public repositories only. The repository’s default branch and history will be downloaded.</Text>
              <Text style={styles.label}>GitHub repository</Text>
              <TextInput accessibilityLabel="GitHub repository" autoCapitalize="none" autoCorrect={false}
                editable={!busy} onChangeText={changeRepository} placeholder="owner/repository or https://github.com/owner/repository"
                placeholderTextColor="#7f8c99" style={styles.input} value={repository} />
              <Text style={styles.label}>Folder name</Text>
              <TextInput accessibilityLabel="Repository folder name" autoCapitalize="none" autoCorrect={false}
                editable={!busy} onChangeText={(value) => { nameEdited.current = true; setDirectoryName(value); setError('') }}
                placeholder="repository" placeholderTextColor="#7f8c99" style={styles.input} value={directoryName} />
              <Text style={styles.label}>Parent folder</Text>
              <Text selectable style={styles.path}>{parentPath ?? 'Choose where to save the repository.'}</Text>
              <Pressable accessibilityRole="button" disabled={busy} accessibilityState={{ disabled: busy }}
                onPress={() => setMode('parent')} style={[styles.secondaryButton, styles.fitButton, busy && styles.disabled]}>
                <Text style={styles.buttonText}>{parentPath === null ? 'Choose parent folder' : 'Change parent folder'}</Text>
              </Pressable>
              {preview !== null ? <View style={styles.preview}>
                <Text style={styles.label}>Repository destination</Text>
                <Text selectable style={styles.path} testID="repository-destination">{preview}</Text>
                <Text style={styles.hint}>A new folder will be created. Existing folders will not be replaced.</Text>
              </View> : null}
              {busy ? <View accessibilityLiveRegion="polite" style={styles.progress}>
                <ActivityIndicator color="#7aa2f7" />
                <Text style={styles.path}>{phase === 'cancelling' ? 'Cancelling and cleaning up…' : 'Cloning repository…'}</Text>
                <Text numberOfLines={8} selectable style={styles.hint} testID="repository-clone-progress">{progress}</Text>
              </View> : null}
              {error.length > 0 ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
              <Pressable accessibilityRole="button" accessibilityLabel={error.length > 0 && !busy ? 'Retry clone' : 'Clone repository'}
                disabled={busy} accessibilityState={{ disabled: busy }} onPress={() => { void clone() }}
                style={[styles.primaryButton, busy && styles.disabled]}>
                <Text style={styles.primaryText}>{error.length > 0 && !busy ? 'Retry clone' : 'Clone repository'}</Text>
              </Pressable>
              <Text style={styles.hint}>A successful clone sets the workspace. Start Neovim when you are ready.</Text>
            </>}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  )
}

function logClone(
  operation: ActiveClone,
  event: string,
  message: string,
  details?: Record<string, unknown>,
  failed = false
) {
  operation.logger[failed ? 'error' : 'info']({
    category: 'workspace',
    event: `repository_clone.${event}`,
    operationId: operation.id,
    message,
    durationMs: Math.max(0, Date.now() - operation.startedAt),
    details: {
      repositoryUrl: operation.repositoryUrl,
      parentPath: operation.parentPath,
      directoryName: operation.directoryName,
      ...details
    }
  })
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b0e12' },
  header: { minHeight: 68, padding: 16, gap: 12, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#27303a' },
  title: { flex: 1, color: '#eef4fa', fontSize: 20, fontWeight: '700' },
  headerActions: { flexDirection: 'row', gap: 8 },
  content: { padding: 20, gap: 12, width: '100%', maxWidth: 800, alignSelf: 'center' },
  sourceButton: { padding: 20, borderRadius: 8, borderWidth: 1, borderColor: '#27303a', backgroundColor: '#151b22', gap: 6 },
  sourceTitle: { color: '#e7edf3', fontSize: 18, fontWeight: '600' },
  hint: { color: '#9eabb8', fontSize: 14, lineHeight: 20 },
  label: { color: '#d8e1ea', fontSize: 14, fontWeight: '600' },
  path: { color: '#d8e1ea', fontSize: 15, lineHeight: 21 },
  input: { backgroundColor: '#151b22', borderWidth: 1, borderColor: '#354150', borderRadius: 6, color: '#eef4fa', minHeight: 46, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  secondaryButton: { minHeight: 42, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: '#202b3b', borderRadius: 6, justifyContent: 'center' },
  fitButton: { alignSelf: 'flex-start' },
  buttonText: { color: '#e7edf3', fontSize: 14, fontWeight: '600' },
  primaryButton: { minHeight: 48, padding: 14, backgroundColor: '#7aa2f7', borderRadius: 6, alignItems: 'center' },
  primaryText: { color: '#0b0e12', fontSize: 16, fontWeight: '700' },
  preview: { backgroundColor: '#151b22', padding: 14, borderRadius: 6, gap: 8 },
  progress: { paddingVertical: 10, gap: 8 },
  error: { color: '#ff9e9e', fontSize: 14, lineHeight: 20 },
  disabled: { opacity: 0.5 }
})
