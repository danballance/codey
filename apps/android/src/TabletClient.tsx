import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import {
  createPerformanceInputSample,
  performanceDiagnosticsEnabled,
  performanceNow,
  recordPerformance,
  withPerformanceTags,
  type PerformanceInputSample,
  type PerformanceTags
} from '@codey/perf'

import {
  ACTION_PAD_LONG_PRESS_MS,
  ActionPad,
  ActionPadStatusBar,
  type ActionPadButtonTarget,
  type ActionPadNavigationContext
} from './action-pad'
import {
  ActionPadEditor,
  type ActionPadEditorPendingEdits
} from './action-pad/ActionPadEditor'
import { resolveActionPadConfig, type ActionPadConfig } from './action-pad/document'
import { ActionPadConfigStore } from './action-pad/store'
import { connectionSettingsStore } from './connection-settings-store'
import {
  actionPadPathForSettings,
  createLocalConnectionSettings,
  DEFAULT_WORKSPACE_PATH,
  requireConfigDirectory
} from './local-connection-settings'
import { TabletClientController } from './controller'
import { EditorCanvas } from './editor/EditorCanvas'
import { gridSizeForBounds, type GridCellPosition } from './grid'
import {
  committedTextToNvimInput,
  specialKeyToNvimInput
} from './input'
import {
  CodeyIme,
  type CodeyImeEventMetadata,
  type CodeyImeHandle,
  type CodeyImeKeyEvent,
  type CodeyImeOrderedInputEvent
} from './native/CodeyIme'
import {
  getNativeNvimStatus,
  openNativeNvimAllFilesSettings,
  type NativeNvimStatus
} from './native/nvim'
import { createRuntimeConnection } from './runtime-connection'
import { diagnosticLogger, diagnosticUtf8ByteLength } from './diagnostics/logger'
import type { TabletCapability } from './tablet'
import { WorkspaceDirectoryPicker } from './workspace/WorkspaceDirectoryPicker'

interface TabletClientProps {
  readonly capability: TabletCapability
  readonly logsVisible: boolean
  readonly onOpenLogs: () => void
}

interface CanvasBounds {
  readonly width: number
  readonly height: number
}

interface PendingActionInput {
  readonly kind: 'action'
  readonly startedAtMs: number
  readonly inputLength: number
  readonly firstKeyAfterFocus: boolean
  readonly sample?: PerformanceInputSample
}

interface PendingMouseInput {
  readonly kind: 'mouse'
  readonly position: GridCellPosition
}

interface PendingEditorTransition {
  readonly kind: 'editor-transition'
  readonly resolve: () => void
}

type PendingOrderedInput = PendingActionInput | PendingMouseInput | PendingEditorTransition

interface NativeInputTiming {
  readonly deliveredAtMs?: number
  readonly sample?: PerformanceInputSample
}

const KEYBOARD_COMPACT_THRESHOLD = 120
const ACTION_PAD_WIDTH = 336
const NO_ACTION_PAD_EDITOR_PENDING_EDITS: ActionPadEditorPendingEdits = {
  fieldEdits: false
}

export function TabletClient({
  capability,
  logsVisible,
  onOpenLogs
}: TabletClientProps) {
  const [controller] = useState(() => new TabletClientController(
    createRuntimeConnection,
    undefined,
    diagnosticLogger
  ))
  const client = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const [actionPadStore] = useState(() => new ActionPadConfigStore(controller))
  const actionPadState = useSyncExternalStore(actionPadStore.subscribe, actionPadStore.getState, actionPadStore.getState)
  const rootMenu = useMemo(() => resolveActionPadConfig(actionPadState.activeConfig), [actionPadState.activeConfig])
  const [actionPadNavigationContext, setActionPadNavigationContext] = useState<ActionPadNavigationContext>({
    text: ''
  })
  const [selectingActionPad, setSelectingActionPad] = useState(false)
  const selectingActionPadRef = useRef(false)
  const actionPadSelectionVersion = useRef(0)
  const [editingActionPad, setEditingActionPad] = useState(false)
  const [initialActionPadButton, setInitialActionPadButton] = useState<ActionPadButtonTarget>()
  const editingActionPadRef = useRef(false)
  const actionPadPendingEditsRef = useRef<ActionPadEditorPendingEdits>(NO_ACTION_PAD_EDITOR_PENDING_EDITS)
  const openingActionPadEditor = useRef(false)
  const openingLogs = useRef(false)
  const logsVisibleRef = useRef(logsVisible)
  const editControlLongPressTriggered = useRef(false)
  const clientMountedRef = useRef(true)
  const nativeNvimStatusRequest = useRef(0)
  const [workspacePath, setWorkspacePath] = useState(DEFAULT_WORKSPACE_PATH)
  const [configDirectory, setConfigDirectory] = useState('')
  const [connectionSettingsLoaded, setConnectionSettingsLoaded] = useState(false)
  const [nativeNvimStatus, setNativeNvimStatus] = useState<NativeNvimStatus | null>(null)
  const [nativeNvimStatusLoading, setNativeNvimStatusLoading] = useState(true)
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
  const workspacePickerOpenRef = useRef(false)
  const [configPickerOpen, setConfigPickerOpen] = useState(false)
  const configPickerOpenRef = useRef(false)
  const [formError, setFormError] = useState('')
  const [canvasBounds, setCanvasBounds] = useState<CanvasBounds>({ width: 0, height: 0 })
  const [screenHeight, setScreenHeight] = useState(capability.height)
  const imeRef = useRef<CodeyImeHandle>(null)
  const pendingOrderedInputs = useRef<PendingOrderedInput[]>([])
  const orderedDispatchTail = useRef<Promise<void>>(Promise.resolve())
  const orderedDispatchEpoch = useRef(0)
  const firstKeyAfterFocus = useRef(false)

  logsVisibleRef.current = logsVisible
  workspacePickerOpenRef.current = workspacePickerOpen
  configPickerOpenRef.current = configPickerOpen

  useEffect(() => {
    let mounted = true
    clientMountedRef.current = true
    diagnosticLogger.info({
      category: 'app',
      event: 'tablet_client.mounted',
      message: 'Mounted the supported tablet client',
      details: { capability }
    })
    void connectionSettingsStore.load()
      .then((settings) => {
        if (!mounted) return
        setWorkspacePath(settings.workspacePath)
        setConfigDirectory(settings.configDirectory ?? '')
        actionPadStore.selectSource(settings.configDirectory === null
          ? null
          : actionPadPathForSettings(settings))
      })
      .finally(() => {
        if (mounted) setConnectionSettingsLoaded(true)
      })
    return () => {
      mounted = false
      clientMountedRef.current = false
      if (workspacePickerOpenRef.current) {
        diagnosticLogger.info({
          category: 'workspace',
          event: 'picker.unmounted',
          message: 'Workspace picker unmounted with the tablet client',
          details: { reason: 'capability-driven-client-unmount' }
        })
      }
      if (configPickerOpenRef.current) {
        diagnosticLogger.info({
          category: 'workspace',
          event: 'config_picker.unmounted',
          message: 'Config folder picker unmounted with the tablet client',
          details: { reason: 'capability-driven-client-unmount' }
        })
      }
      diagnosticLogger.info({
        category: 'app',
        event: 'tablet_client.unmounted',
        message: 'Unmounted the supported tablet client'
      })
      for (const pending of pendingOrderedInputs.current) {
        if (pending.kind === 'editor-transition') pending.resolve()
      }
      void controller.dispose()
    }
  }, [actionPadStore, controller])

  const refreshNativeNvimStatus = useCallback(async () => {
    const request = ++nativeNvimStatusRequest.current
    const startedAtMs = Date.now()
    diagnosticLogger.debug({
      category: 'device',
      event: 'native_status.requested',
      message: 'Checking native NeoVim capability and file permission',
      details: { requestId: request }
    })
    if (clientMountedRef.current) setNativeNvimStatusLoading(true)
    try {
      const status = await getNativeNvimStatus()
      if (clientMountedRef.current && request === nativeNvimStatusRequest.current) {
        diagnosticLogger.info({
          category: 'device',
          event: 'native_status.received',
          message: 'Native NeoVim status check completed',
          durationMs: Math.max(0, Date.now() - startedAtMs),
          details: { requestId: request, status }
        })
        setNativeNvimStatus(status)
        setNativeNvimStatusLoading(false)
      } else {
        diagnosticLogger.debug({
          category: 'device',
          event: 'native_status.stale_result',
          message: 'Ignored a stale native status result',
          durationMs: Math.max(0, Date.now() - startedAtMs),
          details: { requestId: request, status }
        })
      }
    } catch (reason) {
      // Unit tests, Expo Go, and an ungenerated native project do not have the
      // optional module. Connection startup will still publish a useful error.
      diagnosticLogger.warn({
        category: 'device',
        event: 'native_status.failed',
        message: 'Native NeoVim status check failed',
        durationMs: Math.max(0, Date.now() - startedAtMs),
        details: { requestId: request, reason }
      })
      if (clientMountedRef.current && request === nativeNvimStatusRequest.current) {
        setNativeNvimStatus(null)
        setNativeNvimStatusLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void refreshNativeNvimStatus()
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refreshNativeNvimStatus()
      } else {
        void controller.disconnect()
      }
    })
    return () => subscription.remove()
  }, [controller, refreshNativeNvimStatus])

  const setActionPadSelection = useCallback((selecting: boolean) => {
    selectingActionPadRef.current = selecting
    actionPadSelectionVersion.current += 1
    setSelectingActionPad(selecting)
  }, [])

  useEffect(() => {
    setActionPadSelection(false)
  }, [actionPadState.sourcePath, setActionPadSelection])

  useEffect(() => {
    if (!selectingActionPad || editingActionPad) return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setActionPadSelection(false)
      return true
    })
    return () => subscription.remove()
  }, [editingActionPad, selectingActionPad, setActionPadSelection])

  const onEditorLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout
      setCanvasBounds((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height }
      )
      controller.setGridSize(gridSizeForBounds(width, height))
    },
    [controller]
  )

  const onScreenLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout
    setScreenHeight((previous) => previous === height ? previous : height)
  }, [])

  const grantAllFilesAccess = useCallback(() => {
    setFormError('')
    diagnosticLogger.info({
      category: 'device',
      event: 'all_files_settings.open_requested',
      message: 'Opening Android all-files access settings'
    })
    void openNativeNvimAllFilesSettings()
      .catch((reason: unknown) => {
        diagnosticLogger.error({
          category: 'device',
          event: 'all_files_settings.open_failed',
          message: 'Could not open Android all-files access settings',
          details: { reason }
        })
        setFormError(reason instanceof Error ? reason.message : 'Could not open Android file access settings')
      })
  }, [])

  const startLocalNeovim = useCallback(async (): Promise<void> => {
    setFormError('')
    if (!connectionSettingsLoaded) {
      setFormError('Local settings are still loading.')
      return
    }
    if (nativeNvimStatusLoading) {
      setFormError('Bundled Neovim availability is still being checked.')
      return
    }
    if (nativeNvimStatus?.supported === false) {
      setFormError(nativeNvimStatus.unavailableReason ?? 'Bundled Neovim is unavailable on this device.')
      return
    }
    if (nativeNvimStatus?.supported === true && !nativeNvimStatus.allFilesAccess) {
      grantAllFilesAccess()
      return
    }
    try {
      const settings = createLocalConnectionSettings(
        workspacePath,
        requireConfigDirectory(configDirectory)
      )
      actionPadStore.selectSource(actionPadPathForSettings(settings))
      let settingsSaveFailed = false
      try {
        await connectionSettingsStore.save(settings)
      } catch {
        settingsSaveFailed = true
      }
      await controller.connect(settings)
      if (settingsSaveFailed && clientMountedRef.current && controller.getState().phase !== 'error') {
        setFormError('Neovim is using these folders for this run, but the local settings could not be saved.')
      }
    } catch (reason) {
      diagnosticLogger.warn({
        category: 'connection',
        event: 'settings.rejected',
        message: 'Rejected invalid local Neovim settings',
        details: {
          workspacePathProvided: workspacePath.trim().length > 0,
          configDirectoryProvided: configDirectory.trim().length > 0,
          reason
        }
      })
      setFormError(reason instanceof Error ? reason.message : 'Invalid local Neovim settings')
    }
  }, [
    actionPadStore,
    configDirectory,
    connectionSettingsLoaded,
    controller,
    grantAllFilesAccess,
    nativeNvimStatus,
    nativeNvimStatusLoading,
    workspacePath
  ])

  const toggleConnection = useCallback(() => {
    if (client.phase === 'connected') {
      void controller.disconnect()
      return
    }
    void startLocalNeovim()
  }, [client.phase, controller, startLocalNeovim])

  const submitControllerInput = useCallback(
    (keys: string, tags: PerformanceTags): Promise<void> => {
      if (keys.length === 0) return Promise.resolve()
      recordPerformance('controller_input_entry', { durationMs: 0, tags })
      return withPerformanceTags(tags, () => controller.input(keys))
    },
    [controller]
  )

  const submitCommittedText = useCallback(
    (text: string, metadata?: CodeyImeEventMetadata) => {
      if (editingActionPadRef.current || openingLogs.current || logsVisibleRef.current) return
      if (text.length === 0) return
      const isFirstKeyAfterFocus = consumeFirstKeyAfterFocus(firstKeyAfterFocus)
      const timing = nativeInputTiming(metadata?.receivedAtUptimeMs)
      const tags: PerformanceTags = {
        ...timing.sample,
        source: 'ime',
        inputLength: text.length,
        connectionGeneration: metadata?.connectionGeneration,
        sequence: metadata?.sequence,
        firstKeyAfterFocus: isFirstKeyAfterFocus
      }
      recordPerformance('input_receipt', {
        startedAtMs: timing.sample?.inputStartedAtMs,
        durationMs: 0,
        tags
      })
      recordNativeToJsDelivery(metadata?.receivedAtUptimeMs, tags, timing.deliveredAtMs)
      const keys = committedTextToNvimInput(text)
      void submitControllerInput(keys, tags)
    },
    [submitControllerInput]
  )

  const submitHardwareKey = useCallback(
    (event: CodeyImeKeyEvent) => {
      if (editingActionPadRef.current || openingLogs.current || logsVisibleRef.current) return
      const isFirstKeyAfterFocus = consumeFirstKeyAfterFocus(firstKeyAfterFocus)
      const timing = nativeInputTiming(event.receivedAtUptimeMs)
      const tags: PerformanceTags = {
        ...timing.sample,
        source: 'hardware',
        inputLength: Array.from(event.key).length,
        connectionGeneration: event.connectionGeneration,
        sequence: event.sequence,
        firstKeyAfterFocus: isFirstKeyAfterFocus
      }
      recordPerformance('input_receipt', {
        startedAtMs: timing.sample?.inputStartedAtMs,
        durationMs: 0,
        tags
      })
      recordNativeToJsDelivery(event.receivedAtUptimeMs, tags, timing.deliveredAtMs)
      const keys = specialKeyToNvimInput({
        key: event.key,
        modifiers: {
          ctrl: event.ctrl,
          alt: event.alt,
          shift: event.shift,
          meta: event.meta
        }
      })
      if (keys === null) return
      void submitControllerInput(keys, tags)
    },
    [submitControllerInput]
  )

  const submitOrderedInput = useCallback(
    (event: CodeyImeOrderedInputEvent) => {
      const pending = pendingOrderedInputs.current.shift()
      if (editingActionPadRef.current || logsVisibleRef.current) {
        if (pending?.kind === 'editor-transition') pending.resolve()
        return
      }
      const actionPending = pending?.kind === 'action' ? pending : undefined
      const keys = orderedBatchToNvimInput(event)
      const tags: PerformanceTags = {
        ...actionPending?.sample,
        source: pending?.kind === 'mouse' ? 'ime' : 'action-pad',
        inputLength: keys.length,
        connectionGeneration: event.connectionGeneration,
        sequence: event.sequence,
        segmentCount: event.segments.length,
        firstKeyAfterFocus: actionPending?.firstKeyAfterFocus ?? false
      }
      recordPerformance('native_ime_ordered_dispatch', {
        durationMs: event.nativeDurationMs,
        tags
      })
      if (actionPending !== undefined) {
        recordPerformance('action_pad_to_native_event_delivery', {
          startedAtMs: actionPending.startedAtMs,
          tags: { ...tags, inputLength: actionPending.inputLength }
        })
      }
      recordNativeToJsDelivery(event.receivedAtUptimeMs, tags)
      const dispatchEpoch = orderedDispatchEpoch.current
      const dispatch = orderedDispatchTail.current.then(async () => {
        if (dispatchEpoch !== orderedDispatchEpoch.current) return
        await submitControllerInput(keys, tags)
        if (
          pending?.kind === 'mouse' &&
          dispatchEpoch === orderedDispatchEpoch.current &&
          controller.getState().phase === 'connected'
        ) {
          await controller.inputMouse({
            button: 'left',
            action: 'press',
            modifier: '',
            gridId: 0,
            row: pending.position.row,
            column: pending.position.column
          })
        }
      })
      orderedDispatchTail.current = dispatch.catch(() => undefined)
      if (pending?.kind === 'editor-transition') {
        void orderedDispatchTail.current.then(pending.resolve)
      }
    },
    [controller, submitControllerInput]
  )

  const sendOrderedActionInput = useCallback((keys: string) => {
    if (
      selectingActionPadRef.current || editingActionPadRef.current ||
      openingActionPadEditor.current || openingLogs.current || logsVisibleRef.current
    ) return
    if (keys.length === 0) return
    const startedAtMs = performanceNow()
    const pending = {
      kind: 'action' as const,
      startedAtMs,
      inputLength: keys.length,
      firstKeyAfterFocus: consumeFirstKeyAfterFocus(firstKeyAfterFocus),
      sample: performanceDiagnosticsEnabled()
        ? createPerformanceInputSample(startedAtMs)
        : undefined
    }
    pendingOrderedInputs.current.push(pending)
    recordPerformance('input_receipt', {
      durationMs: 0,
      tags: {
        ...pending.sample,
        source: 'action-pad',
        inputLength: keys.length,
        firstKeyAfterFocus: pending.firstKeyAfterFocus
      }
    })
    void imeRef.current?.sendOrderedInput(keys).catch((reason: unknown) => {
      const index = pendingOrderedInputs.current.indexOf(pending)
      if (index >= 0) pendingOrderedInputs.current.splice(index, 1)
      diagnosticLogger.error({
        category: 'ime',
        event: 'ordered_input.failed',
        message: 'Failed to send ordered Action Pad input through the IME',
        details: {
          inputLength: keys.length,
          byteLength: diagnosticUtf8ByteLength(keys),
          reason
        }
      })
    })
  }, [])

  const submitEditorCellPress = useCallback((position: GridCellPosition) => {
    if (
      editingActionPadRef.current || openingActionPadEditor.current ||
      openingLogs.current || logsVisibleRef.current
    ) return
    const pending: PendingMouseInput = { kind: 'mouse', position }
    pendingOrderedInputs.current.push(pending)
    void imeRef.current?.settleComposition().catch((reason: unknown) => {
      const index = pendingOrderedInputs.current.indexOf(pending)
      if (index >= 0) pendingOrderedInputs.current.splice(index, 1)
      diagnosticLogger.error({
        category: 'ime',
        event: 'mouse_composition_settlement.failed',
        message: 'Failed to settle composition before editor mouse input',
        details: { position, reason }
      })
    })
  }, [])

  const focusKeyboardIme = useCallback(() => {
    if (
      selectingActionPadRef.current || editingActionPadRef.current ||
      openingActionPadEditor.current || openingLogs.current || logsVisibleRef.current
    ) return
    firstKeyAfterFocus.current = true
    void imeRef.current?.focus().then(() => {
      diagnosticLogger.info({
        category: 'ime',
        event: 'focus.completed',
        message: 'Focused the editor IME'
      })
    }).catch((reason: unknown) => {
      diagnosticLogger.error({
        category: 'ime',
        event: 'focus.failed',
        message: 'Failed to focus the editor IME',
        details: { reason }
      })
    })
  }, [])

  const connected = client.phase === 'connected'
  const connecting = client.phase === 'connecting'
  const expanded = capability.layout === 'expanded'
  const compactControls = capability.height - screenHeight >= KEYBOARD_COMPACT_THRESHOLD
  const mode = client.snapshot?.mode.name.toUpperCase() || '—'
  const localNeedsFilesAccess = !connected &&
    nativeNvimStatus?.supported === true &&
    !nativeNvimStatus.allFilesAccess
  const localUnavailable = !connected && nativeNvimStatus?.supported === false
    ? nativeNvimStatus.unavailableReason ?? 'Bundled NeoVim is unavailable on this device'
    : ''
  const workspaceBrowseDisabled = connecting || connected || !connectionSettingsLoaded ||
    nativeNvimStatusLoading ||
    nativeNvimStatus?.supported !== true || !nativeNvimStatus.allFilesAccess
  const configBrowseDisabled = workspaceBrowseDisabled
  const localConfigMissing = !connected && configDirectory.trim().length === 0

  useEffect(() => {
    if (
      (workspacePickerOpen || configPickerOpen) &&
      nativeNvimStatus !== null &&
      (!nativeNvimStatus.supported || !nativeNvimStatus.allFilesAccess)
    ) {
      diagnosticLogger.warn({
        category: 'workspace',
        event: 'picker.permission_closed',
        message: 'Closed the workspace picker because native access is no longer available',
        details: { nativeNvimStatus, logsVisible }
      })
      setWorkspacePickerOpen(false)
      setConfigPickerOpen(false)
    }
  }, [configPickerOpen, logsVisible, nativeNvimStatus, workspacePickerOpen])

  const selectWorkspaceDirectory = useCallback((path: string) => {
    if (
      connecting || connected ||
      !connectionSettingsLoaded || nativeNvimStatusLoading ||
      nativeNvimStatus?.supported !== true ||
      !nativeNvimStatus.allFilesAccess
    ) {
      diagnosticLogger.warn({
        category: 'workspace',
        event: 'selection.rejected',
        message: 'Rejected a workspace selection because browsing is no longer available',
        details: {
          path,
          connecting,
          connected,
          connectionSettingsLoaded,
          nativeNvimStatusLoading,
          nativeNvimStatus
        }
      })
      setWorkspacePickerOpen(false)
      return
    }
    try {
      const settings = createLocalConnectionSettings(
        path,
        configDirectory
      )
      setFormError('')
      setWorkspacePath(settings.workspacePath)
      setWorkspacePickerOpen(false)
      diagnosticLogger.info({
        category: 'workspace',
        event: 'selection.accepted',
        message: 'Selected a canonical local workspace directory',
        details: { requestedPath: path, canonicalPath: settings.workspacePath }
      })
      void connectionSettingsStore.save(settings).catch((reason: unknown) => {
        diagnosticLogger.error({
          category: 'workspace',
          event: 'selection.settings_save_failed',
          message: 'Selected the workspace but could not persist connection settings',
          details: { configDirectorySelected: settings.configDirectory !== null, reason }
        })
        if (clientMountedRef.current) {
          setFormError('The workspace is selected for this run, but the local settings could not be saved.')
        }
      })
    } catch (reason) {
      diagnosticLogger.warn({
        category: 'workspace',
        event: 'selection.rejected',
        message: 'Rejected an invalid workspace directory',
        details: { path, reason }
      })
      setFormError(reason instanceof Error ? reason.message : 'Invalid workspace directory')
    }
  }, [
    configDirectory,
    connected,
    connecting,
    connectionSettingsLoaded,
    nativeNvimStatus,
    nativeNvimStatusLoading
  ])

  const selectConfigDirectory = useCallback((path: string) => {
    if (
      connecting || connected ||
      !connectionSettingsLoaded || nativeNvimStatusLoading ||
      nativeNvimStatus?.supported !== true ||
      !nativeNvimStatus.allFilesAccess
    ) {
      diagnosticLogger.warn({
        category: 'workspace',
        event: 'config_selection.rejected',
        message: 'Rejected a config folder selection because browsing is no longer available',
        details: { path, connecting, connected, nativeNvimStatus }
      })
      setConfigPickerOpen(false)
      return
    }
    try {
      const settings = createLocalConnectionSettings(workspacePath, requireConfigDirectory(path))
      setFormError('')
      setConfigDirectory(settings.configDirectory ?? '')
      setConfigPickerOpen(false)
      actionPadStore.selectSource(actionPadPathForSettings(settings))
      void connectionSettingsStore.save(settings).catch((reason: unknown) => {
        diagnosticLogger.error({
          category: 'workspace',
          event: 'config_selection.settings_save_failed',
          message: 'Selected the config folder but could not persist connection settings',
          details: { configDirectorySelected: true, reason }
        })
        if (clientMountedRef.current) {
          setFormError('The config folder is selected for this run, but the local settings could not be saved.')
        }
      })
    } catch (reason) {
      diagnosticLogger.warn({
        category: 'workspace',
        event: 'config_selection.rejected',
        message: 'Rejected an invalid config folder',
        details: { path, reason }
      })
      setFormError(reason instanceof Error ? reason.message : 'Invalid Neovim config folder')
    }
  }, [
    actionPadStore,
    connected,
    connecting,
    connectionSettingsLoaded,
    nativeNvimStatus,
    nativeNvimStatusLoading,
    workspacePath
  ])

  useEffect(() => {
    const pendingEdits = connected && editingActionPadRef.current
      ? actionPadPendingEditsRef.current
      : NO_ACTION_PAD_EDITOR_PENDING_EDITS
    void actionPadStore.setConnected(connected, pendingEdits)
  }, [actionPadStore, connected])

  useEffect(() => {
    orderedDispatchEpoch.current += 1
    orderedDispatchTail.current = Promise.resolve()
    if (!connected) {
      for (const pending of pendingOrderedInputs.current) {
        if (pending.kind === 'editor-transition') pending.resolve()
      }
      pendingOrderedInputs.current = []
      firstKeyAfterFocus.current = false
      void imeRef.current?.blur().then(() => {
        diagnosticLogger.info({
          category: 'ime',
          event: 'blur.completed',
          message: 'Blurred the editor IME after disconnect'
        })
      }).catch((reason: unknown) => {
        diagnosticLogger.warn({
          category: 'ime',
          event: 'blur.failed',
          message: 'Failed to blur the editor IME after disconnect',
          details: { reason }
        })
      })
    }
  }, [connected])

  const openLogsFromMainToolbar = useCallback(async () => {
    if (logsVisibleRef.current || openingLogs.current) return
    openingLogs.current = true
    try {
      if (controller.getState().phase === 'connected' && imeRef.current !== null) {
        let finish!: () => void
        const dispatched = new Promise<void>((resolve) => { finish = resolve })
        const pending: PendingEditorTransition = { kind: 'editor-transition', resolve: finish }
        pendingOrderedInputs.current.push(pending)
        try {
          await withOperationalTimeout(
            imeRef.current.settleComposition().then(() => dispatched),
            1_500,
            'Timed out while settling editor composition'
          )
          diagnosticLogger.info({
            category: 'ime',
            event: 'logs_composition_settlement.completed',
            message: 'Settled ordered editor composition before opening Logs'
          })
        } catch (reason) {
          const index = pendingOrderedInputs.current.indexOf(pending)
          if (index >= 0) pendingOrderedInputs.current.splice(index, 1)
          diagnosticLogger.warn({
            category: 'ime',
            event: 'logs_composition_settlement.failed',
            message: 'Could not completely settle editor composition before opening Logs',
            details: { reason }
          })
        }
      }

      try {
        if (imeRef.current !== null) {
          await withOperationalTimeout(
            imeRef.current.blur(),
            1_500,
            'Timed out while blurring the editor IME'
          )
        }
      } catch (reason) {
        diagnosticLogger.warn({
          category: 'ime',
          event: 'logs_blur.failed',
          message: 'Could not blur the editor IME before opening Logs',
          details: { reason }
        })
      }

      try {
        Keyboard.dismiss()
      } catch (reason) {
        diagnosticLogger.warn({
          category: 'ime',
          event: 'logs_keyboard_dismiss.failed',
          message: 'Could not dismiss the ordinary keyboard before opening Logs',
          details: { reason }
        })
      }

      diagnosticLogger.info({
        category: 'app',
        event: 'logs.opened',
        message: 'Opened the in-app logs viewer from the main toolbar',
        details: { source: 'main-toolbar' }
      })
      onOpenLogs()
    } finally {
      openingLogs.current = false
    }
  }, [controller, onOpenLogs])

  const openLogsFromActionPadEditor = useCallback(() => {
    Keyboard.dismiss()
    diagnosticLogger.info({
      category: 'app',
      event: 'logs.opened',
      message: 'Opened the in-app logs viewer from the Action Pad editor',
      details: { source: 'action-pad-editor' }
    })
    onOpenLogs()
  }, [onOpenLogs])

  const openLogsFromWorkspacePicker = useCallback(() => {
    Keyboard.dismiss()
    diagnosticLogger.info({
      category: 'app',
      event: 'logs.opened',
      message: 'Opened the in-app logs viewer from the workspace picker',
      details: { source: 'workspace-picker' }
    })
    onOpenLogs()
  }, [onOpenLogs])

  const openActionPadEditor = useCallback(async (
    initialButton?: ActionPadButtonTarget,
    source = actionPadStore.getState()
  ) => {
    if (openingActionPadEditor.current || editingActionPadRef.current) return
    const openOperation = diagnosticLogger.operation({
      category: 'action-pad',
      event: 'action_pad.editor_open',
      message: 'Opening the Action Pad editor',
      details: { initialButton, source }
    })
    const selectionVersion = actionPadSelectionVersion.current
    const canOpen = () => {
      if (!clientMountedRef.current) return false
      if (initialButton === undefined) return true
      const current = actionPadStore.getState()
      if (
        current.sourcePath !== source.sourcePath ||
        current.activeConfig !== source.activeConfig
      ) {
        throw new Error('The Action Pad changed before the button editor opened. Select the button again.')
      }
      return selectingActionPadRef.current && selectionVersion === actionPadSelectionVersion.current
    }
    openingActionPadEditor.current = true
    try {
      if (!connectionSettingsLoaded) throw new Error('Local settings are still loading.')
      const settings = createLocalConnectionSettings(
        workspacePath,
        requireConfigDirectory(configDirectory)
      )
      actionPadStore.selectSource(actionPadPathForSettings(settings))
      if (!canOpen()) {
        openOperation.cancellation({
          message: 'Action Pad editor opening was superseded during local path selection'
        })
        return
      }
      // Finish the editor's existing composition before giving ordinary form
      // inputs focus. The configuration screen never shares the Neovim IME.
      if (controller.getState().phase === 'connected' && imeRef.current !== null) {
        let finish!: () => void
        const settled = new Promise<void>((resolve) => { finish = resolve })
        const pending: PendingEditorTransition = { kind: 'editor-transition', resolve: finish }
        pendingOrderedInputs.current.push(pending)
        try {
          await imeRef.current.settleComposition()
          await settled
          openOperation.checkpoint({
            event: 'action_pad.editor_composition_settled',
            message: 'Settled editor composition before opening the Action Pad editor'
          })
        } catch (reason) {
          const index = pendingOrderedInputs.current.indexOf(pending)
          if (index >= 0) pendingOrderedInputs.current.splice(index, 1)
          const failure = new Error(
            'Could not settle editor input before opening the Action Pad editor.',
            { cause: reason }
          )
          diagnosticLogger.error({
            category: 'ime',
            event: 'action_pad_composition_settlement.failed',
            message: failure.message,
            operationId: openOperation.id,
            details: { initialButton, reason }
          })
          throw failure
        }
      }
      if (!canOpen()) {
        openOperation.cancellation({
          message: 'Action Pad editor opening was superseded after composition settlement'
        })
        return
      }
      editingActionPadRef.current = true
      try {
        await imeRef.current?.blur()
        openOperation.checkpoint({
          event: 'action_pad.editor_ime_blurred',
          message: 'Blurred the editor IME before opening the Action Pad editor'
        })
      } catch (reason) {
        diagnosticLogger.error({
          category: 'ime',
          event: 'action_pad_blur.failed',
          message: 'Failed to blur the editor IME before opening the Action Pad editor',
          operationId: openOperation.id,
          details: { reason }
        })
        throw reason
      }
      if (!canOpen()) {
        editingActionPadRef.current = false
        openOperation.cancellation({
          message: 'Action Pad editor opening was superseded after IME blur'
        })
        return
      }
      setFormError('')
      actionPadPendingEditsRef.current = NO_ACTION_PAD_EDITOR_PENDING_EDITS
      setInitialActionPadButton(initialButton)
      setEditingActionPad(true)
      openOperation.success({
        message: 'Opened the Action Pad editor',
        details: { initialButton, sourcePath: actionPadStore.getState().sourcePath }
      })
    } catch (reason) {
      openOperation.failure(reason, {
        message: 'Could not open the Action Pad editor',
        details: { initialButton }
      })
      editingActionPadRef.current = false
      if (clientMountedRef.current) {
        setFormError(reason instanceof Error ? reason.message : 'Could not open the Action Pad editor')
      }
    } finally {
      openingActionPadEditor.current = false
    }
  }, [actionPadStore, configDirectory, connectionSettingsLoaded, controller, workspacePath])

  // Bind a button's identity to the document that rendered it, including native
  // events delivered just after a different local document is published.
  const editActionPadButton = useCallback((button: ActionPadButtonTarget) => {
    void openActionPadEditor(button, actionPadState)
  }, [actionPadState, openActionPadEditor])

  const closeActionPadEditor = useCallback(() => {
    const state = actionPadStore.getState()
    if (state.busy) return
    const close = () => {
      diagnosticLogger.info({
        category: 'action-pad',
        event: 'action_pad.editor_closed',
        message: 'Closed the Action Pad editor',
        details: { dirty: actionPadStore.getState().dirty }
      })
      actionPadPendingEditsRef.current = NO_ACTION_PAD_EDITOR_PENDING_EDITS
      setEditingActionPad(false)
      setInitialActionPadButton(undefined)
      editingActionPadRef.current = false
    }
    const discard = () => {
      actionPadStore.discardWorkingConfig()
      close()
    }
    const pendingEdits = actionPadPendingEditsRef.current
    if (state.dirty || pendingEdits.fieldEdits) {
      Alert.alert('Unsaved Action Pad edits', 'Closing the editor will discard these in-memory edits. The local file will not change. If the first load was waiting for these edits, the selected file may then update the active pad.', [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Discard and close', style: 'destructive', onPress: discard }
      ])
    } else close()
  }, [actionPadStore])

  const startActionPadNeovim = useCallback(() => {
    void startLocalNeovim()
  }, [startLocalNeovim])

  const loadActionPad = useCallback(async () => {
    if ((actionPadStore.getState().dirty || actionPadPendingEditsRef.current.fieldEdits) && !await confirmAction(
      'Replace unsaved edits?',
      'Reloading the local file will replace these in-memory edits. Buttons can execute Neovim commands; use only files you trust.',
      'Load file'
    )) return
    await actionPadStore.load()
  }, [actionPadStore])

  const saveActionPad = useCallback(() => actionPadStore.save(), [actionPadStore])
  const changeActionPad = useCallback((config: ActionPadConfig) => {
    actionPadStore.setWorkingConfig(config)
    actionPadStore.setConnectionPreservation(actionPadPendingEditsRef.current)
  }, [actionPadStore])
  const changeActionPadPendingEdits = useCallback((pending: ActionPadEditorPendingEdits) => {
    actionPadPendingEditsRef.current = pending
    actionPadStore.setConnectionPreservation(pending)
  }, [actionPadStore])
  const stopWaitingForActionPad = useCallback(() => {
    actionPadStore.stopWaiting()
    void controller.disconnect()
  }, [actionPadStore, controller])
  return (
    <KeyboardAvoidingView
      behavior="height"
      onLayout={onScreenLayout}
      style={[
        styles.screen,
        expanded ? styles.expandedScreen : styles.condensedScreen,
        compactControls && styles.keyboardCompactScreen
      ]}
      testID="tablet-client-screen"
    >
      <View
        style={[
          styles.toolbar,
          !expanded && styles.condensedToolbar,
          compactControls && styles.keyboardCompactToolbar
        ]}
        testID="main-toolbar"
      >
        <View style={styles.brandBlock}>
          <Text style={styles.brand}>CODEY</Text>
          <View style={[styles.statusDot, statusDotStyle(client.phase)]} />
        </View>
        <View style={styles.directoryControls} testID="local-workspace-controls">
          <Pressable
            accessibilityHint={`Current workspace: ${workspacePath}. Opens the directory browser.`}
            accessibilityLabel="Set Workspace"
            accessibilityRole="button"
            accessibilityState={{ disabled: workspaceBrowseDisabled }}
            disabled={workspaceBrowseDisabled}
            onPress={() => setWorkspacePickerOpen(true)}
            style={({ pressed }) => [
              styles.directoryButton,
              pressed && styles.pressed,
              workspaceBrowseDisabled && styles.disabled
            ]}
          >
            <Text numberOfLines={1} style={styles.directoryButtonText}>Set Workspace</Text>
          </Pressable>
          <Pressable
            accessibilityHint={configDirectory.trim().length > 0
              ? `Current config directory: ${configDirectory}. Opens the directory browser.`
              : `No config directory selected. Opens the directory browser at ${workspacePath}.`}
            accessibilityLabel="Set Config Directory"
            accessibilityRole="button"
            accessibilityState={{ disabled: configBrowseDisabled }}
            disabled={configBrowseDisabled}
            onPress={() => setConfigPickerOpen(true)}
            style={({ pressed }) => [
              styles.directoryButton,
              pressed && styles.pressed,
              configBrowseDisabled && styles.disabled
            ]}
            testID="local-config-controls"
          >
            <Text numberOfLines={1} style={styles.directoryButtonText}>Set Config Directory</Text>
          </Pressable>
        </View>
        <Pressable
          accessibilityRole="button"
          disabled={!connectionSettingsLoaded || nativeNvimStatusLoading || connecting || localUnavailable.length > 0 ||
            (localConfigMissing && !localNeedsFilesAccess)}
          onPress={toggleConnection}
          style={({ pressed }) => [
            styles.connectionButton,
            !expanded && styles.condensedConnectionButton,
            connected && styles.disconnectButton,
            pressed && styles.pressed,
            (!connectionSettingsLoaded || nativeNvimStatusLoading || connecting || localUnavailable.length > 0 ||
              (localConfigMissing && !localNeedsFilesAccess)) && styles.disabled
          ]}
        >
          {connecting ? <ActivityIndicator color="#0b0e12" size="small" /> : null}
          <Text style={styles.connectionButtonText}>
            {connected ? 'Stop' : localNeedsFilesAccess ? 'Grant files' : 'Start'}
          </Text>
        </Pressable>
        <Text numberOfLines={1} style={[styles.statusMessage, client.phase === 'error' && styles.error]}>
          {!connectionSettingsLoaded ? 'Loading local settings…' : nativeNvimStatusLoading
            ? 'Checking bundled Neovim…'
            : formError || localUnavailable || (localNeedsFilesAccess
            ? 'Allow all-files access for the local workspace'
            : localConfigMissing
              ? 'Choose a Neovim config folder'
            : client.message)}
        </Text>
        <Text accessibilityLabel="Local Neovim readiness" numberOfLines={1} style={styles.statusMessage}>
          {nativeNvimStatusLoading
            ? 'Bundled runtime: checking · Files: checking'
            : nativeNvimStatus?.supported === true
              ? `Bundled runtime: available · Files: ${nativeNvimStatus.allFilesAccess ? 'allowed' : 'permission needed'}`
              : nativeNvimStatus?.supported === false
                ? 'Bundled runtime: unavailable · Files: unavailable'
                : 'Bundled runtime: status unavailable · Files: status unavailable'}
        </Text>
        <Pressable
          accessibilityLabel="Open logs"
          accessibilityRole="button"
          onPress={() => { void openLogsFromMainToolbar() }}
          style={({ pressed }) => [styles.logsButton, pressed && styles.pressed]}
          testID="main-open-logs"
        >
          <Text style={styles.logsButtonText}>Logs</Text>
        </Pressable>
      </View>

      {workspacePickerOpen ? (
        <WorkspaceDirectoryPicker
          initialPath={workspacePath}
          onCancel={() => setWorkspacePickerOpen(false)}
          onOpenLogs={openLogsFromWorkspacePicker}
          onSelect={selectWorkspaceDirectory}
        />
      ) : null}
      {configPickerOpen ? (
        <WorkspaceDirectoryPicker
          initialPath={configDirectory.startsWith('/') ? configDirectory : workspacePath}
          onCancel={() => setConfigPickerOpen(false)}
          onOpenLogs={openLogsFromWorkspacePicker}
          onSelect={selectConfigDirectory}
          purpose="config"
        />
      ) : null}

      <View
        style={[
          styles.workspace,
          expanded ? styles.expandedWorkspace : styles.condensedWorkspace,
          compactControls && styles.keyboardCompactWorkspace
        ]}
        testID="tablet-client-workspace"
      >
        <View
          style={[
            styles.editorColumn,
            expanded ? styles.expandedEditorColumn : styles.condensedEditorColumn,
            compactControls && styles.keyboardCompactEditorColumn
          ]}
          testID="editor-column"
        >
          <View
            style={[styles.editorFrame, compactControls && styles.keyboardCompactEditor]}
            testID="editor-frame"
          >
            <EditorCanvas
              height={canvasBounds.height}
              onCellPress={connected ? submitEditorCellPress : undefined}
              onLayout={onEditorLayout}
              performanceSamples={client.performanceSamples}
              snapshot={client.snapshot}
              width={canvasBounds.width}
            />
            {client.snapshot === null ? (
              <View pointerEvents="none" style={styles.emptyState}>
                <Text style={styles.emptyTitle}>
                  {connecting ? 'Starting Neovim…' : 'Neovim is stopped'}
                </Text>
                <Text style={styles.emptyCopy}>
                  {connecting
                    ? 'Waiting for the initial redraw frame'
                    : 'Start the bundled editor in a local workspace above'}
                </Text>
              </View>
            ) : null}
            <CodeyIme
              ref={imeRef}
              inputMode="terminal"
              onCommittedText={submitCommittedText}
              onKey={submitHardwareKey}
              onOrderedInput={submitOrderedInput}
              style={styles.imeTarget}
            />
          </View>
          <ActionPadStatusBar
            compact={compactControls}
            context={actionPadNavigationContext}
            mode={mode}
          />
        </View>

        <View style={styles.actionPadContainer} testID="action-pad-container">
          <ActionPad
            compact={compactControls}
            enabled={connected}
            interactionMode={editingActionPad || logsVisible || openingLogs.current
              ? 'suspended'
              : selectingActionPad ? 'selection' : 'normal'}
            onEditButton={editActionPadButton}
            onInput={sendOrderedActionInput}
            onKeyboardPress={focusKeyboardIme}
            onNavigationContextChange={setActionPadNavigationContext}
            resetKey={client.phase}
            rootMenu={rootMenu}
          />
          <Pressable
            accessibilityActions={[{ name: 'openEditor', label: 'Open full Action Pad editor' }]}
            accessibilityHint={selectingActionPad
              ? 'Tap to finish selecting buttons. Hold to open the full editor.'
              : 'Tap to select a button to edit. Hold to open the full editor.'}
            accessibilityRole="button"
            accessibilityLabel={selectingActionPad ? 'Done editing' : 'Edit Action Pad'}
            accessibilityState={{
              selected: selectingActionPad,
              disabled: !connectionSettingsLoaded || configDirectory.trim().length === 0
            }}
            delayLongPress={ACTION_PAD_LONG_PRESS_MS}
            disabled={!connectionSettingsLoaded || configDirectory.trim().length === 0}
            onAccessibilityAction={(event) => {
              if (event.nativeEvent.actionName === 'openEditor') void openActionPadEditor()
            }}
            onLongPress={() => {
              editControlLongPressTriggered.current = true
              void openActionPadEditor()
            }}
            onPress={() => {
              if (editControlLongPressTriggered.current) {
                editControlLongPressTriggered.current = false
                return
              }
              setActionPadSelection(!selectingActionPadRef.current)
            }}
            onPressIn={() => { editControlLongPressTriggered.current = false }}
            style={({ pressed }) => [
              styles.actionPadControlButton,
              styles.editActionPadButton,
              selectingActionPad && styles.editActionPadSelected,
              (!connectionSettingsLoaded || configDirectory.trim().length === 0) && styles.disabled,
              pressed && styles.pressed
            ]}
          >
            <Text style={styles.editActionPadText}>{selectingActionPad ? 'Done editing' : 'Edit Action Pad'}{actionPadState.dirty ? ' · unsaved' : ''}</Text>
          </Pressable>
          {actionPadState.error ? (
            <Text accessibilityRole="alert" style={styles.actionPadNotice}>
              {actionPadState.message}
            </Text>
          ) : null}
        </View>
      </View>
      <Modal
        animationType="slide"
        onRequestClose={closeActionPadEditor}
        visible={editingActionPad}
      >
        <SafeAreaView style={styles.configScreen}>
          <View style={styles.configHostBar}>
            <Text style={styles.configHost}>
              Local Neovim · {connected ? 'Running' : 'Stopped'}
            </Text>
            {!connected ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={localNeedsFilesAccess
                  ? 'Grant local workspace file access'
                  : 'Start local Neovim'}
                disabled={!connectionSettingsLoaded || nativeNvimStatusLoading || connecting || localUnavailable.length > 0}
                onPress={startActionPadNeovim}
                style={[
                  styles.actionPadControlButton,
                  styles.connectActionPadButton,
                  (!connectionSettingsLoaded || nativeNvimStatusLoading || connecting || localUnavailable.length > 0) && styles.disabled
                ]}
              >
                <Text style={styles.editActionPadText}>
                  {connecting
                    ? 'Starting…'
                    : localNeedsFilesAccess
                      ? 'Grant files'
                      : 'Start Neovim'}
                </Text>
              </Pressable>
            ) : null}
          </View>
          {localUnavailable ? (
            <Text accessibilityRole="alert" style={styles.actionPadNotice}>
              {localUnavailable}
            </Text>
          ) : null}
          {editingActionPad ? <ActionPadEditor
            busy={actionPadState.busy}
            connectionFailure={client.connectionFailure}
            config={actionPadState.workingConfig}
            connected={connected}
            dirty={actionPadState.dirty}
            initialButton={initialActionPadButton}
            initialLoadPending={actionPadState.initialLoadPending}
            notice={actionPadState.notice}
            onCancel={closeActionPadEditor}
            onChange={changeActionPad}
            onLoad={loadActionPad}
            onOpenLogs={openLogsFromActionPadEditor}
            onPendingEditsChange={changeActionPadPendingEdits}
            onSave={saveActionPad}
            onStopWaiting={stopWaitingForActionPad}
            operation={actionPadState.operation}
            sourcePath={actionPadState.sourcePath}
          /> : null}
        </SafeAreaView>
      </Modal>
    </KeyboardAvoidingView>
  )
}

function confirmAction(title: string, message: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: action, style: 'destructive', onPress: () => resolve(true) }
    ], { cancelable: true, onDismiss: () => resolve(false) })
  })
}

function orderedBatchToNvimInput(event: CodeyImeOrderedInputEvent): string {
  const parts: string[] = []
  for (const segment of event.segments) {
    switch (segment.type) {
      case 'text':
        parts.push(committedTextToNvimInput(segment.text))
        break
      case 'key': {
        const input = specialKeyToNvimInput({
          key: segment.key,
          modifiers: {
            ctrl: segment.ctrl,
            alt: segment.alt,
            shift: segment.shift,
            meta: segment.meta
          }
        })
        if (input !== null) parts.push(input)
        break
      }
      case 'input':
        parts.push(segment.keys)
    }
  }
  return parts.join('')
}

function consumeFirstKeyAfterFocus(flag: { current: boolean }): boolean {
  const value = flag.current
  flag.current = false
  return value
}

function recordNativeToJsDelivery(
  receivedAtUptimeMs: number | undefined,
  tags: PerformanceTags,
  deliveredAtMs = performanceDiagnosticsEnabled() ? performanceNow() : undefined
): void {
  if (deliveredAtMs === undefined) return
  const durationMs = receivedAtUptimeMs === undefined ? Number.NaN : deliveredAtMs - receivedAtUptimeMs
  if (Number.isFinite(durationMs) && durationMs >= 0 && durationMs <= 60_000) {
    recordPerformance('native_to_js_event_delivery', {
      startedAtMs: receivedAtUptimeMs,
      durationMs,
      tags
    })
    return
  }
  recordPerformance('native_to_js_event_delivery', {
    startedAtMs: deliveredAtMs,
    durationMs: 0,
    tags
  })
}

function nativeInputTiming(receivedAtUptimeMs: number | undefined): NativeInputTiming {
  if (!performanceDiagnosticsEnabled()) return {}
  const deliveredAtMs = performanceNow()
  const deliveryDurationMs = receivedAtUptimeMs === undefined
    ? Number.NaN
    : deliveredAtMs - receivedAtUptimeMs
  const inputStartedAtMs = Number.isFinite(deliveryDurationMs) &&
    deliveryDurationMs >= 0 &&
    deliveryDurationMs <= 60_000
    ? receivedAtUptimeMs
    : deliveredAtMs
  return {
    deliveredAtMs,
    sample: createPerformanceInputSample(inputStartedAtMs)
  }
}

function withOperationalTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (reason: unknown) => {
        clearTimeout(timer)
        reject(reason)
      }
    )
  })
}

function statusDotStyle(phase: string) {
  if (phase === 'connected') return styles.statusConnected
  if (phase === 'connecting') return styles.statusConnecting
  if (phase === 'error') return styles.statusError
  return styles.statusDisconnected
}

const styles = StyleSheet.create({
  configScreen: {
    flex: 1,
    backgroundColor: '#0b0e12'
  },
  configHost: {
    flex: 1,
    color: '#a6b1c2',
    paddingHorizontal: 16,
    paddingVertical: 8,
    fontSize: 12
  },
  configHostBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 12
  },
  actionPadControlButton: {
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 10,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#353b52',
    borderRadius: 8
  },
  editActionPadButton: {
    backgroundColor: 'transparent'
  },
  connectActionPadButton: {
    backgroundColor: '#1b2030'
  },
  editActionPadText: {
    color: '#b4caff',
    fontSize: 14,
    fontWeight: '600'
  },
  editActionPadSelected: {
    borderColor: '#73daca',
    backgroundColor: '#20343d'
  },
  actionPadNotice: {
    color: '#f0bd76',
    fontSize: 12,
    paddingVertical: 4
  },
  screen: {
    flex: 1,
    backgroundColor: '#0b0e12'
  },
  expandedScreen: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8
  },
  condensedScreen: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 5
  },
  keyboardCompactScreen: {
    paddingVertical: 2,
    gap: 4
  },
  workspace: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    flexDirection: 'row'
  },
  expandedWorkspace: {
    gap: 8
  },
  condensedWorkspace: {
    gap: 5
  },
  keyboardCompactWorkspace: {
    gap: 4
  },
  editorColumn: {
    flex: 1,
    minWidth: 0,
    minHeight: 0
  },
  expandedEditorColumn: {
    gap: 8
  },
  condensedEditorColumn: {
    gap: 5
  },
  keyboardCompactEditorColumn: {
    gap: 4
  },
  actionPadContainer: {
    width: ACTION_PAD_WIDTH,
    minWidth: 0,
    minHeight: 0
  },
  toolbar: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  condensedToolbar: {
    gap: 5
  },
  keyboardCompactToolbar: {
    minHeight: 40
  },
  brandBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingRight: 4
  },
  brand: {
    color: '#eef4fa',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 1.8
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  statusConnected: { backgroundColor: '#3fb950' },
  statusConnecting: { backgroundColor: '#d29922' },
  statusError: { backgroundColor: '#f85149' },
  statusDisconnected: { backgroundColor: '#65717e' },
  directoryControls: {
    flexShrink: 0,
    flexDirection: 'row',
    gap: 5
  },
  directoryButton: {
    height: 38,
    minWidth: 120,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#465262',
    borderRadius: 8,
    backgroundColor: '#1b2030'
  },
  directoryButtonText: { color: '#b4caff', fontSize: 12, fontWeight: '600' },
  connectionButton: {
    minWidth: 112,
    height: 38,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    borderRadius: 8,
    backgroundColor: '#7ee787'
  },
  condensedConnectionButton: {
    minWidth: 88,
    paddingHorizontal: 10
  },
  disconnectButton: { backgroundColor: '#f2cc60' },
  connectionButtonText: { color: '#0b0e12', fontSize: 14, fontWeight: '700' },
  disabled: { opacity: 0.65 },
  pressed: { opacity: 0.75 },
  statusMessage: {
    minWidth: 0,
    flex: 1,
    color: '#9eabb8',
    fontSize: 13
  },
  logsButton: {
    height: 38,
    minWidth: 56,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#465262',
    borderRadius: 8,
    backgroundColor: '#1b2030'
  },
  logsButtonText: {
    color: '#c5d9f2',
    fontSize: 12,
    fontWeight: '700'
  },
  error: { color: '#ff7b72' },
  editorFrame: {
    flex: 1,
    minWidth: 0,
    minHeight: 80,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#27303a',
    borderRadius: 10,
    backgroundColor: '#111419'
  },
  keyboardCompactEditor: {
    minHeight: 48
  },
  emptyState: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center'
  },
  emptyTitle: { color: '#d6dee7', fontSize: 18, fontWeight: '600' },
  emptyCopy: { marginTop: 5, color: '#73808e', fontSize: 13 },
  imeTarget: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    width: 2,
    height: 2,
    opacity: 0.01
  }
})
