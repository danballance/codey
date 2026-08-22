import { join } from 'node:path'

import {
  app,
  BrowserWindow,
  ipcMain,
  session as electronSession,
  type IpcMainInvokeEvent
} from 'electron'
import {
  applyRedrawBatch,
  createEditorState,
  toSnapshot,
  type EditorState,
  type HighlightAttributes
} from '@codey/editor-core'
import { MessagePackRpcClient } from '@codey/msgpack-rpc'
import { NvimSessionClient, type RedrawBatch } from '@codey/nvim-session'
import { NodeTcpTransport } from '@codey/transport/node'

import {
  desktopIpc,
  type ConnectOptions,
  type ConnectionStatus,
  type EditorSnapshot,
  type GridSize,
  type SnapshotHighlight
} from '../shared/contracts'

const MAX_INPUT_LENGTH = 16_384
const MAX_GRID_DIMENSION = 1_000

interface ActiveConnection {
  id: number
  host: string
  port: number
  session: NvimSessionClient
  state: EditorState
  ready: boolean
  closing: boolean
  removeCloseListener: () => void
  removeRedrawListener: () => void
}

let mainWindow: BrowserWindow | null = null
let activeConnection: ActiveConnection | null = null
let nextConnectionId = 1

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function sendStatus(status: ConnectionStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(desktopIpc.status, status)
  }
}

function sendSnapshot(snapshot: EditorSnapshot): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(desktopIpc.snapshot, snapshot)
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('Rejected IPC call from an untrusted renderer')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validatedGridSize(value: unknown): GridSize {
  if (!isRecord(value)) throw new TypeError('Grid size must be an object')
  const columns = value['columns']
  const rows = value['rows']
  if (
    !Number.isInteger(columns) ||
    !Number.isInteger(rows) ||
    typeof columns !== 'number' ||
    typeof rows !== 'number' ||
    columns < 2 ||
    rows < 2 ||
    columns > MAX_GRID_DIMENSION ||
    rows > MAX_GRID_DIMENSION
  ) {
    throw new RangeError(`Grid dimensions must be integers from 2 to ${MAX_GRID_DIMENSION}`)
  }
  return { columns, rows }
}

function validatedConnectOptions(value: unknown): ConnectOptions {
  if (!isRecord(value)) throw new TypeError('Connection options must be an object')
  const hostValue = value['host']
  const port = value['port']
  if (typeof hostValue !== 'string') throw new TypeError('Host must be a string')
  const host = hostValue.trim()
  if (
    host.length === 0 ||
    host.length > 253 ||
    !/^[a-zA-Z0-9._:%-]+$/.test(host)
  ) {
    throw new TypeError('Host must be a valid hostname or IP address')
  }
  if (!Number.isInteger(port) || typeof port !== 'number' || port < 1 || port > 65_535) {
    throw new RangeError('Port must be an integer from 1 to 65535')
  }
  const { columns, rows } = validatedGridSize(value)
  return { host, port, columns, rows }
}

function validatedInput(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Input must be a string')
  if (value.length === 0 || value.length > MAX_INPUT_LENGTH) {
    throw new RangeError(`Input must contain from 1 to ${MAX_INPUT_LENGTH} characters`)
  }
  return value
}

function highlightForRenderer(attributes: HighlightAttributes): SnapshotHighlight {
  const highlight: SnapshotHighlight = {}
  const foreground = attributes['foreground']
  const background = attributes['background']
  const special = attributes['special']
  if (typeof foreground === 'number') highlight.foreground = foreground
  if (typeof background === 'number') highlight.background = background
  if (typeof special === 'number') highlight.special = special

  const reverse = attributes['reverse']
  const bold = attributes['bold']
  const italic = attributes['italic']
  const underline = attributes['underline']
  const undercurl = attributes['undercurl']
  const strikethrough = attributes['strikethrough']
  if (typeof reverse === 'boolean') highlight.reverse = reverse
  if (typeof bold === 'boolean') highlight.bold = bold
  if (typeof italic === 'boolean') highlight.italic = italic
  if (typeof underline === 'boolean') highlight.underline = underline
  if (typeof undercurl === 'boolean') highlight.undercurl = undercurl
  if (typeof strikethrough === 'boolean') highlight.strikethrough = strikethrough
  return highlight
}

function snapshotForRenderer(state: EditorState): EditorSnapshot {
  const source = toSnapshot(state)
  const highlights: Record<number, SnapshotHighlight> = {}
  for (const [id, definition] of Object.entries(source.highlights)) {
    highlights[Number(id)] = highlightForRenderer(definition.rgb)
  }

  return {
    grid: source.grid,
    cursor: source.cursor
      ? {
          grid: source.cursor.gridId,
          row: source.cursor.row,
          column: source.cursor.column,
          visible: true
        }
      : null,
    defaultForeground: source.defaultColors?.foreground ?? 0xd7dde4,
    defaultBackground: source.defaultColors?.background ?? 0x111419,
    highlights,
    mode: source.mode.name.toUpperCase()
  }
}

async function closeConnection(
  connection: ActiveConnection,
  reportDisconnected: boolean
): Promise<void> {
  if (connection.closing) return
  connection.closing = true
  connection.ready = false
  if (activeConnection === connection) activeConnection = null
  connection.removeCloseListener()
  connection.removeRedrawListener()

  try {
    await connection.session.close()
  } catch {
    // The transport may already be gone. Closing is deliberately idempotent here.
  }

  if (reportDisconnected) {
    sendStatus({ phase: 'disconnected', message: 'Disconnected' })
  }
}

async function closeActiveConnection(reportDisconnected: boolean): Promise<void> {
  const connection = activeConnection
  if (connection) await closeConnection(connection, reportDisconnected)
  else if (reportDisconnected) {
    sendStatus({ phase: 'disconnected', message: 'Disconnected' })
  }
}

function onRedraw(connection: ActiveConnection, batch: RedrawBatch): void {
  if (activeConnection !== connection || connection.closing) return
  const result = applyRedrawBatch(connection.state, batch)
  connection.state = result.state
  if (result.didFlush) sendSnapshot(snapshotForRenderer(connection.state))
}

async function connect(options: ConnectOptions): Promise<void> {
  await closeActiveConnection(false)
  sendStatus({
    phase: 'connecting',
    message: `Connecting to ${options.host}:${options.port}…`
  })

  const transport = new NodeTcpTransport({
    host: options.host,
    port: options.port,
    connectTimeoutMs: 8_000
  })
  const rpc = new MessagePackRpcClient(transport)
  const nvimSession = new NvimSessionClient(rpc)
  const connection: ActiveConnection = {
    id: nextConnectionId++,
    host: options.host,
    port: options.port,
    session: nvimSession,
    state: createEditorState(),
    ready: false,
    closing: false,
    removeCloseListener: () => undefined,
    removeRedrawListener: () => undefined
  }
  activeConnection = connection

  connection.removeRedrawListener = nvimSession.onRedraw((batch) => onRedraw(connection, batch))
  connection.removeCloseListener = transport.onClose((error) => {
    if (activeConnection !== connection || connection.closing) return
    activeConnection = null
    connection.ready = false
    connection.removeRedrawListener()
    connection.removeCloseListener()
    const detail = error ? `: ${error.message}` : ''
    sendStatus({ phase: 'error', message: `Neovim connection closed${detail}` })
  })

  try {
    await nvimSession.connect()
    if (activeConnection !== connection || connection.closing) return
    await nvimSession.attach(options.columns, options.rows)
    if (activeConnection !== connection || connection.closing) return
    connection.ready = true
    sendStatus({
      phase: 'connected',
      message: `Connected to ${options.host}:${options.port}`
    })
  } catch (error) {
    if (activeConnection === connection) {
      await closeConnection(connection, false)
      sendStatus({
        phase: 'error',
        message: `Could not connect: ${errorMessage(error)}`
      })
    }
    throw error
  }
}

function requireReadyConnection(): ActiveConnection {
  const connection = activeConnection
  if (!connection || !connection.ready || connection.closing) {
    throw new Error('There is no active Neovim connection')
  }
  return connection
}

function registerIpcHandlers(): void {
  ipcMain.handle(desktopIpc.connect, async (event, rawOptions: unknown) => {
    assertTrustedSender(event)
    await connect(validatedConnectOptions(rawOptions))
  })

  ipcMain.handle(desktopIpc.disconnect, async (event) => {
    assertTrustedSender(event)
    await closeActiveConnection(true)
  })

  ipcMain.handle(desktopIpc.input, async (event, rawInput: unknown) => {
    assertTrustedSender(event)
    await requireReadyConnection().session.input(validatedInput(rawInput))
  })

  ipcMain.handle(desktopIpc.resize, async (event, rawSize: unknown) => {
    assertTrustedSender(event)
    const size = validatedGridSize(rawSize)
    await requireReadyConnection().session.resize(size.columns, size.rows)
  })
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 640,
    minHeight: 420,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0d1014',
    title: 'Codey',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
    void closeActiveConnection(false)
  })

  const developmentUrl = process.env['ELECTRON_RENDERER_URL']
  if (developmentUrl) void window.loadURL(developmentUrl)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))

  return window
}

app.whenReady().then(() => {
  electronSession.defaultSession.setPermissionCheckHandler(() => false)
  electronSession.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false)
  )
  registerIpcHandlers()
  mainWindow = createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('before-quit', () => {
  void closeActiveConnection(false)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
