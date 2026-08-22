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

import { TabletClientController } from './controller'
import { EditorCanvas } from './editor/EditorCanvas'
import { endpointStore } from './endpoint-store'
import { DEFAULT_ENDPOINT, validateEndpoint } from './endpoint'
import { gridSizeForBounds } from './grid'
import {
  committedTextToNvimInput,
  specialKeyToNvimInput
} from './input'
import { CodeyIme, type CodeyImeHandle, type CodeyImeKeyEvent } from './native/CodeyIme'
import { createRuntimeConnection } from './runtime-connection'
import type { TabletCapability } from './tablet'

interface TabletClientProps {
  readonly capability: TabletCapability
}

interface CanvasBounds {
  readonly width: number
  readonly height: number
}

const KEY_ROW = [
  ['Esc', 'Escape'],
  ['Tab', 'Tab'],
  ['Enter', 'Enter'],
  ['⌫', 'Backspace'],
  ['←', 'ArrowLeft'],
  ['↓', 'ArrowDown'],
  ['↑', 'ArrowUp'],
  ['→', 'ArrowRight']
] as const

export function TabletClient({ capability }: TabletClientProps) {
  const [controller] = useState(() => new TabletClientController(createRuntimeConnection))
  const client = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const [host, setHost] = useState(DEFAULT_ENDPOINT.host)
  const [port, setPort] = useState(String(DEFAULT_ENDPOINT.port))
  const [formError, setFormError] = useState('')
  const [control, setControl] = useState(false)
  const controlRef = useRef(false)
  const [canvasBounds, setCanvasBounds] = useState<CanvasBounds>({ width: 0, height: 0 })
  const imeRef = useRef<CodeyImeHandle>(null)

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

  const submitCommittedText = useCallback(
    (text: string) => {
      if (text.length === 0) return
      const applyControl = controlRef.current
      const keys = committedTextToNvimInput(text, applyControl)
      if (applyControl) {
        controlRef.current = false
        setControl(false)
      }
      void controller.input(keys)
    },
    [controller]
  )

  const submitHardwareKey = useCallback(
    (event: CodeyImeKeyEvent) => {
      const applyControl = controlRef.current
      const keys = specialKeyToNvimInput({
        key: event.key,
        modifiers: {
          ctrl: event.ctrl || applyControl,
          alt: event.alt,
          shift: event.shift,
          meta: event.meta
        }
      })
      if (keys === null) return
      if (applyControl) {
        controlRef.current = false
        setControl(false)
      }
      void controller.input(keys)
    },
    [controller]
  )

  const submitKeyRow = useCallback(
    (key: string) => {
      const applyControl = controlRef.current
      if (applyControl) {
        controlRef.current = false
        setControl(false)
      }
      void imeRef.current
        ?.sendKey({
          key,
          ctrl: applyControl,
          alt: false,
          shift: false,
          meta: false,
          repeat: false
        })
        .catch(() => undefined)
    },
    []
  )

  const toggleControl = useCallback(() => {
    const next = !controlRef.current
    controlRef.current = next
    setControl(next)
  }, [])

  const connected = client.phase === 'connected'
  const connecting = client.phase === 'connecting'
  const expanded = capability.layout === 'expanded'
  const mode = client.snapshot?.mode.name.toUpperCase() || '—'

  useEffect(() => {
    if (!connected) {
      controlRef.current = false
      setControl(false)
      void imeRef.current?.blur().catch(() => undefined)
    }
  }, [connected])

  return (
    <KeyboardAvoidingView
      behavior="height"
      style={[styles.screen, expanded ? styles.expandedScreen : styles.condensedScreen]}
      testID="tablet-client-screen"
    >
      <View style={styles.toolbar}>
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

      <Pressable
        accessibilityLabel="Neovim editor"
        disabled={!connected}
        onPress={() => void imeRef.current?.focus().catch(() => undefined)}
        style={styles.editorFrame}
      >
        <EditorCanvas
          height={canvasBounds.height}
          onLayout={onEditorLayout}
          snapshot={client.snapshot}
          width={canvasBounds.width}
        />
        {client.snapshot === null ? (
          <View pointerEvents="none" style={styles.emptyState}>
            <Text style={styles.emptyTitle}>{connecting ? 'Connecting to Neovim…' : 'No editor session'}</Text>
            <Text style={styles.emptyCopy}>
              {connecting ? 'Waiting for the initial redraw frame' : 'Enter a trusted LAN endpoint above'}
            </Text>
          </View>
        ) : null}
        <CodeyIme
          ref={imeRef}
          onCommittedText={submitCommittedText}
          onKey={submitHardwareKey}
          style={styles.imeTarget}
        />
      </Pressable>

      <View style={styles.editorStatus}>
        <Text style={styles.mode}>{mode}</Text>
        <Text style={styles.dimensions}>
          {client.gridSize.columns} × {client.gridSize.rows} · {Math.round(capability.width)} ×{' '}
          {Math.round(capability.height)}dp
        </Text>
      </View>

      <View style={styles.keyRow}>
        <KeyButton active={control} label="Ctrl" onPress={toggleControl} />
        {KEY_ROW.map(([label, key]) => (
          <KeyButton key={key} label={label} onPress={() => submitKeyRow(key)} />
        ))}
      </View>
    </KeyboardAvoidingView>
  )
}

function KeyButton({
  active = false,
  label,
  onPress
}: {
  readonly active?: boolean
  readonly label: string
  readonly onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [styles.keyButton, active && styles.keyButtonActive, pressed && styles.pressed]}
    >
      <Text style={[styles.keyButtonText, active && styles.keyButtonTextActive]}>{label}</Text>
    </Pressable>
  )
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
  toolbar: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
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
    minHeight: 80,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#27303a',
    borderRadius: 10,
    backgroundColor: '#111419'
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
  },
  editorStatus: {
    minHeight: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 5
  },
  mode: { color: '#7ee787', fontFamily: 'monospace', fontSize: 12, fontWeight: '700' },
  dimensions: { color: '#7c8997', fontFamily: 'monospace', fontSize: 12 },
  keyRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 7
  },
  keyButton: {
    flex: 1,
    minWidth: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#35404c',
    borderRadius: 8,
    backgroundColor: '#182029'
  },
  keyButtonActive: { borderColor: '#7ee787', backgroundColor: '#1e3527' },
  keyButtonText: { color: '#c4ced8', fontSize: 14, fontWeight: '600' },
  keyButtonTextActive: { color: '#7ee787' }
})
