import { requireNativeModule } from 'expo'

export interface NativeSubscription {
  remove(): void
}

export interface NativeTcpDataEvent {
  readonly connectionId: number
  readonly bytes: Uint8Array | readonly number[]
}

export interface NativeTcpCloseEvent {
  readonly connectionId: number
  readonly message?: string
  readonly code?: string
}

export interface NativeTcpModule {
  open(host: string, port: number, timeoutMs: number): Promise<number>
  write(connectionId: number, bytes: Uint8Array): Promise<void>
  close(connectionId: number): Promise<void>
  addListener(eventName: 'data', listener: (event: NativeTcpDataEvent) => void): NativeSubscription
  addListener(eventName: 'close', listener: (event: NativeTcpCloseEvent) => void): NativeSubscription
}

export function getNativeTcp(): NativeTcpModule {
  return requireNativeModule<NativeTcpModule>('CodeyTcp')
}
