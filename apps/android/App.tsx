import { useCallback, useEffect, useRef, useState } from 'react'
import { StatusBar } from 'expo-status-bar'
import { AppState, Platform, StyleSheet, useWindowDimensions } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'

import { DiagnosticsModal } from './src/diagnostics/DiagnosticsModal'
import { diagnosticLogger } from './src/diagnostics/logger'
import { TabletClient } from './src/TabletClient'
import { TabletCapabilityGate } from './src/TabletCapabilityGate'
import { UnsupportedDeviceScreen } from './src/UnsupportedDeviceScreen'
import { tabletCapability } from './src/tablet'

import './src/performance'

export default function App() {
  const { width, height } = useWindowDimensions()
  const capability = tabletCapability(width, height)
  const [logsVisible, setLogsVisible] = useState(false)
  const previousCapability = useRef<string | undefined>(undefined)

  useEffect(() => {
    diagnosticLogger.info({
      category: 'app',
      event: 'app.started',
      message: 'Codey Android started',
      details: {
        platform: Platform.OS,
        platformVersion: Platform.Version,
        appState: AppState.currentState,
        dimensions: { width, height },
        capability
      }
    })
    const subscription = AppState.addEventListener('change', (state) => {
      diagnosticLogger.info({
        category: 'app',
        event: 'app.state.changed',
        message: `Application state changed to ${state}`,
        details: { state }
      })
    })
    return () => subscription.remove()
    // A process-local run has exactly one application start event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const signature = `${capability.layout}:${width}:${height}`
    if (previousCapability.current === signature) return
    const previous = previousCapability.current
    previousCapability.current = signature
    diagnosticLogger.info({
      category: 'device',
      event: previous === undefined ? 'capability.detected' : 'capability.changed',
      message: `Window capability is ${capability.layout}`,
      details: { previous, capability, dimensions: { width, height } }
    })
  }, [capability, height, width])

  const openLogs = useCallback(() => setLogsVisible(true), [])
  const closeLogs = useCallback(() => {
    diagnosticLogger.info({
      category: 'app',
      event: 'logs.closed',
      message: 'Closed the in-app logs viewer'
    })
    setLogsVisible(false)
  }, [])
  const openUnsupportedLogs = useCallback(() => {
    diagnosticLogger.info({
      category: 'app',
      event: 'logs.opened',
      message: 'Opened the in-app logs viewer from the unsupported-device screen',
      details: { source: 'unsupported-device' }
    })
    openLogs()
  }, [openLogs])

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView edges={['top', 'right', 'bottom', 'left']} style={styles.safeArea}>
        <TabletCapabilityGate
          capability={capability}
          renderSupported={() => (
            <TabletClient
              capability={capability}
              logsVisible={logsVisible}
              onOpenLogs={openLogs}
            />
          )}
          renderUnsupported={() => <UnsupportedDeviceScreen onOpenLogs={openUnsupportedLogs} />}
        />
        <DiagnosticsModal onClose={closeLogs} visible={logsVisible} />
      </SafeAreaView>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0b0e12'
  }
})
