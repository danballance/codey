import type {
  DefaultColors,
  Grid,
  HighlightAttributes,
  HighlightDefinition
} from '@codey/editor-core'
import { Systrace } from 'react-native'
import {
  PaintStyle,
  Skia,
  createPicture,
  type SkCanvas,
  type SkFont,
  type SkPaint,
  type SkPath,
  type SkPicture,
  type SkRect
} from '@shopify/react-native-skia'

import { EDITOR_CELL_METRICS } from '../grid'
import { beginPerformance } from '../performance'
import { colorsForDefaults } from './render-model'

const FONT_BASELINE = 17
const EMPTY_CELL = Object.freeze({ text: ' ', highlightId: 0 })

export interface GridPictureFonts {
  readonly normal: SkFont
  readonly bold: SkFont
  readonly italic: SkFont
  readonly boldItalic: SkFont
}

export interface GridPictureOptions {
  readonly grid: Grid | null
  readonly defaultColors: DefaultColors | null
  readonly highlights: Readonly<Record<number, HighlightDefinition>>
  readonly width: number
  readonly height: number
  readonly fonts: GridPictureFonts
  /** Correlation metadata only; it must never participate in picture memoization. */
  readonly flushCount?: number
}

interface CachedHighlight {
  readonly attributes: HighlightAttributes
  readonly colors: ReturnType<typeof colorsForDefaults>
  readonly font: SkFont
  foregroundPaint?: SkPaint
  backgroundPaint?: SkPaint
  specialPaint?: SkPaint
}

interface VisibleGridSize {
  readonly columns: number
  readonly rows: number
}

export function sanitizedPictureDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

export function visibleGridSize(
  grid: Grid | null,
  width: number,
  height: number
): VisibleGridSize {
  if (grid === null) return { columns: 0, rows: 0 }
  return {
    columns: Math.min(
      grid.width,
      Math.max(0, Math.ceil(sanitizedPictureDimension(width) / EDITOR_CELL_METRICS.width))
    ),
    rows: Math.min(
      grid.height,
      Math.max(0, Math.ceil(sanitizedPictureDimension(height) / EDITOR_CELL_METRICS.height))
    )
  }
}

/** Record the immutable grid layer directly from the row-major cell buffer. */
export function recordGridPicture({
  grid,
  defaultColors,
  highlights,
  width,
  height,
  fonts,
  flushCount
}: GridPictureOptions): SkPicture {
  const pictureWidth = sanitizedPictureDimension(width)
  const pictureHeight = sanitizedPictureDimension(height)
  const visible = visibleGridSize(grid, pictureWidth, pictureHeight)
  const finishTiming = beginPerformance('renderer_picture_create', {
    source: 'renderer',
    flushCount,
    gridWidth: grid?.width,
    gridHeight: grid?.height,
    visibleColumns: visible.columns,
    visibleRows: visible.rows,
    pictureChanged: true
  })
  const temporaryResources: Array<{ dispose(): void }> = []
  const highlightCache = new Map<number, CachedHighlight>()
  let undercurl: SkPath | null = null

  const makePaint = (color: string, stroke = false): SkPaint => {
    const paint = Skia.Paint()
    paint.setColor(Skia.Color(color))
    // Skia.Paint() currently defaults to antialiasing, as does the declarative
    // renderer. Set it explicitly so text and decoration parity does not depend
    // on that implementation default changing.
    paint.setAntiAlias(true)
    if (stroke) {
      paint.setStyle(PaintStyle.Stroke)
      paint.setStrokeWidth(1)
    }
    temporaryResources.push(paint)
    return paint
  }

  const cachedHighlight = (highlightId: number): CachedHighlight => {
    const cached = highlightCache.get(highlightId)
    if (cached !== undefined) return cached
    const attributes = highlights[highlightId]?.rgb ?? {}
    const created: CachedHighlight = {
      attributes,
      colors: colorsForDefaults(defaultColors, attributes),
      font: selectFont(attributes, fonts)
    }
    highlightCache.set(highlightId, created)
    return created
  }

  const foregroundPaint = (highlight: CachedHighlight): SkPaint => {
    highlight.foregroundPaint ??= makePaint(highlight.colors.foreground)
    return highlight.foregroundPaint
  }
  const backgroundPaint = (highlight: CachedHighlight): SkPaint => {
    highlight.backgroundPaint ??= makePaint(highlight.colors.background)
    return highlight.backgroundPaint
  }
  const specialPaint = (highlight: CachedHighlight): SkPaint => {
    highlight.specialPaint ??= makePaint(highlight.colors.special, true)
    return highlight.specialPaint
  }
  const undercurlPath = (): SkPath => {
    if (undercurl !== null) return undercurl
    undercurl = Skia.Path.Make()
    undercurl.moveTo(0, 0)
    undercurl.lineTo(2.5, -2)
    undercurl.lineTo(5, 0)
    undercurl.lineTo(7.5, -2)
    undercurl.lineTo(10, 0)
    temporaryResources.push(undercurl)
    return undercurl
  }

  try {
    const pictureBounds =
      pictureWidth > 0 && pictureHeight > 0
        ? drawingRect(0, 0, pictureWidth, pictureHeight)
        : undefined
    const tracing = Systrace.isEnabled()
    if (tracing) {
      Systrace.beginEvent('Codey.GridPicture.record', {
        grid: grid === null ? 'none' : `${grid.width}x${grid.height}`,
        visible: `${visible.columns}x${visible.rows}`
      })
    }
    try {
      return createPicture((canvas) => {
        const defaultBackground = colorsForDefaults(defaultColors, undefined).background
        const defaultBackgroundPaint = makePaint(defaultBackground)
        canvas.drawRect(
          drawingRect(0, 0, pictureWidth, pictureHeight),
          defaultBackgroundPaint
        )

        if (grid === null) return
        drawBackgroundRuns(
          canvas,
          grid,
          visible,
          defaultBackground,
          cachedHighlight,
          backgroundPaint
        )
        drawCellContents(
          canvas,
          grid,
          visible,
          cachedHighlight,
          foregroundPaint,
          specialPaint,
          undercurlPath
        )
      }, pictureBounds)
    } finally {
      if (tracing) Systrace.endEvent()
    }
  } finally {
    for (let index = temporaryResources.length - 1; index >= 0; index -= 1) {
      temporaryResources[index]?.dispose()
    }
    finishTiming()
  }
}

function drawBackgroundRuns(
  canvas: SkCanvas,
  grid: Grid,
  visible: VisibleGridSize,
  defaultBackground: string,
  cachedHighlight: (highlightId: number) => CachedHighlight,
  backgroundPaint: (highlight: CachedHighlight) => SkPaint
): void {
  for (let row = 0; row < visible.rows; row += 1) {
    let runColor: string | null = null
    let runPaint: SkPaint | null = null
    let runStart = 0

    for (let column = 0; column <= visible.columns; column += 1) {
      const highlight = column < visible.columns
        ? cachedHighlight(cellAt(grid, row, column).highlightId)
        : null
      const color =
        highlight !== null && highlight.colors.background !== defaultBackground
          ? highlight.colors.background
          : null

      if (color === runColor) continue
      if (runColor !== null && runPaint !== null) {
        canvas.drawRect(
          drawingRect(
            runStart * EDITOR_CELL_METRICS.width,
            row * EDITOR_CELL_METRICS.height,
            (column - runStart) * EDITOR_CELL_METRICS.width,
            EDITOR_CELL_METRICS.height
          ),
          runPaint
        )
      }
      runColor = color
      runStart = column
      runPaint = highlight === null || color === null ? null : backgroundPaint(highlight)
    }
  }
}

function drawCellContents(
  canvas: SkCanvas,
  grid: Grid,
  visible: VisibleGridSize,
  cachedHighlight: (highlightId: number) => CachedHighlight,
  foregroundPaint: (highlight: CachedHighlight) => SkPaint,
  specialPaint: (highlight: CachedHighlight) => SkPaint,
  undercurlPath: () => SkPath
): void {
  for (let row = 0; row < visible.rows; row += 1) {
    for (let column = 0; column < visible.columns; column += 1) {
      const cell = cellAt(grid, row, column)
      const highlight = cachedHighlight(cell.highlightId)
      const x = column * EDITOR_CELL_METRICS.width
      const y = row * EDITOR_CELL_METRICS.height

      if (cell.text.length > 0 && cell.text !== ' ') {
        canvas.drawText(
          cell.text,
          x,
          y + FONT_BASELINE,
          foregroundPaint(highlight),
          highlight.font
        )
      }

      const attributes = highlight.attributes
      if (attributes.underline === true) {
        canvas.drawLine(
          x,
          y + EDITOR_CELL_METRICS.height - 2,
          x + EDITOR_CELL_METRICS.width,
          y + EDITOR_CELL_METRICS.height - 2,
          specialPaint(highlight)
        )
      }
      if (attributes.undercurl === true) {
        canvas.save()
        canvas.translate(x, y + EDITOR_CELL_METRICS.height - 2)
        canvas.drawPath(undercurlPath(), specialPaint(highlight))
        canvas.restore()
      }
      if (attributes.strikethrough === true) {
        canvas.drawLine(
          x,
          y + EDITOR_CELL_METRICS.height / 2,
          x + EDITOR_CELL_METRICS.width,
          y + EDITOR_CELL_METRICS.height / 2,
          specialPaint(highlight)
        )
      }
    }
  }
}

function cellAt(grid: Grid, row: number, column: number) {
  return grid.cells[row * grid.width + column] ?? EMPTY_CELL
}

function drawingRect(
  x: number,
  y: number,
  width: number,
  height: number
): SkRect {
  // Plain rects are accepted by the public canvas API and avoid allocating a
  // disposable JSI SkHostRect for every background run.
  return { x, y, width, height }
}

function selectFont(
  attributes: HighlightAttributes,
  fonts: GridPictureFonts
): SkFont {
  if (attributes.bold === true) {
    return attributes.italic === true ? fonts.boldItalic : fonts.bold
  }
  return attributes.italic === true ? fonts.italic : fonts.normal
}
