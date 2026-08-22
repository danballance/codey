import type {
  DefaultColors,
  Grid,
  HighlightDefinition
} from '@codey/editor-core'
import { Systrace } from 'react-native'

jest.mock('../performance', () => ({
  beginPerformance: () => () => undefined
}))

jest.mock('@shopify/react-native-skia', () => {
  const current = () =>
    (globalThis as typeof globalThis & { __gridPictureTestState: TestState })
      .__gridPictureTestState

  return {
    PaintStyle: { Fill: 0, Stroke: 1 },
    Skia: {
      Color: (color: string) => color,
      Paint: () => {
        const state = current()
        const paint: FakePaint = {
          color: '',
          style: 0,
          strokeWidth: 0,
          setColor: jest.fn((color: string) => {
            paint.color = color
          }),
          setAntiAlias: jest.fn(),
          setStyle: jest.fn((style: number) => {
            paint.style = style
          }),
          setStrokeWidth: jest.fn((strokeWidth: number) => {
            paint.strokeWidth = strokeWidth
          }),
          dispose: jest.fn()
        }
        state.paints.push(paint)
        return paint
      },
      Path: {
        Make: () => {
          const state = current()
          const path: FakePath = {
            points: [],
            moveTo: jest.fn((x: number, y: number) => {
              path.points.push([x, y])
            }),
            lineTo: jest.fn((x: number, y: number) => {
              path.points.push([x, y])
            }),
            dispose: jest.fn()
          }
          state.paths.push(path)
          return path
        }
      },
      XYWHRect: (x: number, y: number, width: number, height: number) => ({
        x,
        y,
        width,
        height
      })
    },
    createPicture: (
      callback: (canvas: TestState['canvas']) => void,
      bounds?: {
        readonly x: number
        readonly y: number
        readonly width: number
        readonly height: number
      }
    ) => {
      const state = current()
      state.bounds.push(bounds)
      callback(state.canvas)
      const picture = { __typename__: 'Picture', dispose: jest.fn() }
      state.pictures.push(picture)
      return picture
    }
  }
})

import {
  recordGridPicture,
  sanitizedPictureDimension,
  visibleGridSize,
  type GridPictureFonts
} from '../editor/grid-picture'

interface FakePaint {
  color: string
  style: number
  strokeWidth: number
  readonly setColor: jest.Mock
  readonly setAntiAlias: jest.Mock
  readonly setStyle: jest.Mock
  readonly setStrokeWidth: jest.Mock
  readonly dispose: jest.Mock
}

interface FakePath {
  readonly points: Array<readonly [number, number]>
  readonly moveTo: jest.Mock
  readonly lineTo: jest.Mock
  readonly dispose: jest.Mock
}

type DrawCommand =
  | {
      readonly kind: 'rect'
      readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
      readonly color: string
    }
  | {
      readonly kind: 'text'
      readonly text: string
      readonly x: number
      readonly y: number
      readonly color: string
      readonly font: unknown
    }
  | {
      readonly kind: 'line'
      readonly x0: number
      readonly y0: number
      readonly x1: number
      readonly y1: number
      readonly color: string
    }
  | {
      readonly kind: 'path'
      readonly path: FakePath
      readonly color: string
      readonly translation: { readonly x: number; readonly y: number }
    }

interface TestState {
  readonly commands: DrawCommand[]
  readonly paints: FakePaint[]
  readonly paths: FakePath[]
  readonly pictures: Array<{ readonly dispose: jest.Mock }>
  readonly bounds: Array<{
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  } | undefined>
  readonly trace: Array<
    | {
        readonly kind: 'begin'
        readonly name: string
        readonly args: Readonly<Record<string, string>>
      }
    | { readonly kind: 'end' }
  >
  readonly canvas: {
    drawRect(rect: Extract<DrawCommand, { kind: 'rect' }>['rect'], paint: FakePaint): void
    drawText(text: string, x: number, y: number, paint: FakePaint, font: unknown): void
    drawLine(x0: number, y0: number, x1: number, y1: number, paint: FakePaint): void
    drawPath(path: FakePath, paint: FakePaint): void
    save(): number
    translate(x: number, y: number): void
    restore(): void
  }
}

const defaultColors: DefaultColors = {
  foreground: 0xffffff,
  background: 0x101112,
  special: 0xff00ff,
  ctermForeground: 15,
  ctermBackground: 0
}

const fonts = {
  normal: { name: 'normal' },
  bold: { name: 'bold' },
  italic: { name: 'italic' },
  boldItalic: { name: 'bold-italic' }
} as unknown as GridPictureFonts

describe('imperative Skia grid picture', () => {
  beforeEach(() => {
    ;(globalThis as typeof globalThis & { __gridPictureTestState: TestState })
      .__gridPictureTestState = createTestState()
    jest.spyOn(Systrace, 'isEnabled').mockReturnValue(true)
    jest.spyOn(Systrace, 'beginEvent').mockImplementation((name, args) => {
      currentState().trace.push({
        kind: 'begin',
        name: typeof name === 'function' ? name() : name,
        args: args ?? {}
      })
    })
    jest.spyOn(Systrace, 'endEvent').mockImplementation(() => {
      currentState().trace.push({ kind: 'end' })
    })
  })

  afterEach(() => jest.restoreAllMocks())

  it('merges background runs while skipping blank and wide-continuation glyphs', () => {
    const grid: Grid = {
      id: 1,
      width: 6,
      height: 1,
      cells: [
        { text: '界', highlightId: 1 },
        { text: '', highlightId: 1 },
        { text: ' ', highlightId: 0 },
        { text: 'A', highlightId: 2 },
        { text: 'B', highlightId: 3 },
        { text: ' ', highlightId: 1 }
      ]
    }
    const highlights = definitions({
      1: { foreground: 0xffffff, background: 0x0000ff },
      2: { foreground: 0xffffff, background: 0x00ff00 },
      3: { foreground: 0xffffff, background: 0x00ff00 }
    })

    recordGridPicture({
      grid,
      defaultColors,
      highlights,
      width: 60,
      height: 22,
      fonts
    })

    const state = currentState()
    expect(state.bounds).toEqual([{ x: 0, y: 0, width: 60, height: 22 }])
    expect(state.trace).toEqual([
      {
        kind: 'begin',
        name: 'Codey.GridPicture.record',
        args: { grid: '6x1', visible: '6x1' }
      },
      { kind: 'end' }
    ])
    expect(state.commands.filter(isRect)).toEqual([
      { kind: 'rect', rect: { x: 0, y: 0, width: 60, height: 22 }, color: '#101112' },
      { kind: 'rect', rect: { x: 0, y: 0, width: 20, height: 22 }, color: '#0000ff' },
      { kind: 'rect', rect: { x: 30, y: 0, width: 20, height: 22 }, color: '#00ff00' },
      { kind: 'rect', rect: { x: 50, y: 0, width: 10, height: 22 }, color: '#0000ff' }
    ])
    expect(state.commands.filter(isText).map((command) => command.text)).toEqual([
      '界',
      'A',
      'B'
    ])
  })

  it('preserves font variants, reverse colors, decorations, and Unicode', () => {
    const grid: Grid = {
      id: 1,
      width: 4,
      height: 1,
      cells: [
        { text: 'λ', highlightId: 1 },
        { text: 'B', highlightId: 2 },
        { text: 'é', highlightId: 3 },
        { text: '界', highlightId: 4 }
      ]
    }
    const highlights = definitions({
      1: {},
      2: { bold: true },
      3: { italic: true },
      4: {
        foreground: 0xaabbcc,
        background: 0x010203,
        special: 0xff0000,
        reverse: true,
        bold: true,
        italic: true,
        underline: true,
        undercurl: true,
        strikethrough: true
      }
    })

    recordGridPicture({
      grid,
      defaultColors,
      highlights,
      width: 40,
      height: 22,
      fonts
    })

    const state = currentState()
    const text = state.commands.filter(isText)
    expect(text.map((command) => command.text)).toEqual(['λ', 'B', 'é', '界'])
    expect(text.map((command) => command.font)).toEqual([
      fonts.normal,
      fonts.bold,
      fonts.italic,
      fonts.boldItalic
    ])
    expect(text[3]).toMatchObject({ x: 30, y: 17, color: '#010203' })
    expect(state.commands.filter(isLine)).toEqual([
      { kind: 'line', x0: 30, y0: 20, x1: 40, y1: 20, color: '#ff0000' },
      { kind: 'line', x0: 30, y0: 11, x1: 40, y1: 11, color: '#ff0000' }
    ])
    expect(state.commands.filter(isPath)).toEqual([
      expect.objectContaining({
        kind: 'path',
        color: '#ff0000',
        translation: { x: 30, y: 20 }
      })
    ])
    expect(state.paths[0]?.points).toEqual([
      [0, 0],
      [2.5, -2],
      [5, 0],
      [7.5, -2],
      [10, 0]
    ])
  })

  it('caches paints and the undercurl path per highlight and disposes recording resources', () => {
    const grid: Grid = {
      id: 1,
      width: 3,
      height: 1,
      cells: [
        { text: 'a', highlightId: 7 },
        { text: 'b', highlightId: 7 },
        { text: 'c', highlightId: 7 }
      ]
    }
    const highlights = definitions({
      7: {
        foreground: 0xffffff,
        background: 0x222222,
        special: 0xff0000,
        underline: true,
        undercurl: true,
        strikethrough: true
      }
    })

    const picture = recordGridPicture({
      grid,
      defaultColors,
      highlights,
      width: 30,
      height: 22,
      fonts
    })

    const state = currentState()
    expect(state.paints).toHaveLength(4)
    expect(state.paths).toHaveLength(1)
    expect(state.paints.every((paint) => paint.dispose.mock.calls.length === 1)).toBe(true)
    expect(
      state.paints.every(
        (paint) => paint.setAntiAlias.mock.calls.length === 1 && paint.setAntiAlias.mock.calls[0]?.[0] === true
      )
    ).toBe(true)
    expect(state.paths[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(picture.dispose).not.toHaveBeenCalled()
  })

  it('clips recording to ceil-visible cells and normalizes invalid bounds', () => {
    const grid: Grid = {
      id: 1,
      width: 3,
      height: 2,
      cells: Array.from({ length: 6 }, (_, index) => ({
        text: String(index),
        highlightId: 0
      }))
    }

    expect(visibleGridSize(grid, 10.1, 22.1)).toEqual({ columns: 2, rows: 2 })
    expect(visibleGridSize(grid, -1, Number.NaN)).toEqual({ columns: 0, rows: 0 })
    expect(sanitizedPictureDimension(Number.POSITIVE_INFINITY)).toBe(0)

    recordGridPicture({
      grid,
      defaultColors,
      highlights: {},
      width: 15,
      height: 22,
      fonts
    })
    expect(currentState().commands.filter(isText).map((command) => command.text)).toEqual([
      '0',
      '1'
    ])
  })
})

function createTestState(): TestState {
  const commands: DrawCommand[] = []
  let translation = { x: 0, y: 0 }
  const translations: Array<{ x: number; y: number }> = []
  return {
    commands,
    paints: [],
    paths: [],
    pictures: [],
    bounds: [],
    trace: [],
    canvas: {
      drawRect: (rect, paint) => {
        commands.push({ kind: 'rect', rect, color: paint.color })
      },
      drawText: (text, x, y, paint, font) => {
        commands.push({ kind: 'text', text, x, y, color: paint.color, font })
      },
      drawLine: (x0, y0, x1, y1, paint) => {
        commands.push({ kind: 'line', x0, y0, x1, y1, color: paint.color })
      },
      drawPath: (path, paint) => {
        commands.push({ kind: 'path', path, color: paint.color, translation: { ...translation } })
      },
      save: () => {
        translations.push({ ...translation })
        return translations.length
      },
      translate: (x, y) => {
        translation = { x: translation.x + x, y: translation.y + y }
      },
      restore: () => {
        translation = translations.pop() ?? { x: 0, y: 0 }
      }
    }
  }
}

function currentState(): TestState {
  return (globalThis as typeof globalThis & { __gridPictureTestState: TestState })
    .__gridPictureTestState
}

function definitions(
  attributes: Readonly<Record<number, HighlightDefinition['rgb']>>
): Readonly<Record<number, HighlightDefinition>> {
  return Object.fromEntries(
    Object.entries(attributes).map(([id, rgb]) => [
      Number(id),
      { id: Number(id), rgb, cterm: {}, info: [] }
    ])
  )
}

function isRect(command: DrawCommand): command is Extract<DrawCommand, { kind: 'rect' }> {
  return command.kind === 'rect'
}

function isText(command: DrawCommand): command is Extract<DrawCommand, { kind: 'text' }> {
  return command.kind === 'text'
}

function isLine(command: DrawCommand): command is Extract<DrawCommand, { kind: 'line' }> {
  return command.kind === 'line'
}

function isPath(command: DrawCommand): command is Extract<DrawCommand, { kind: 'path' }> {
  return command.kind === 'path'
}
