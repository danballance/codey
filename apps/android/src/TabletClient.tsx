import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent
} from 'react-native'
import {
  createPerformanceInputSample,
  performanceDiagnosticsEnabled,
  performanceNow,
  recordPerformance,
  withPerformanceTags,
  type PerformanceInputSample,
  type PerformanceTags
} from '@codey/perf'

import { ActionPad, ACTION_PAD_MENU } from './action-pad'
import { TabletClientController } from './controller'
import { EditorCanvas } from './editor/EditorCanvas'
import { endpointStore } from './endpoint-store'
import { DEFAULT_ENDPOINT, validateEndpoint } from './endpoint'
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
import { createRuntimeConnection } from './runtime-connection'
import type { TabletCapability, TabletOrientation } from './tablet'

interface TabletClientProps {
  readonly capability: TabletCapability
}

interface CanvasBounds {
  readonly width: number
  readonly height: number
}

interface ScreenMeasurement {
  readonly height: number
  readonly orientation: TabletOrientation
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

type PendingOrderedInput = PendingActionInput | PendingMouseInput

interface NativeInputTiming {
  readonly deliveredAtMs?: number
  readonly sample?: PerformanceInputSample
}

const KEYBOARD_COMPACT_THRESHOLD = 120
const LANDSCAPE_ACTION_PAD_WIDTH = 336

export function TabletClient({ capability }: TabletClientProps) {
  const [controller] = useState(() => new TabletClientController(createRuntimeConnection))
  const client = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const [host, setHost] = useState(DEFAULT_ENDPOINT.host)
  const [port, setPort] = useState(String(DEFAULT_ENDPOINT.port))
  const [formError, setFormError] = useState('')
  const [canvasBounds, setCanvasBounds] = useState<CanvasBounds>({ width: 0, height: 0 })
  const [screenMeasurement, setScreenMeasurement] = useState<ScreenMeasurement>({
    height: capability.height,
    orientation: capability.orientation
  })
  const imeRef = useRef<CodeyImeHandle>(null)
  const pendingOrderedInputs = useRef<PendingOrderedInput[]>([])
  const orderedDispatchTail = useRef<Promise<void>>(Promise.resolve())
  const orderedDispatchEpoch = useRef(0)
  const firstKeyAfterFocus = useRef(false)

  useEffect(() => {
    let mounted = true
    void endpointStore.load().then((endpoint) => {
      if (!mounted) return
      setHost(endpoint.host)
      setPort(String(endpoint.port))
    })
    return () => {
      mounted = false
      void controller.dispose()
    }
  }, [controller])

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

  const onScreenLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { height } = event.nativeEvent.layout
      setScreenMeasurement((previous) =>
        previous.height === height && previous.orientation === capability.orientation
          ? previous
          : { height, orientation: capability.orientation }
      )
    },
    [capability.orientation]
  )

  const toggleConnection = useCallback(() => {
    setFormError('')
    if (client.phase === 'connected') {
      void controller.disconnect()
      return
    }

    try {
      const endpoint = validateEndpoint(host, port)
      void endpointStore.save(endpoint).catch(() => undefined)
      void controller.connect(endpoint)
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : 'Invalid connection details')
    }
  }, [client.phase, controller, host, port])

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
    },
    [controller, submitControllerInput]
  )

  const sendOrderedActionInput = useCallback((keys: string) => {
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
    const pending: PendingMouseInput = { kind: 'mouse', position }
    pendingOrderedInputs.current.push(pending)
    void imeRef.current?.settleComposition().catch(() => {
      const index = pendingOrderedInputs.current.indexOf(pending)
      if (index >= 0) pendingOrderedInputs.current.splice(index, 1)
    })
  }, [])

  const focusKeyboardIme = useCallback(() => {
    firstKeyAfterFocus.current = true
    void imeRef.current?.focus().catch(() => undefined)
  }, [])

  const connected = client.phase === 'connected'
  const connecting = client.phase === 'connecting'
  const expanded = capability.layout === 'expanded'
  const landscape = capability.orientation === 'landscape'
  const compactControls = screenMeasurement.orientation === capability.orientation &&
    capability.height - screenMeasurement.height >= KEYBOARD_COMPACT_THRESHOLD
  const compactActionPad = compactControls
  const mode = client.snapshot?.mode.name.toUpperCase() || '—'

  useEffect(() => {
    orderedDispatchEpoch.current += 1
    orderedDispatchTail.current = Promise.resolve()
    if (!connected) {
      pendingOrderedInputs.current = []
      firstKeyAfterFocus.current = false
      void imeRef.current?.blur().catch(() => undefined)
    }
  }, [connected])

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
        <Pressable
          accessibilityRole="button"
          disabled={connecting}
          onPress={toggleConnection}
          style={({ pressed }) => [
            styles.connectionButton,
            connected && styles.disconnectButton,
            pressed && styles.pressed,
            connecting && styles.disabled
          ]}
        >
          {connecting ? <ActivityIndicator color="#0b0e12" size="small" /> : null}
          <Text style={styles.connectionButtonText}>{connected ? 'Disconnect' : 'Connect'}</Text>
        </Pressable>
        <Text numberOfLines={1} style={[styles.statusMessage, client.phase === 'error' && styles.error]}>
          {formError || client.message}
        </Text>
      </View>

      <View
        style={[
          styles.workspace,
          expanded ? styles.expandedWorkspace : styles.condensedWorkspace,
          compactControls && styles.keyboardCompactWorkspace,
          landscape ? styles.landscapeWorkspace : styles.portraitWorkspace
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

        <View
          style={[
            styles.actionPadContainer,
            landscape && styles.landscapeActionPadContainer
          ]}
          testID="action-pad-container"
        >
          <ActionPad
            compact={compactActionPad}
            dimensions={`${client.gridSize.columns} × ${client.gridSize.rows} · ${Math.round(capability.width)} × ${Math.round(capability.height)}dp`}
            enabled={connected}
            mode={mode}
            onInput={sendOrderedActionInput}
            onKeyboardPress={focusKeyboardIme}
            placement={landscape ? 'right' : 'below'}
            resetKey={client.phase}
            rootMenu={ACTION_PAD_MENU}
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  )
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
    minHeight: 0
  },
  portraitWorkspace: {
    flexDirection: 'column'
  },
  landscapeWorkspace: {
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
    minWidth: 0,
    minHeight: 0
  },
  landscapeActionPadContainer: {
    width: LANDSCAPE_ACTION_PAD_WIDTH
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
