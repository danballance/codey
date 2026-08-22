import { StatusBar } from 'expo-status-bar'
import { StyleSheet, useWindowDimensions } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'

import { TabletClient } from './src/TabletClient'
import { TabletCapabilityGate } from './src/TabletCapabilityGate'
import { tabletCapability } from './src/tablet'

export default function App() {
  const { width, height } = useWindowDimensions()
  const capability = tabletCapability(width, height)

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView edges={['top', 'right', 'bottom', 'left']} style={styles.safeArea}>
        <TabletCapabilityGate
          capability={capability}
          renderSupported={() => (
            <TabletClient key="supported-tablet-client" capability={capability} />
          )}
        />
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
