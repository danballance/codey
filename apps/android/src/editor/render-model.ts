import type {
  EditorSnapshot,
  GridCell,
  HighlightAttributes
} from '@codey/editor-core'

export const FALLBACK_FOREGROUND = 0xd7dde4
export const FALLBACK_BACKGROUND = 0x111419

export interface CellColors {
  readonly foreground: string
  readonly background: string
  readonly special: string
}

export interface RenderCell extends GridCell {
  readonly row: number
  readonly column: number
  readonly colors: CellColors
  readonly attributes: HighlightAttributes
}

export function colorString(value: unknown, fallback: number): string {
  const color = validRgb(value) ?? validRgb(fallback) ?? 0
  return `#${color.toString(16).padStart(6, '0')}`
}

export function colorsForSnapshot(
  snapshot: EditorSnapshot,
  attributes: HighlightAttributes | undefined
): CellColors {
  const defaultForeground = validRgb(snapshot.defaultColors?.foreground) ?? FALLBACK_FOREGROUND
  const defaultBackground = validRgb(snapshot.defaultColors?.background) ?? FALLBACK_BACKGROUND
  const defaultSpecial = validRgb(snapshot.defaultColors?.special) ?? defaultForeground
  let foreground = colorString(attributes?.foreground, defaultForeground)
  let background = colorString(attributes?.background, defaultBackground)
  if (attributes?.reverse === true) [foreground, background] = [background, foreground]

  return {
    foreground,
    background,
    special: colorString(attributes?.special, defaultSpecial)
  }
}

function validRgb(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value) & 0xffffff
    : null
}

export function renderCells(
  snapshot: EditorSnapshot,
  visibleColumns: number,
  visibleRows: number
): readonly RenderCell[] {
  const grid = snapshot.grid
  if (grid === null) return []
  const columns = Math.min(grid.width, Math.max(0, visibleColumns))
  const rows = Math.min(grid.height, Math.max(0, visibleRows))
  const cells: RenderCell[] = []

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const cell = grid.cells[row * grid.width + column] ?? { text: ' ', highlightId: 0 }
      const attributes = snapshot.highlights[cell.highlightId]?.rgb ?? {}
      cells.push({
        ...cell,
        row,
        column,
        attributes,
        colors: colorsForSnapshot(snapshot, attributes)
      })
    }
  }
  return cells
}
