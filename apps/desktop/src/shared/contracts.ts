export const desktopIpc = {
  connect: 'codey:connect',
  disconnect: 'codey:disconnect',
  input: 'codey:input',
  resize: 'codey:resize',
  snapshot: 'codey:snapshot',
  status: 'codey:status'
} as const

export interface ConnectOptions {
  host: string
  port: number
  columns: number
  rows: number
}

export interface GridSize {
  columns: number
  rows: number
}

export type ConnectionPhase =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'

export interface ConnectionStatus {
  phase: ConnectionPhase
  message: string
}

export interface SnapshotCell {
  readonly text: string
  readonly highlightId: number
}

export interface SnapshotGrid {
  readonly id: number
  readonly width: number
  readonly height: number
  readonly cells: readonly SnapshotCell[]
}

export interface SnapshotCursor {
  readonly grid: number
  readonly row: number
  readonly column: number
  readonly visible: boolean
}

export interface SnapshotHighlight {
  foreground?: number | null
  background?: number | null
  special?: number | null
  reverse?: boolean
  bold?: boolean
  italic?: boolean
  underline?: boolean
  undercurl?: boolean
  strikethrough?: boolean
}

export interface EditorSnapshot {
  readonly grid: SnapshotGrid | null
  readonly cursor: SnapshotCursor | null
  readonly defaultForeground: number
  readonly defaultBackground: number
  readonly highlights: Readonly<Record<number, SnapshotHighlight>>
  readonly mode: string
}

export interface DesktopBridge {
  connect(options: ConnectOptions): Promise<void>
  disconnect(): Promise<void>
  input(keys: string): Promise<void>
  resize(columns: number, rows: number): Promise<void>
  onSnapshot(listener: (snapshot: EditorSnapshot) => void): () => void
  onStatus(listener: (status: ConnectionStatus) => void): () => void
}
