import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
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

import { ACTION_PAD_LONG_PRESS_MS, ActionPad, type ActionPadButtonTarget } from './action-pad'
import { ActionPadEditor } from './action-pad/ActionPadEditor'
import { resolveActionPadConfig, type ActionPadConfig } from './action-pad/document'
import { ActionPadConfigStore } from './action-pad/store'
import {
  connectionSettingsStore,
  selectedConnectionTarget,
  validateConnectionSettings,
  type ConnectionSettings
} from './connection-settings-store'
import {
  actionPadEndpointForTarget,
  connectionTargetLabel,
  createLocalConnectionTarget,
  createRemoteConnectionTarget,
  DEFAULT_CONNECTION_TARGET,
  DEFAULT_LOCAL_WORKSPACE_PATH,
  DEFAULT_REMOTE_TARGET,
  type ConnectionTarget,
  type ConnectionTargetKind
} from './connection-target'
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
import type { TabletCapability } from './tablet'
import { WorkspaceDirectoryPicker } from './workspace/WorkspaceDirectoryPicker'

interface TabletClientProps {
  readonly capability: TabletCapability
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

export function TabletClient({ capability }: TabletClientProps) {
  const [controller] = useState(() => new TabletClientController(createRuntimeConnection))
  const client = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const [actionPadStore] = useState(() => new ActionPadConfigStore(
    controller,
    undefined,
    actionPadEndpointForTarget(DEFAULT_CONNECTION_TARGET)
  ))
  const actionPadState = useSyncExternalStore(actionPadStore.subscribe, actionPadStore.getState, actionPadStore.getState)
  const rootMenu = useMemo(() => resolveActionPadConfig(actionPadState.activeConfig), [actionPadState.activeConfig])
  const [selectingActionPad, setSelectingActionPad] = useState(false)
  const selectingActionPadRef = useRef(false)
  const actionPadSelectionVersion = useRef(0)
  const [editingActionPad, setEditingActionPad] = useState(false)
  const [initialActionPadButton, setInitialActionPadButton] = useState<ActionPadButtonTarget>()
  const editingActionPadRef = useRef(false)
  const openingActionPadEditor = useRef(false)
  const editControlLongPressTriggered = useRef(false)
  const clientMountedRef = useRef(true)
  const nativeNvimStatusRequest = useRef(0)
  const actionPadInitialization = useRef<Promise<void>>(Promise.resolve())
  const targetSelectionStarted = useRef(false)
  const [selectedKind, setSelectedKind] = useState<ConnectionTargetKind>('local')
  const [workspacePath, setWorkspacePath] = useState(DEFAULT_LOCAL_WORKSPACE_PATH)
  const [host, setHost] = useState('192.168.1.20')
  const [port, setPort] = useState('6666')
  const [actionPadTarget, setActionPadTarget] = useState<ConnectionTarget>(DEFAULT_CONNECTION_TARGET)
  const [connectionSettingsLoaded, setConnectionSettingsLoaded] = useState(false)
  const [nativeNvimStatus, setNativeNvimStatus] = useState<NativeNvimStatus | null>(null)
  const [nativeNvimStatusLoading, setNativeNvimStatusLoading] = useState(true)
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
  const [formError, setFormError] = useState('')
  const [canvasBounds, setCanvasBounds] = useState<CanvasBounds>({ width: 0, height: 0 })
  const [screenHeight, setScreenHeight] = useState(capability.height)
  const imeRef = useRef<CodeyImeHandle>(null)
  const pendingOrderedInputs = useRef<PendingOrderedInput[]>([])
  const orderedDispatchTail = useRef<Promise<void>>(Promise.resolve())
  const orderedDispatchEpoch = useRef(0)
  const firstKeyAfterFocus = useRef(false)

  useEffect(() => {
    let mounted = true
    clientMountedRef.current = true
    actionPadInitialization.current = connectionSettingsStore.load()
      .then(async (settings) => {
        // A connection chosen during startup owns its target and recovery data;
        // a slower storage read must not replace it with the previous selection.
        if (!mounted || targetSelectionStarted.current) return
        const target = selectedConnectionTarget(settings)
        setSelectedKind(settings.selectedKind)
        setWorkspacePath(settings.local.workspacePath)
        setHost(settings.remote.host)
        setPort(String(settings.remote.port))
        setActionPadTarget(target)
        await actionPadStore.selectEndpoint(actionPadEndpointForTarget(target))
      })
      .finally(() => {
        if (mounted) setConnectionSettingsLoaded(true)
      })
    return () => {
      mounted = false
      clientMountedRef.current = false
      for (const pending of pendingOrderedInputs.current) {
        if (pending.kind === 'editor-transition') pending.resolve()
      }
      void controller.dispose()
    }
  }, [actionPadStore, controller])

  const refreshNativeNvimStatus = useCallback(async () => {
    const request = ++nativeNvimStatusRequest.current
    if (clientMountedRef.current) setNativeNvimStatusLoading(true)
    try {
      const status = await getNativeNvimStatus()
      if (clientMountedRef.current && request === nativeNvimStatusRequest.current) {
        setNativeNvimStatus(status)
        setNativeNvimStatusLoading(false)
      }
    } catch {
      // Unit tests, Expo Go, and an ungenerated native project do not have the
      // optional module. Connection startup will still publish a useful error.
      if (clientMountedRef.current && request === nativeNvimStatusRequest.current) {
        setNativeNvimStatus(null)
        setNativeNvimStatusLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void refreshNativeNvimStatus()
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshNativeNvimStatus()
    })
    return () => subscription.remove()
  }, [refreshNativeNvimStatus])

  const setActionPadSelection = useCallback((selecting: boolean) => {
    selectingActionPadRef.current = selecting
    actionPadSelectionVersion.current += 1
    setSelectingActionPad(selecting)
  }, [])

  useEffect(() => {
    setActionPadSelection(false)
  }, [actionPadState.endpoint.host, actionPadState.endpoint.port, setActionPadSelection])

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

  const toggleConnection = useCallback(() => {
    setFormError('')
    if (client.phase === 'connected') {
      void controller.disconnect()
      return
    }

    try {
      const target = selectedKind === 'local'
        ? createLocalConnectionTarget(workspacePath)
        : createRemoteConnectionTarget(host, port)
      const settings = settingsForTarget(target, workspacePath, host, port)
      targetSelectionStarted.current = true
      setActionPadTarget(target)
      void connectionSettingsStore.save(settings).catch(() => undefined)
      void actionPadStore.selectEndpoint(actionPadEndpointForTarget(target))
      void controller.connect(target)
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : 'Invalid connection details')
    }
  }, [actionPadStore, client.phase, controller, host, port, selectedKind, workspacePath])

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
      if (editingActionPadRef.current) return
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
      if (editingActionPadRef.current) return
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
      if (editingActionPadRef.current) {
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
    if (selectingActionPadRef.current || editingActionPadRef.current || openingActionPadEditor.current) return
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
    void imeRef.current?.sendOrderedInput(keys).catch(() => {
      const index = pendingOrderedInputs.current.indexOf(pending)
      if (index >= 0) pendingOrderedInputs.current.splice(index, 1)
    })
  }, [])

  const submitEditorCellPress = useCallback((position: GridCellPosition) => {
    if (editingActionPadRef.current || openingActionPadEditor.current) return
    const pending: PendingMouseInput = { kind: 'mouse', position }
    pendingOrderedInputs.current.push(pending)
    void imeRef.current?.settleComposition().catch(() => {
      const index = pendingOrderedInputs.current.indexOf(pending)
      if (index >= 0) pendingOrderedInputs.current.splice(index, 1)
    })
  }, [])

  const focusKeyboardIme = useCallback(() => {
    if (selectingActionPadRef.current || editingActionPadRef.current || openingActionPadEditor.current) return
    firstKeyAfterFocus.current = true
    void imeRef.current?.focus().catch(() => undefined)
  }, [])

  const connected = client.phase === 'connected'
  const connecting = client.phase === 'connecting'
  const expanded = capability.layout === 'expanded'
  const compactControls = capability.height - screenHeight >= KEYBOARD_COMPACT_THRESHOLD
  const mode = client.snapshot?.mode.name.toUpperCase() || '—'
  const localNeedsFilesAccess = !connected && selectedKind === 'local' &&
    nativeNvimStatus?.supported === true &&
    !nativeNvimStatus.allFilesAccess
  const localUnavailable = !connected && selectedKind === 'local' && nativeNvimStatus?.supported === false
    ? nativeNvimStatus.unavailableReason ?? 'Bundled NeoVim is unavailable on this device'
    : ''
  const actionPadLocalNeedsFilesAccess = !connected && actionPadTarget.kind === 'local' &&
    nativeNvimStatus?.supported === true &&
    !nativeNvimStatus.allFilesAccess
  const actionPadLocalUnavailable = !connected && actionPadTarget.kind === 'local' &&
    nativeNvimStatus?.supported === false
    ? nativeNvimStatus.unavailableReason ?? 'Bundled NeoVim is unavailable on this device'
    : ''
  const workspaceBrowseDisabled = connecting || connected || !connectionSettingsLoaded ||
    nativeNvimStatusLoading ||
    nativeNvimStatus?.supported !== true || !nativeNvimStatus.allFilesAccess

  useEffect(() => {
    if (
      workspacePickerOpen &&
      nativeNvimStatus !== null &&
      (!nativeNvimStatus.supported || !nativeNvimStatus.allFilesAccess)
    ) {
      setWorkspacePickerOpen(false)
    }
  }, [nativeNvimStatus, workspacePickerOpen])

  const selectConnectionKind = useCallback((kind: ConnectionTargetKind) => {
    if (connected || connecting || kind === selectedKind) return
    setFormError('')
    try {
      const target = kind === 'local'
        ? createLocalConnectionTarget(workspacePath)
        : createRemoteConnectionTarget(host, port)
      const settings = settingsForTarget(target, workspacePath, host, port)
      targetSelectionStarted.current = true
      setSelectedKind(kind)
      setActionPadTarget(target)
      void connectionSettingsStore.save(settings).catch(() => undefined)
      void actionPadStore.selectEndpoint(actionPadEndpointForTarget(target))
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : 'Invalid connection details')
    }
  }, [actionPadStore, connected, connecting, host, port, selectedKind, workspacePath])

  const grantAllFilesAccess = useCallback(() => {
    setFormError('')
    void openNativeNvimAllFilesSettings()
      .catch((reason: unknown) => {
        setFormError(reason instanceof Error ? reason.message : 'Could not open Android file access settings')
      })
  }, [])

  const selectWorkspaceDirectory = useCallback((path: string) => {
    if (
      selectedKind !== 'local' || connecting || connected ||
      !connectionSettingsLoaded || nativeNvimStatusLoading ||
      nativeNvimStatus?.supported !== true ||
      !nativeNvimStatus.allFilesAccess
    ) {
      setWorkspacePickerOpen(false)
      return
    }
    try {
      const target = createLocalConnectionTarget(path)
      const settings = settingsForTarget(target, target.workspacePath, host, port)
      targetSelectionStarted.current = true
      setFormError('')
      setWorkspacePath(target.workspacePath)
      setActionPadTarget(target)
      setWorkspacePickerOpen(false)
      void connectionSettingsStore.save(settings).catch(() => undefined)
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : 'Invalid workspace directory')
    }
  }, [
    connected,
    connecting,
    connectionSettingsLoaded,
    host,
    nativeNvimStatus,
    nativeNvimStatusLoading,
    port,
    selectedKind
  ])

  useEffect(() => {
    void actionPadStore.setConnected(connected)
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
      void imeRef.current?.blur().catch(() => undefined)
    }
  }, [connected])

  const openActionPadEditor = useCallback(async (
    initialButton?: ActionPadButtonTarget,
    source = actionPadStore.getState()
  ) => {
    if (openingActionPadEditor.current || editingActionPadRef.current) return
    const selectionVersion = actionPadSelectionVersion.current
    const canOpen = () => {
      if (!clientMountedRef.current) return false
      if (initialButton === undefined) return true
      const current = actionPadStore.getState()
      if (
        current.endpoint.host !== source.endpoint.host ||
        current.endpoint.port !== source.endpoint.port ||
        current.sourcePath !== source.sourcePath ||
        current.activeConfig !== source.activeConfig
      ) {
        throw new Error('The Action Pad changed before the button editor opened. Select the button again.')
      }
      return selectingActionPadRef.current && selectionVersion === actionPadSelectionVersion.current
    }
    openingActionPadEditor.current = true
    try {
      // ID text is initialized when the editor mounts. Await recovery first so
      // opening immediately after launch cannot replace recovered edits.
      await actionPadInitialization.current
      await actionPadStore.selectEndpoint(actionPadStore.getState().endpoint)
      if (!canOpen()) return
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
        } catch {
          const index = pendingOrderedInputs.current.indexOf(pending)
          if (index >= 0) pendingOrderedInputs.current.splice(index, 1)
          throw new Error('Could not settle editor input before opening the Action Pad editor.')
        }
      }
      if (!canOpen()) return
      editingActionPadRef.current = true
      await imeRef.current?.blur()
      if (!canOpen()) {
        editingActionPadRef.current = false
        return
      }
      setFormError('')
      setInitialActionPadButton(initialButton)
      setEditingActionPad(true)
    } catch (reason) {
      editingActionPadRef.current = false
      if (clientMountedRef.current) {
        setFormError(reason instanceof Error ? reason.message : 'Could not open the Action Pad editor')
      }
    } finally {
      openingActionPadEditor.current = false
    }
  }, [actionPadStore, controller])

  // Bind a button's identity to the document that rendered it, including native
  // events delivered just after a different endpoint or document is published.
  const editActionPadButton = useCallback((button: ActionPadButtonTarget) => {
    void openActionPadEditor(button, actionPadState)
  }, [actionPadState, openActionPadEditor])

  const closeActionPadEditor = useCallback(() => {
    const state = actionPadStore.getState()
    if (state.busy) return
    const close = () => {
      setEditingActionPad(false)
      setInitialActionPadButton(undefined)
      editingActionPadRef.current = false
    }
    const discard = () => {
      actionPadStore.discardDraft()
      close()
    }
    if (state.dirty) {
      Alert.alert('Unsaved Action Pad edits', 'Keep the draft for later, or discard it. Neither option changes the active pad or host file.', [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Keep draft & close', onPress: close },
        { text: 'Discard', style: 'destructive', onPress: discard }
      ])
    } else close()
  }, [actionPadStore])

  const connectActionPadHost = useCallback(() => {
    const target = actionPadTarget
    if (target.kind === 'local' && nativeNvimStatus?.supported === false) {
      setFormError(
        nativeNvimStatus.unavailableReason ?? 'Bundled NeoVim is unavailable on this device'
      )
      return
    }
    if (
      target.kind === 'local' &&
      nativeNvimStatus?.supported === true &&
      !nativeNvimStatus.allFilesAccess
    ) {
      grantAllFilesAccess()
      return
    }
    setSelectedKind(target.kind)
    if (target.kind === 'local') setWorkspacePath(target.workspacePath)
    else {
      setHost(target.host)
      setPort(String(target.port))
    }
    void connectionSettingsStore
      .save(settingsForTarget(target, workspacePath, host, port))
      .catch(() => undefined)
    void controller.connect(target)
  }, [actionPadTarget, controller, grantAllFilesAccess, host, nativeNvimStatus, port, workspacePath])

  const loadActionPad = useCallback(async (path: string) => {
    if (actionPadStore.getState().dirty && !await confirmAction(
      'Replace unsaved edits?',
      'Loading a valid host file will replace this draft. Buttons can execute Neovim commands; load only files you trust.',
      'Load file'
    )) return
    await actionPadStore.load(path)
  }, [actionPadStore])

  const saveActionPad = useCallback((path: string) => actionPadStore.save(path), [actionPadStore])
  const changeActionPad = useCallback((config: ActionPadConfig) => actionPadStore.setDraft(config), [actionPadStore])
  const changeActionPadIds = useCallback((ids: Readonly<Record<string, string>>) => actionPadStore.setIdDrafts(ids), [actionPadStore])
  const exportActionPad = useCallback((path: string) => actionPadStore.export(path, (destination) => confirmAction(
    'Replace exported file?',
    `Export will replace ${destination}. Your active file and unsaved status will stay unchanged.`,
    'Replace'
  )), [actionPadStore])
  const stopWaitingForActionPad = useCallback(() => {
    actionPadStore.stopWaiting()
    void controller.disconnect()
  }, [actionPadStore, controller])
  const reconnectAndCheckActionPadSave = useCallback(() => {
    void (async () => {
      const target = actionPadTarget
      setSelectedKind(target.kind)
      if (target.kind === 'local') setWorkspacePath(target.workspacePath)
      else {
        setHost(target.host)
        setPort(String(target.port))
      }
      await actionPadStore.setConnected(false)
      await connectionSettingsStore
        .save(settingsForTarget(target, workspacePath, host, port))
        .catch(() => undefined)
      await controller.connect(target)
      if (controller.getState().phase !== 'connected') return
      await actionPadStore.setConnected(true)
      await actionPadStore.reconcilePendingSave()
    })()
  }, [actionPadStore, actionPadTarget, controller, host, port, workspacePath])

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
      <View style={[styles.toolbar, compactControls && styles.keyboardCompactToolbar]}>
        <View style={styles.brandBlock}>
          <Text style={styles.brand}>CODEY</Text>
          <View style={[styles.statusDot, statusDotStyle(client.phase)]} />
        </View>
        <View accessibilityRole="tablist" style={styles.targetPicker}>
          {(['local', 'remote'] as const).map((kind) => (
            <Pressable
              accessibilityLabel={`Use ${kind} Neovim`}
              accessibilityRole="tab"
              accessibilityState={{ selected: selectedKind === kind, disabled: connecting || connected }}
              disabled={connecting || connected}
              key={kind}
              onPress={() => selectConnectionKind(kind)}
              style={[
                styles.targetButton,
                selectedKind === kind && styles.targetButtonSelected
              ]}
            >
              <Text style={[
                styles.targetButtonText,
                selectedKind === kind && styles.targetButtonTextSelected
              ]}>
                {kind === 'local' ? 'Local' : 'Remote'}
              </Text>
            </Pressable>
          ))}
        </View>
        {selectedKind === 'local' ? (
          <View
            style={[
              styles.workspacePathControls,
              !expanded && styles.condensedWorkspacePathControls
            ]}
            testID="local-workspace-controls"
          >
            <TextInput
              accessibilityLabel="Local workspace path"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!connecting && !connected}
              onChangeText={setWorkspacePath}
              placeholder="/storage/emulated/0"
              placeholderTextColor="#65717e"
              style={[styles.input, styles.workspaceInput]}
              value={workspacePath}
            />
            <Pressable
              accessibilityLabel="Browse local workspaces"
              accessibilityRole="button"
              accessibilityState={{ disabled: workspaceBrowseDisabled }}
              disabled={workspaceBrowseDisabled}
              onPress={() => setWorkspacePickerOpen(true)}
              style={({ pressed }) => [
                styles.workspaceBrowseButton,
                pressed && styles.pressed,
                workspaceBrowseDisabled && styles.disabled
              ]}
            >
              <Text style={styles.workspaceBrowseButtonText}>Browse</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <TextInput
              accessibilityLabel="Neovim host"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!connecting && !connected}
              onChangeText={setHost}
              placeholder="Host"
              placeholderTextColor="#65717e"
              style={[styles.input, styles.hostInput]}
              value={host}
            />
            <TextInput
              accessibilityLabel="Neovim port"
              editable={!connecting && !connected}
              keyboardType="number-pad"
              maxLength={5}
              onChangeText={setPort}
              placeholder="Port"
              placeholderTextColor="#65717e"
              style={[styles.input, styles.portInput]}
              value={port}
            />
          </>
        )}
        <Pressable
          accessibilityRole="button"
          disabled={connecting || localUnavailable.length > 0}
          onPress={connected || !localNeedsFilesAccess ? toggleConnection : grantAllFilesAccess}
          style={({ pressed }) => [
            styles.connectionButton,
            connected && styles.disconnectButton,
            pressed && styles.pressed,
            (connecting || localUnavailable.length > 0) && styles.disabled
          ]}
        >
          {connecting ? <ActivityIndicator color="#0b0e12" size="small" /> : null}
          <Text style={styles.connectionButtonText}>
            {connected ? 'Disconnect' : localNeedsFilesAccess ? 'Grant files' : 'Connect'}
          </Text>
        </Pressable>
        <Text numberOfLines={1} style={[styles.statusMessage, client.phase === 'error' && styles.error]}>
          {formError || localUnavailable || (localNeedsFilesAccess
            ? 'Allow all-files access for the local workspace'
            : client.message)}
        </Text>
      </View>

      {workspacePickerOpen ? (
        <WorkspaceDirectoryPicker
          initialPath={workspacePath}
          onCancel={() => setWorkspacePickerOpen(false)}
          onSelect={selectWorkspaceDirectory}
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
                {connecting ? 'Connecting to Neovim…' : 'No editor session'}
              </Text>
              <Text style={styles.emptyCopy}>
                {connecting
                  ? 'Waiting for the initial redraw frame'
                  : selectedKind === 'local'
                    ? 'Start the bundled editor in a local workspace above'
                    : 'Enter a trusted LAN endpoint above'}
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

        <View style={styles.actionPadContainer} testID="action-pad-container">
          <ActionPad
            compact={compactControls}
            enabled={connected}
            interactionMode={editingActionPad ? 'suspended' : selectingActionPad ? 'selection' : 'normal'}
            mode={mode}
            onEditButton={editActionPadButton}
            onInput={sendOrderedActionInput}
            onKeyboardPress={focusKeyboardIme}
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
            accessibilityState={{ selected: selectingActionPad }}
            delayLongPress={ACTION_PAD_LONG_PRESS_MS}
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
              pressed && styles.pressed
            ]}
          >
            <Text style={styles.editActionPadText}>{selectingActionPad ? 'Done editing' : 'Edit Action Pad'}{actionPadState.dirty ? ' · unsaved' : ''}</Text>
          </Pressable>
          {actionPadState.error || actionPadState.recoveryWarning ? (
            <Text accessibilityRole="alert" style={styles.actionPadNotice}>
              {actionPadState.recoveryWarning || actionPadState.message}
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
              {connectionTargetLabel(actionPadTarget)} · {connected ? 'Connected' : 'Offline editing'}
            </Text>
            {!connected ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={actionPadLocalNeedsFilesAccess
                  ? 'Grant local workspace file access'
                  : 'Connect configuration session'}
                disabled={connecting || actionPadLocalUnavailable.length > 0}
                onPress={connectActionPadHost}
                style={[
                  styles.actionPadControlButton,
                  styles.connectActionPadButton,
                  (connecting || actionPadLocalUnavailable.length > 0) && styles.disabled
                ]}
              >
                <Text style={styles.editActionPadText}>
                  {connecting
                    ? 'Connecting…'
                    : actionPadLocalNeedsFilesAccess
                      ? 'Grant files'
                      : 'Connect session'}
                </Text>
              </Pressable>
            ) : null}
          </View>
          {actionPadLocalUnavailable ? (
            <Text accessibilityRole="alert" style={styles.actionPadNotice}>
              {actionPadLocalUnavailable}
            </Text>
          ) : null}
          {editingActionPad ? <ActionPadEditor
            busy={actionPadState.busy}
            connectionFailure={client.connectionFailure}
            config={actionPadState.draft}
            connected={connected}
            dirty={actionPadState.dirty}
            initialButton={initialActionPadButton}
            initialIdDrafts={actionPadState.idDrafts}
            message=""
            notice={actionPadState.notice}
            onCancel={closeActionPadEditor}
            onChange={changeActionPad}
            onIdDraftsChange={changeActionPadIds}
            onExport={exportActionPad}
            onLoad={loadActionPad}
            onReconnectAndCheck={actionPadState.pendingSavePath === null ? undefined : reconnectAndCheckActionPadSave}
            onSave={saveActionPad}
            onStopWaiting={stopWaitingForActionPad}
            operation={actionPadState.operation}
            recoveryNotice={actionPadState.recoveryNotice}
            sourcePath={actionPadState.pendingSavePath ?? actionPadState.sourcePath}
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

function settingsForTarget(
  target: ConnectionTarget,
  workspacePath: string,
  host: string,
  port: string
): ConnectionSettings {
  const local = target.kind === 'local'
    ? target
    : safeLocalTarget(workspacePath)
  const remote = target.kind === 'remote'
    ? target
    : safeRemoteTarget(host, port)
  return validateConnectionSettings({
    version: 2,
    selectedKind: target.kind,
    local: { workspacePath: local.workspacePath },
    remote: { host: remote.host, port: remote.port }
  })
}

function safeLocalTarget(workspacePath: string) {
  try {
    return createLocalConnectionTarget(workspacePath)
  } catch {
    return createLocalConnectionTarget(DEFAULT_LOCAL_WORKSPACE_PATH)
  }
}

function safeRemoteTarget(host: string, port: string) {
  try {
    return createRemoteConnectionTarget(host, port)
  } catch {
    return DEFAULT_REMOTE_TARGET
  }
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
  input: {
    height: 38,
    paddingHorizontal: 11,
    borderWidth: 1,
    borderColor: '#303946',
    borderRadius: 8,
    color: '#e7edf3',
    backgroundColor: '#151b22',
    fontFamily: 'monospace',
    fontSize: 14
  },
  targetPicker: {
    height: 38,
    flexDirection: 'row',
    padding: 2,
    borderWidth: 1,
    borderColor: '#303946',
    borderRadius: 8,
    backgroundColor: '#151b22'
  },
  targetButton: {
    minWidth: 62,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 5
  },
  targetButtonSelected: { backgroundColor: '#293442' },
  targetButtonText: { color: '#8c99a8', fontSize: 12, fontWeight: '600' },
  targetButtonTextSelected: { color: '#eef4fa' },
  workspacePathControls: {
    width: 320,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6
  },
  condensedWorkspacePathControls: {
    flexShrink: 1,
    minWidth: 160
  },
  workspaceInput: { flex: 1, minWidth: 0 },
  workspaceBrowseButton: {
    height: 38,
    minWidth: 70,
    paddingHorizontal: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#465262',
    borderRadius: 8,
    backgroundColor: '#1b2030'
  },
  workspaceBrowseButtonText: { color: '#b4caff', fontSize: 12, fontWeight: '600' },
  hostInput: { width: 190 },
  portInput: { width: 82 },
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
