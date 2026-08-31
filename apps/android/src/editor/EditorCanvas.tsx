import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Pressable,
  StyleSheet,
  type GestureResponderEvent,
  type LayoutChangeEvent
} from 'react-native'
import {
  Canvas,
  Picture,
  Rect,
  Skia,
  matchFont,
  type SkFont,
  type SkPicture
} from '@shopify/react-native-skia'
import type {
  Cursor as EditorCursor,
  DefaultColors,
  EditorSnapshot,
  ModeState
} from '@codey/editor-core'

import type { PublishedPerformanceSample } from '../controller'
import { diagnosticLogger } from '../diagnostics/logger'
import {
  useCodeySkiaFontFaces,
  type CodeySkiaFontFaces,
  type CodeySkiaFontLoadState
} from '../fonts/skia'
import {
  EDITOR_CELL_METRICS,
  gridCellForPoint,
  type GridCellPosition
} from '../grid'
import {
  performanceDiagnosticsEnabled,
  performanceNow,
  recordPerformance
} from '../performance'
import {
  recordGridPicture,
  sanitizedPictureDimension,
  visibleGridSize,
  type GridPictureFonts
} from './grid-picture'
import { colorString } from './render-model'

interface EditorCanvasProps {
  readonly snapshot: EditorSnapshot | null
  readonly performanceSamples?: readonly PublishedPerformanceSample[]
  readonly width: number
  readonly height: number
  readonly onLayout: (event: LayoutChangeEvent) => void
  readonly onCellPress?: (position: GridCellPosition) => void
}

const FONT_SIZE = 16
const EMPTY_HIGHLIGHTS: EditorSnapshot['highlights'] = Object.freeze({})
const EMPTY_PERFORMANCE_SAMPLES: readonly PublishedPerformanceSample[] = Object.freeze([])

export const EditorCanvas = memo(function EditorCanvas({
  snapshot,
  performanceSamples = EMPTY_PERFORMANCE_SAMPLES,
  width,
  height,
  onLayout,
  onCellPress
}: EditorCanvasProps) {
  const diagnosticsEnabled = performanceDiagnosticsEnabled()
  const renderStartedAtMs = diagnosticsEnabled ? performanceNow() : undefined
  const fontLoadState = useCodeySkiaFontFaces(FONT_SIZE)
  const fonts = useCommittedGridFonts(fontLoadState)

  const grid = snapshot?.grid ?? null
  const defaultColors = snapshot?.defaultColors ?? null
  const highlights = snapshot?.highlights ?? EMPTY_HIGHLIGHTS
  const pictureWidth = sanitizedPictureDimension(width)
  const pictureHeight = sanitizedPictureDimension(height)
  const visible = visibleGridSize(grid, pictureWidth, pictureHeight)
  const flushCount = snapshot?.flushCount
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      if (grid === null || onCellPress === undefined) return
      const position = gridCellForPoint(
        event.nativeEvent.locationX,
        event.nativeEvent.locationY,
        grid
      )
      if (position !== null) onCellPress(position)
    },
    [grid, onCellPress]
  )

  const { picture, isCurrent: pictureIsCurrent } = useCommittedGridPicture({
    grid,
    defaultColors,
    highlights,
    width: pictureWidth,
    height: pictureHeight,
    fonts,
    flushCount
  })

  // This effect deliberately follows picture ownership in hook order. React
  // runs passive cleanups in declaration order, so the picture is released
  // before the fonts it was recorded with on final unmount.
  useEffect(() => {
    if (fonts === null) return
    return () => disposeFontResource(fonts)
  }, [fonts])

  const cursorElement = useMemo(() => {
    const cursor = snapshot?.cursor ?? null
    const mode = snapshot?.mode
    if (cursor === null || mode === undefined || grid?.id !== cursor.gridId) return null
    return (
      <Cursor
        key="cursor"
        cursor={cursor}
        defaultColors={defaultColors}
        mode={mode}
      />
    )
  }, [defaultColors, grid?.id, snapshot?.cursor, snapshot?.mode])
  const canvasChildren = useMemo(
    () => [
      picture === null ? null : <Picture key="grid-picture" picture={picture} />,
      cursorElement
    ],
    [cursorElement, picture]
  )

  const previousPicture = useRef<SkPicture | null>(null)
  const committedPerformanceSamples = useRef<readonly PublishedPerformanceSample[] | null>(null)
  useLayoutEffect(() => {
    if (picture === null || !pictureIsCurrent) return
    const pictureChanged = previousPicture.current !== picture
    previousPicture.current = picture
    if (!diagnosticsEnabled || renderStartedAtMs === undefined) return
    if (committedPerformanceSamples.current !== performanceSamples) {
      committedPerformanceSamples.current = performanceSamples
      for (const sample of performanceSamples) {
        recordPerformance('key_to_visible', {
          startedAtMs: sample.inputStartedAtMs,
          tags: {
            ...sample,
            gridWidth: grid?.width,
            gridHeight: grid?.height,
            visibleColumns: visible.columns,
            visibleRows: visible.rows,
            pictureChanged
          }
        })
      }
    }
    recordPerformance('renderer_layout_commit', {
      startedAtMs: renderStartedAtMs,
      tags: {
        source: 'renderer',
        flushCount,
        gridWidth: grid?.width,
        gridHeight: grid?.height,
        visibleColumns: visible.columns,
        visibleRows: visible.rows,
        pictureChanged
      }
    })
  })

  return (
    <Pressable
      accessibilityLabel="Neovim editor"
      accessibilityRole="button"
      accessibilityState={{ disabled: grid === null || onCellPress === undefined }}
      disabled={grid === null || onCellPress === undefined}
      onLayout={onLayout}
      onPress={handlePress}
      style={styles.frame}
      testID="editor-canvas-frame"
    >
      <Canvas style={StyleSheet.absoluteFill}>{canvasChildren}</Canvas>
    </Pressable>
  )
})

type ResourceStatus = 'pending' | 'committed' | 'disposed'

interface GridFontResource extends GridPictureFonts {
  status: ResourceStatus
}

interface GridPictureResource {
  readonly picture: SkPicture
  readonly grid: EditorSnapshot['grid'] | null
  readonly defaultColors: DefaultColors | null
  readonly highlights: EditorSnapshot['highlights']
  readonly width: number
  readonly height: number
  readonly fonts: GridFontResource
  status: ResourceStatus
}

interface CommittedGridPictureOptions {
  readonly grid: EditorSnapshot['grid'] | null
  readonly defaultColors: DefaultColors | null
  readonly highlights: EditorSnapshot['highlights']
  readonly width: number
  readonly height: number
  readonly fonts: GridFontResource | null
  readonly flushCount?: number
}

/**
 * Native Skia objects must not be allocated while React is rendering: a
 * StrictMode or concurrent render may be abandoned without ever running an
 * effect cleanup. Create the fonts after commit, publish them with a sync
 * layout update, and release only the unpublished StrictMode probe resource
 * from the creating effect's cleanup.
 */
function useCommittedGridFonts(fontLoadState: CodeySkiaFontLoadState): GridFontResource | null {
  const [resource, setResource] = useState<GridFontResource | null>(null)
  const fallbackLogged = useRef(false)

  useLayoutEffect(() => {
    if (fontLoadState.status === 'pending') return

    let created: GridFontResource
    if (fontLoadState.status === 'ready') {
      try {
        created = createBundledFontResource(fontLoadState.fonts)
      } catch (reason) {
        // A loaded face without a usable typeface is a real load failure. Keep
        // the editor usable with the previous device-font behavior.
        if (!fallbackLogged.current) {
          fallbackLogged.current = true
          diagnosticLogger.warn({
            category: 'renderer',
            event: 'font.bundled_typeface_failed',
            message: 'Bundled editor typefaces were unusable; using the system monospace fallback',
            details: { reason }
          })
        }
        created = createSystemFontResource()
      }
    } else {
      if (!fallbackLogged.current) {
        fallbackLogged.current = true
        diagnosticLogger.warn({
          category: 'renderer',
          event: 'font.system_fallback_selected',
          message: 'Using the system monospace fallback after bundled font load failure',
          details: { error: fontLoadState.error }
        })
      }
      created = createSystemFontResource()
    }
    setResource(created)
    return () => {
      if (created.status === 'pending') disposeFontResource(created)
    }
  }, [fontLoadState.fonts, fontLoadState.status])

  useLayoutEffect(() => {
    if (resource?.status === 'pending') resource.status = 'committed'
  }, [resource])

  if (fontLoadState.status === 'pending') return null
  return resource?.status === 'disposed' ? null : resource
}

/**
 * The currently displayed picture remains valid while a replacement is
 * recorded. Its passive cleanup runs only after React commits the replacement;
 * a picture that never reaches that commit is reclaimed as pending instead.
 */
function useCommittedGridPicture({
  grid,
  defaultColors,
  highlights,
  width,
  height,
  fonts,
  flushCount
}: CommittedGridPictureOptions): {
  readonly picture: SkPicture | null
  readonly isCurrent: boolean
} {
  const [resource, setResource] = useState<GridPictureResource | null>(null)

  useLayoutEffect(() => {
    if (fonts === null) return
    // Font publication is an earlier layout effect, so picture recording never
    // observes the pending font set used by the StrictMode effect probe.
    if (fonts.status !== 'committed') return

    const created: GridPictureResource = {
      picture: recordGridPicture({
        grid,
        defaultColors,
        highlights,
        width,
        height,
        fonts,
        flushCount
      }),
      grid,
      defaultColors,
      highlights,
      width,
      height,
      fonts,
      status: 'pending'
    }
    setResource(created)
    return () => {
      if (created.status === 'pending') disposePictureResource(created)
    }
  }, [defaultColors, fonts, grid, height, highlights, width])

  useLayoutEffect(() => {
    if (resource?.status === 'pending') resource.status = 'committed'
  }, [resource])

  useEffect(() => {
    if (resource === null) return
    return () => disposePictureResource(resource)
  }, [resource])

  const isCurrent =
    resource !== null &&
    resource.status !== 'disposed' &&
    resource.grid === grid &&
    resource.defaultColors === defaultColors &&
    resource.highlights === highlights &&
    resource.width === width &&
    resource.height === height &&
    resource.fonts === fonts

  return {
    picture: resource?.status === 'disposed' ? null : (resource?.picture ?? null),
    isCurrent
  }
}

function createBundledFontResource(source: CodeySkiaFontFaces): GridFontResource {
  const created: SkFont[] = []
  const create = (font: SkFont): SkFont => {
    const typeface = font.getTypeface()
    if (typeface === null) throw new Error('Bundled Nerd Font face has no typeface')
    try {
      const clone = Skia.Font(typeface, FONT_SIZE)
      created.push(clone)
      return clone
    } finally {
      // getTypeface() returns a new host wrapper. Skia.Font retains its own
      // reference to the native typeface, so the temporary wrapper is ours to
      // release even when cloning throws.
      typeface.dispose()
    }
  }

  try {
    return {
      normal: create(source.normal),
      bold: create(source.bold),
      italic: create(source.italic),
      boldItalic: create(source.boldItalic),
      status: 'pending'
    }
  } catch (error) {
    for (let index = created.length - 1; index >= 0; index -= 1) {
      created[index]?.dispose()
    }
    throw error
  }
}

function createSystemFontResource(): GridFontResource {
  const created: SkFont[] = []
  const create = (style: Parameters<typeof matchFont>[0]): SkFont => {
    const font = matchFont(style)
    created.push(font)
    return font
  }

  try {
    return {
      normal: create({ fontFamily: 'monospace', fontSize: FONT_SIZE }),
      bold: create({
        fontFamily: 'monospace',
        fontSize: FONT_SIZE,
        fontWeight: 'bold'
      }),
      italic: create({
        fontFamily: 'monospace',
        fontSize: FONT_SIZE,
        fontStyle: 'italic'
      }),
      boldItalic: create({
        fontFamily: 'monospace',
        fontSize: FONT_SIZE,
        fontWeight: 'bold',
        fontStyle: 'italic'
      }),
      status: 'pending'
    }
  } catch (error) {
    for (let index = created.length - 1; index >= 0; index -= 1) {
      created[index]?.dispose()
    }
    throw error
  }
}

function disposePictureResource(resource: GridPictureResource): void {
  if (resource.status === 'disposed') return
  resource.status = 'disposed'
  resource.picture.dispose()
}

function disposeFontResource(resource: GridFontResource): void {
  if (resource.status === 'disposed') return
  resource.status = 'disposed'
  resource.boldItalic.dispose()
  resource.italic.dispose()
  resource.bold.dispose()
  resource.normal.dispose()
}

function Cursor({
  cursor,
  defaultColors,
  mode
}: {
  readonly cursor: EditorCursor
  readonly defaultColors: DefaultColors | null
  readonly mode: ModeState
}) {
  const info = mode.infos[mode.index]
  const shape = info?.cursor_shape
  const percentage =
    typeof info?.cell_percentage === 'number'
      ? Math.max(10, Math.min(100, info.cell_percentage))
      : 25
  const baseX = cursor.column * EDITOR_CELL_METRICS.width
  const baseY = cursor.row * EDITOR_CELL_METRICS.height
  const color = colorString(defaultColors?.foreground, 0xd7dde4)

  if (shape === 'vertical') {
    return (
      <Rect
        x={baseX}
        y={baseY}
        width={Math.max(1, EDITOR_CELL_METRICS.width * (percentage / 100))}
        height={EDITOR_CELL_METRICS.height}
        color={color}
        opacity={0.75}
      />
    )
  }
  if (shape === 'horizontal') {
    const cursorHeight = Math.max(2, EDITOR_CELL_METRICS.height * (percentage / 100))
    return (
      <Rect
        x={baseX}
        y={baseY + EDITOR_CELL_METRICS.height - cursorHeight}
        width={EDITOR_CELL_METRICS.width}
        height={cursorHeight}
        color={color}
        opacity={0.75}
      />
    )
  }
  return (
    <Rect
      x={baseX}
      y={baseY}
      width={EDITOR_CELL_METRICS.width}
      height={EDITOR_CELL_METRICS.height}
      color={color}
      opacity={0.45}
    />
  )
}

const styles = StyleSheet.create({
  frame: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: '#111419'
  }
})
