export interface GridSize {
  readonly columns: number
  readonly rows: number
}

export interface CellMetrics {
  readonly width: number
  readonly height: number
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

export function sameGridSize(left: GridSize, right: GridSize): boolean {
  return left.columns === right.columns && left.rows === right.rows
}
