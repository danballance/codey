import { requireNativeModule } from 'expo'

export interface NativeSubscription {
  remove(): void
}

export interface NativeTcpDataEvent {
  readonly connectionId: number
  readonly bytes: Uint8Array | readonly number[]
  readonly receivedAtUptimeMs?: number
  readonly nativeDurationMs?: number
}

export interface NativeTcpCloseEvent {
  readonly connectionId: number
  readonly message?: string
  readonly code?: string
}

export interface NativeTcpWriteMeasurement {
  readonly nativeEntryUptimeMs: number
  readonly lockWaitStartedAtUptimeMs: number
  readonly lockWaitDurationMs: number
  readonly socketWriteStartedAtUptimeMs: number
  readonly socketWriteDurationMs: number
}

export interface NativeTcpModule {
  open(host: string, port: number, timeoutMs: number): Promise<number>
  write(connectionId: number, bytes: Uint8Array): Promise<void>
  /** Available for diagnostics; the ordinary write path intentionally skips clocks. */
  writeMeasured?(
    connectionId: number,
    bytes: Uint8Array
  ): Promise<NativeTcpWriteMeasurement>
  close(connectionId: number): Promise<void>
  addListener(eventName: 'data', listener: (event: NativeTcpDataEvent) => void): NativeSubscription
  addListener(eventName: 'close', listener: (event: NativeTcpCloseEvent) => void): NativeSubscription
}

export function getNativeTcp(): NativeTcpModule {
  return requireNativeModule<NativeTcpModule>('CodeyTcp')
}
