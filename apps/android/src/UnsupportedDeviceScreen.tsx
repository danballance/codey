import { StyleSheet, Text, View } from 'react-native'

import { MIN_TABLET_SHORTEST_SIDE_DP } from './tablet'

export function UnsupportedDeviceScreen() {
  return (
    <View style={styles.screen} testID="unsupported-device-screen">
      <View style={styles.card}>
        <Text style={styles.eyebrow}>ANDROID TABLET REQUIRED</Text>
        <Text style={styles.title}>Codey needs a landscape tablet window</Text>
        <Text style={styles.copy}>
          This development build supports landscape tablet windows with a shortest side of at
          least {` ${MIN_TABLET_SHORTEST_SIDE_DP}dp`}. Phones can install the build, but cannot
          start an editor session.
        </Text>
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
  }
})
