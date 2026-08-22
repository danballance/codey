import {
  configurePerformanceDiagnostics,
  performanceDiagnosticsEnabled
} from '@codey/perf'

const requested = process.env.EXPO_PUBLIC_CODEY_PERF === '1'

configurePerformanceDiagnostics({
  enabled: requested,
  build: __DEV__ ? 'development' : 'release',
  capacity: 1_024,
  log: requested
})

export { performanceDiagnosticsEnabled }
export * from '@codey/perf'
