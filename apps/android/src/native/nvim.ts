import { requireNativeModule } from 'expo'

export interface NativeSubscription {
  remove(): void
}

export interface NativeNvimStatus {
  readonly supported: boolean
  readonly running: boolean
  readonly allFilesAccess: boolean
  readonly unavailableReason?: string
}

export interface NativeNvimDataEvent {
  readonly sessionId: number
  readonly bytes: Uint8Array | readonly number[]
}

export interface NativeNvimExitEvent {
  readonly sessionId: number
  readonly exitCode: number
  readonly stderrTail?: string
  readonly code?: string
  readonly message?: string
}

export interface NativeNvimModule {
  getStatus(): Promise<NativeNvimStatus>
  openAllFilesSettings(): Promise<void>
  start(cwd: string): Promise<number>
  write(sessionId: number, bytes: Uint8Array): Promise<void>
  stop(sessionId: number): Promise<void>
  addListener(
    eventName: 'data',
    listener: (event: NativeNvimDataEvent) => void
  ): NativeSubscription
  addListener(
    eventName: 'exit',
    listener: (event: NativeNvimExitEvent) => void
  ): NativeSubscription
}

export function getNativeNvim(): NativeNvimModule {
  return requireNativeModule<NativeNvimModule>('CodeyNvim')
}

export function getNativeNvimStatus(
  module: NativeNvimModule = getNativeNvim()
): Promise<NativeNvimStatus> {
  return module.getStatus()
}

export function openNativeNvimAllFilesSettings(
  module: NativeNvimModule = getNativeNvim()
): Promise<void> {
  return module.openAllFilesSettings()
}
