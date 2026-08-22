import { memo, useMemo } from 'react'
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native'
import {
  Canvas,
  Group,
  Line,
  Path,
  Rect,
  Skia,
  Text as SkiaText,
  matchFont
} from '@shopify/react-native-skia'
import type { EditorSnapshot, HighlightAttributes } from '@codey/editor-core'

import { EDITOR_CELL_METRICS } from '../grid'
import {
  FALLBACK_BACKGROUND,
  colorString,
  renderCells,
  type RenderCell
} from './render-model'

interface EditorCanvasProps {
  readonly snapshot: EditorSnapshot | null
  readonly width: number
  readonly height: number
  readonly onLayout: (event: LayoutChangeEvent) => void
}

const FONT_SIZE = 16
const FONT_BASELINE = 17

export const EditorCanvas = memo(function EditorCanvas({
  snapshot,
  width,
  height,
  onLayout
}: EditorCanvasProps) {
  const normalFont = useMemo(
    () => matchFont({ fontFamily: 'monospace', fontSize: FONT_SIZE }),
    []
  )
  const boldFont = useMemo(
    () => matchFont({ fontFamily: 'monospace', fontSize: FONT_SIZE, fontWeight: 'bold' }),
    []
  )
  const italicFont = useMemo(
    () => matchFont({ fontFamily: 'monospace', fontSize: FONT_SIZE, fontStyle: 'italic' }),
    []
  )
  const boldItalicFont = useMemo(
    () =>
      matchFont({
        fontFamily: 'monospace',
        fontSize: FONT_SIZE,
        fontWeight: 'bold',
        fontStyle: 'italic'
      }),
    []
  )

  const cells = useMemo(
    () =>
      snapshot === null
        ? []
        : renderCells(
            snapshot,
            Math.ceil(width / EDITOR_CELL_METRICS.width),
            Math.ceil(height / EDITOR_CELL_METRICS.height)
          ),
    [height, snapshot, width]
  )

  const background =
    snapshot === null
      ? colorString(undefined, FALLBACK_BACKGROUND)
      : colorString(snapshot.defaultColors?.background, FALLBACK_BACKGROUND)

  return (
    <View onLayout={onLayout} style={styles.frame} testID="editor-canvas-frame">
      <Canvas style={StyleSheet.absoluteFill}>
        <Rect x={0} y={0} width={Math.max(0, width)} height={Math.max(0, height)} color={background} />
        {cells.map((cell) => (
          <Rect
            key={`background:${cell.row}:${cell.column}`}
            x={cell.column * EDITOR_CELL_METRICS.width}
            y={cell.row * EDITOR_CELL_METRICS.height}
            width={EDITOR_CELL_METRICS.width}
            height={EDITOR_CELL_METRICS.height}
            color={cell.colors.background}
          />
        ))}
        {cells.map((cell) => {
          const attributes = cell.attributes
          const font = attributes.bold === true
            ? attributes.italic === true
              ? boldItalicFont
              : boldFont
            : attributes.italic === true
              ? italicFont
              : normalFont
          return (
            <Group key={`foreground:${cell.row}:${cell.column}`}>
              {cell.text.length > 0 && cell.text !== ' ' ? (
                <SkiaText
                  x={cell.column * EDITOR_CELL_METRICS.width}
                  y={cell.row * EDITOR_CELL_METRICS.height + FONT_BASELINE}
                  text={cell.text}
                  color={cell.colors.foreground}
                  font={font}
                />
              ) : null}
              <CellDecorations cell={cell} />
            </Group>
          )
        })}
        {snapshot !== null &&
        snapshot.cursor !== null &&
        snapshot.grid?.id === snapshot.cursor.gridId ? (
          <Cursor snapshot={snapshot} />
        ) : null}
      </Canvas>
    </View>
  )
})

function CellDecorations({ cell }: { readonly cell: RenderCell }) {
  const x = cell.column * EDITOR_CELL_METRICS.width
  const y = cell.row * EDITOR_CELL_METRICS.height
  const attributes = cell.attributes
  const decorations = []

  if (attributes.underline === true) {
    decorations.push(
      <Line
        key="underline"
        p1={{ x, y: y + EDITOR_CELL_METRICS.height - 2 }}
        p2={{ x: x + EDITOR_CELL_METRICS.width, y: y + EDITOR_CELL_METRICS.height - 2 }}
        color={cell.colors.special}
        strokeWidth={1}
      />
    )
  }
  if (attributes.undercurl === true) {
    decorations.push(
      <Path
        key="undercurl"
        path={undercurlPath(x, y + EDITOR_CELL_METRICS.height - 2)}
        color={cell.colors.special}
        style="stroke"
        strokeWidth={1}
      />
    )
  }
  if (attributes.strikethrough === true) {
    decorations.push(
      <Line
        key="strikethrough"
        p1={{ x, y: y + EDITOR_CELL_METRICS.height / 2 }}
        p2={{ x: x + EDITOR_CELL_METRICS.width, y: y + EDITOR_CELL_METRICS.height / 2 }}
        color={cell.colors.special}
        strokeWidth={1}
      />
    )
  }
  return decorations
}

function Cursor({ snapshot }: { readonly snapshot: EditorSnapshot }) {
  const cursor = snapshot.cursor!
  const info = snapshot.mode.infos[snapshot.mode.index] as HighlightAttributes | undefined
  const shape = info?.cursor_shape
  const percentage =
    typeof info?.cell_percentage === 'number' ? Math.max(10, Math.min(100, info.cell_percentage)) : 25
  const baseX = cursor.column * EDITOR_CELL_METRICS.width
  const baseY = cursor.row * EDITOR_CELL_METRICS.height
  const color = colorString(snapshot.defaultColors?.foreground, 0xd7dde4)

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

function undercurlPath(x: number, y: number) {
  const path = Skia.Path.Make()
  path.moveTo(x, y)
  path.lineTo(x + 2.5, y - 2)
  path.lineTo(x + 5, y)
  path.lineTo(x + 7.5, y - 2)
  path.lineTo(x + 10, y)
  return path
}

const styles = StyleSheet.create({
  frame: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: '#111419'
  }
})
