export interface GridSize {
  readonly columns: number
  readonly rows: number
}

export interface CellMetrics {
  readonly width: number
  readonly height: number
}

export interface GridDimensions {
  readonly width: number
  readonly height: number
}

export interface GridCellPosition {
  readonly row: number
  readonly column: number
}

export const EDITOR_CELL_METRICS: CellMetrics = Object.freeze({
  width: 10,
  height: 22
})

const MAX_GRID_DIMENSION = 1_000

export function gridSizeForBounds(
  width: number,
  height: number,
  metrics: CellMetrics = EDITOR_CELL_METRICS
): GridSize {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(metrics.width) ||
    !Number.isFinite(metrics.height) ||
    metrics.width <= 0 ||
    metrics.height <= 0
  ) {
    return { columns: 2, rows: 2 }
  }

  return {
    columns: Math.min(MAX_GRID_DIMENSION, Math.max(2, Math.floor(width / metrics.width))),
    rows: Math.min(MAX_GRID_DIMENSION, Math.max(2, Math.floor(height / metrics.height)))
  }
}

export function gridCellForPoint(
  x: number,
  y: number,
  grid: GridDimensions,
  metrics: CellMetrics = EDITOR_CELL_METRICS
): GridCellPosition | null {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    !Number.isSafeInteger(grid.width) ||
    !Number.isSafeInteger(grid.height) ||
    grid.width <= 0 ||
    grid.height <= 0 ||
    !Number.isFinite(metrics.width) ||
    !Number.isFinite(metrics.height) ||
    metrics.width <= 0 ||
    metrics.height <= 0
  ) {
    return null
  }

  const column = Math.floor(x / metrics.width)
  const row = Math.floor(y / metrics.height)
  if (column >= grid.width || row >= grid.height) return null
  return { row, column }
}

export function sameGridSize(left: GridSize, right: GridSize): boolean {
  return left.columns === right.columns && left.rows === right.rows
}
