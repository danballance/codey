import type {
  ConnectionPhase,
  ConnectionStatus,
  EditorSnapshot,
  SnapshotCell,
  SnapshotHighlight
} from '../shared/contracts'

const FONT_SIZE = 14
const LINE_HEIGHT = 21
const FONT_FAMILY = '"SFMono-Regular", "Cascadia Code", "Roboto Mono", Menlo, Consolas, monospace'
const FALLBACK_FOREGROUND = 0xd7dde4
const FALLBACK_BACKGROUND = 0x111419

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) {
    throw new Error(`Missing required element: ${selector}`)
  }
  return element
}

const form = requiredElement<HTMLFormElement>('#connection-form')
const hostInput = requiredElement<HTMLInputElement>('#host')
const portInput = requiredElement<HTMLInputElement>('#port')
const connectionButton = requiredElement<HTMLButtonElement>('#connection-button')
const statusElement = requiredElement<HTMLElement>('#status')
const statusLabel = requiredElement<HTMLElement>('#status-label')
const editorFrame = requiredElement<HTMLElement>('#editor-frame')
const canvas = requiredElement<HTMLCanvasElement>('#editor')
const emptyState = requiredElement<HTMLElement>('#empty-state')
const modeLabel = requiredElement<HTMLElement>('#mode-label')
const dimensionsLabel = requiredElement<HTMLElement>('#dimensions-label')

function requiredCanvasContext(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const candidate = target.getContext('2d', { alpha: false })
  if (!candidate) {
    throw new Error('This system does not provide a 2D canvas context')
  }
  return candidate
}

const context = requiredCanvasContext(canvas)

let connectionPhase: ConnectionPhase = 'disconnected'
let snapshot: EditorSnapshot | null = null
let cellWidth = 9
let cellHeight = LINE_HEIGHT
let canvasCssWidth = 0
let canvasCssHeight = 0
let lastSentColumns = 0
let lastSentRows = 0
let resizeFrame = 0
let renderFrame = 0

function baseFont(weight = '400', italic = false): string {
  return `${italic ? 'italic ' : ''}${weight} ${FONT_SIZE}px ${FONT_FAMILY}`
}

function measureCell(): void {
  context.font = baseFont()
  cellWidth = Math.max(1, Math.ceil(context.measureText('M').width))
  cellHeight = LINE_HEIGHT
}

function currentGridSize(): { columns: number; rows: number } {
  return {
    columns: Math.max(2, Math.floor(canvasCssWidth / cellWidth)),
    rows: Math.max(2, Math.floor(canvasCssHeight / cellHeight))
  }
}

function colorCss(color: number | null | undefined, fallback: number): string {
  const safeColor =
    typeof color === 'number' && Number.isFinite(color) && color >= 0
      ? Math.trunc(color) & 0xffffff
      : fallback
  return `#${safeColor.toString(16).padStart(6, '0')}`
}

function colorsFor(
  highlight: SnapshotHighlight | undefined,
  defaultForeground: number,
  defaultBackground: number
): { foreground: string; background: string; special: string } {
  let foreground = colorCss(highlight?.foreground, defaultForeground)
  let background = colorCss(highlight?.background, defaultBackground)

  if (highlight?.reverse) {
    ;[foreground, background] = [background, foreground]
  }

  return {
    foreground,
    background,
    special: colorCss(highlight?.special, defaultForeground)
  }
}

function cellAt(
  cells: readonly SnapshotCell[],
  width: number,
  row: number,
  column: number
): SnapshotCell {
  return cells[row * width + column] ?? { text: ' ', highlightId: 0 }
}

function scheduleRender(): void {
  if (renderFrame !== 0) {
    return
  }

  renderFrame = window.requestAnimationFrame(() => {
    renderFrame = 0
    render()
  })
}

function render(): void {
  const defaultForeground = snapshot?.defaultForeground ?? FALLBACK_FOREGROUND
  const defaultBackground = snapshot?.defaultBackground ?? FALLBACK_BACKGROUND

  context.save()
  context.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0)
  context.fillStyle = colorCss(defaultBackground, FALLBACK_BACKGROUND)
  context.fillRect(0, 0, canvasCssWidth, canvasCssHeight)

  const grid = snapshot?.grid
  if (!snapshot || !grid) {
    context.restore()
    return
  }

  const visibleRows = Math.min(grid.height, Math.ceil(canvasCssHeight / cellHeight))
  const visibleColumns = Math.min(grid.width, Math.ceil(canvasCssWidth / cellWidth))

  // Paint all backgrounds first so a continuation cell cannot cover a wide glyph.
  for (let row = 0; row < visibleRows; row += 1) {
    for (let column = 0; column < visibleColumns; column += 1) {
      const cell = cellAt(grid.cells, grid.width, row, column)
      const highlight = snapshot.highlights[cell.highlightId]
      const colors = colorsFor(highlight, defaultForeground, defaultBackground)
      context.fillStyle = colors.background
      context.fillRect(column * cellWidth, row * cellHeight, cellWidth + 0.5, cellHeight)
    }
  }

  context.textAlign = 'left'
  context.textBaseline = 'alphabetic'

  for (let row = 0; row < visibleRows; row += 1) {
    for (let column = 0; column < visibleColumns; column += 1) {
      const cell = cellAt(grid.cells, grid.width, row, column)
      const highlight = snapshot.highlights[cell.highlightId]
      const colors = colorsFor(highlight, defaultForeground, defaultBackground)
      const x = column * cellWidth
      const y = row * cellHeight

      if (cell.text && cell.text !== ' ') {
        context.font = baseFont(highlight?.bold ? '700' : '400', highlight?.italic === true)
        context.fillStyle = colors.foreground
        context.fillText(cell.text, x, y + FONT_SIZE + Math.floor((cellHeight - FONT_SIZE) / 2))
      }

      context.strokeStyle = colors.special
      context.lineWidth = 1

      if (highlight?.underline) {
        context.beginPath()
        context.moveTo(x, y + cellHeight - 2.5)
        context.lineTo(x + cellWidth, y + cellHeight - 2.5)
        context.stroke()
      }

      if (highlight?.undercurl) {
        context.beginPath()
        for (let offset = 0; offset <= cellWidth; offset += 2) {
          const curlY = y + cellHeight - 2.5 + (offset % 4 === 0 ? -1 : 1)
          if (offset === 0) context.moveTo(x + offset, curlY)
          else context.lineTo(x + offset, curlY)
        }
        context.stroke()
      }

      if (highlight?.strikethrough) {
        context.beginPath()
        context.moveTo(x, y + Math.floor(cellHeight / 2))
        context.lineTo(x + cellWidth, y + Math.floor(cellHeight / 2))
        context.stroke()
      }
    }
  }

  const cursor = snapshot.cursor
  if (
    cursor?.visible &&
    cursor.grid === grid.id &&
    cursor.row >= 0 &&
    cursor.column >= 0 &&
    cursor.row < visibleRows &&
    cursor.column < visibleColumns
  ) {
    const x = cursor.column * cellWidth
    const y = cursor.row * cellHeight
    const cell = cellAt(grid.cells, grid.width, cursor.row, cursor.column)
    const focused = document.hasFocus() && document.activeElement === canvas

    if (focused) {
      context.fillStyle = colorCss(defaultForeground, FALLBACK_FOREGROUND)
      context.fillRect(x, y, cellWidth, cellHeight)
      if (cell.text.trim()) {
        context.font = baseFont()
        context.fillStyle = colorCss(defaultBackground, FALLBACK_BACKGROUND)
        context.fillText(cell.text, x, y + FONT_SIZE + Math.floor((cellHeight - FONT_SIZE) / 2))
      }
    } else {
      context.strokeStyle = colorCss(defaultForeground, FALLBACK_FOREGROUND)
      context.lineWidth = 1
      context.strokeRect(x + 0.5, y + 0.5, cellWidth - 1, cellHeight - 1)
    }
  }

  context.restore()
}

async function sendResizeIfNeeded(): Promise<void> {
  if (connectionPhase !== 'connected') {
    return
  }

  const { columns, rows } = currentGridSize()
  if (columns === lastSentColumns && rows === lastSentRows) {
    return
  }

  lastSentColumns = columns
  lastSentRows = rows
  dimensionsLabel.textContent = `${columns} × ${rows}`

  try {
    await window.codey.resize(columns, rows)
  } catch (error) {
    showLocalError(error)
  }
}

function resizeCanvas(): void {
  const bounds = editorFrame.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  canvasCssWidth = Math.max(1, Math.floor(bounds.width))
  canvasCssHeight = Math.max(1, Math.floor(bounds.height))
  canvas.width = Math.max(1, Math.round(canvasCssWidth * dpr))
  canvas.height = Math.max(1, Math.round(canvasCssHeight * dpr))
  canvas.style.width = `${canvasCssWidth}px`
  canvas.style.height = `${canvasCssHeight}px`
  measureCell()
  scheduleRender()
  void sendResizeIfNeeded()
}

function scheduleResize(): void {
  if (resizeFrame !== 0) {
    return
  }
  resizeFrame = window.requestAnimationFrame(() => {
    resizeFrame = 0
    resizeCanvas()
  })
}

function setStatus(status: ConnectionStatus): void {
  connectionPhase = status.phase
  statusElement.dataset['phase'] = status.phase
  statusLabel.textContent = status.message
  statusLabel.title = status.message

  const busy = status.phase === 'connecting'
  const connected = status.phase === 'connected'
  connectionButton.disabled = busy
  connectionButton.textContent = connected ? 'Disconnect' : busy ? 'Connecting…' : 'Connect'
  hostInput.disabled = busy || connected
  portInput.disabled = busy || connected

  if (connected) {
    emptyState.hidden = true
    const { columns, rows } = currentGridSize()
    dimensionsLabel.textContent = `${columns} × ${rows}`
    canvas.focus()
    void sendResizeIfNeeded()
  } else {
    snapshot = null
    emptyState.hidden = false
    modeLabel.textContent = status.phase === 'error' ? 'ERROR' : 'OFFLINE'
    dimensionsLabel.textContent = '— × —'
    scheduleRender()
  }
}

function showLocalError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  setStatus({ phase: 'error', message })
}

function parsePort(): number {
  const port = Number(portInput.value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port must be an integer from 1 to 65535')
  }
  return port
}

function specialKeyName(key: string): string | null {
  const names: Record<string, string> = {
    Escape: 'Esc',
    Enter: 'CR',
    Backspace: 'BS',
    Tab: 'Tab',
    Delete: 'Del',
    Insert: 'Insert',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown'
  }

  if (key in names) {
    return names[key] ?? null
  }
  if (/^F(?:[1-9]|1[0-2])$/.test(key)) {
    return key
  }
  return null
}

function keyNameFromCode(event: KeyboardEvent): string {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5)
  if (/^Numpad[0-9]$/.test(event.code)) return `k${event.code.slice(6)}`
  if (event.code === 'Space') return 'Space'

  const punctuation: Record<string, string> = {
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/'
  }
  return punctuation[event.code] ?? event.key
}

function keyToNvimInput(event: KeyboardEvent): string | null {
  if (event.isComposing || event.key === 'Dead' || event.key === 'Process' || event.key === 'Unidentified') {
    return null
  }

  const special = specialKeyName(event.key)
  if (special === null && event.key.length !== 1) {
    return null
  }

  // Browsers commonly expose AltGr as Ctrl+Alt. It still produces text and
  // must not be rewritten into a Vim control chord.
  const altGraph = event.getModifierState('AltGraph')
  const hasChordModifier = !altGraph && (event.ctrlKey || event.altKey || event.metaKey)

  if (!special && event.key.length === 1 && !hasChordModifier) {
    return event.key === '<' ? '<lt>' : event.key
  }

  let keyName = special ?? keyNameFromCode(event)
  if (!keyName || keyName.length === 0) {
    return null
  }
  if (keyName === '<') keyName = 'lt'
  if (keyName === '|') keyName = 'Bar'

  const modifiers: string[] = []
  if (event.ctrlKey && !altGraph) modifiers.push('C')
  if (event.shiftKey && (special !== null || hasChordModifier)) modifiers.push('S')
  if (event.altKey && !altGraph) modifiers.push('A')
  if (event.metaKey) modifiers.push('D')

  return `<${modifiers.length > 0 ? `${modifiers.join('-')}-` : ''}${keyName}>`
}

form.addEventListener('submit', (event) => {
  event.preventDefault()

  if (connectionPhase === 'connected') {
    void window.codey.disconnect().catch(showLocalError)
    return
  }

  try {
    const host = hostInput.value.trim()
    const port = parsePort()
    if (!host) throw new Error('Enter the Neovim host address')

    localStorage.setItem('codey.host', host)
    localStorage.setItem('codey.port', String(port))
    const { columns, rows } = currentGridSize()
    lastSentColumns = columns
    lastSentRows = rows
    void window.codey.connect({ host, port, columns, rows }).catch(showLocalError)
  } catch (error) {
    showLocalError(error)
  }
})

canvas.addEventListener('pointerdown', () => canvas.focus())
canvas.addEventListener('keydown', (event) => {
  if (connectionPhase !== 'connected') return
  const keys = keyToNvimInput(event)
  if (keys === null) return
  event.preventDefault()
  event.stopPropagation()
  void window.codey.input(keys).catch(showLocalError)
})

canvas.addEventListener('focus', scheduleRender)
canvas.addEventListener('blur', scheduleRender)
window.addEventListener('focus', scheduleRender)
window.addEventListener('blur', scheduleRender)

window.codey.onStatus(setStatus)
window.codey.onSnapshot((nextSnapshot) => {
  snapshot = nextSnapshot
  emptyState.hidden = true
  modeLabel.textContent = nextSnapshot.mode || 'NORMAL'
  if (nextSnapshot.grid) {
    dimensionsLabel.textContent = `${nextSnapshot.grid.width} × ${nextSnapshot.grid.height}`
  }
  scheduleRender()
})

const savedHost = localStorage.getItem('codey.host')
const savedPort = localStorage.getItem('codey.port')
if (savedHost) hostInput.value = savedHost
if (savedPort) portInput.value = savedPort

new ResizeObserver(scheduleResize).observe(editorFrame)
window.addEventListener('resize', scheduleResize)
resizeCanvas()
