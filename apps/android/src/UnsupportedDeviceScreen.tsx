import { Pressable, StyleSheet, Text, View } from 'react-native'

import { MIN_TABLET_SHORTEST_SIDE_DP } from './tablet'

export interface UnsupportedDeviceScreenProps {
  readonly onOpenLogs: () => void
}

export function UnsupportedDeviceScreen({ onOpenLogs }: UnsupportedDeviceScreenProps) {
  return (
    <View style={styles.screen} testID="unsupported-device-screen">
      <View style={styles.card}>
        <Text style={styles.eyebrow}>ANDROID TABLET REQUIRED</Text>
        <Text style={styles.title}>Codey needs a landscape tablet window</Text>
        <Text style={styles.copy}>
          Rotate or resize this window to landscape with a shortest side of at least
          {` ${MIN_TABLET_SHORTEST_SIDE_DP}dp`}. Portrait, square, and phone-sized windows
          cannot start an editor session.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={onOpenLogs}
          style={({ pressed }) => [styles.logsButton, pressed && styles.pressed]}
        >
          <Text style={styles.logsButtonText}>Open Logs</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    backgroundColor: '#0b0e12'
  },
  card: {
    maxWidth: 560,
    padding: 32,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#27303a',
    backgroundColor: '#131820'
  },
  eyebrow: {
    marginBottom: 10,
    color: '#7ee787',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.5
  },
  title: {
    marginBottom: 12,
    color: '#f0f4f8',
    fontSize: 28,
    fontWeight: '700'
  },
  copy: {
    color: '#a9b4c0',
    fontSize: 16,
    lineHeight: 24
  },
  logsButton: {
    alignSelf: 'flex-start',
    marginTop: 22,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#3d4b5c',
    borderRadius: 8,
    backgroundColor: '#1b2330'
  },
  logsButtonText: {
    color: '#dbe8f6',
    fontSize: 14,
    fontWeight: '700'
  },
  pressed: {
    opacity: 0.75
  }
})
