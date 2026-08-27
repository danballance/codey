import type { EditorSnapshot, Grid } from '@codey/editor-core'
import { StrictMode, Suspense, startTransition, useState } from 'react'
import { act, fireEvent, render } from '@testing-library/react-native'

jest.mock('../performance', () => ({
  performanceDiagnosticsEnabled: () => Boolean(
    (globalThis as typeof globalThis & {
      __editorCanvasTestState?: EditorCanvasTestState
    }).__editorCanvasTestState?.diagnosticsEnabled
  ),
  performanceNow: () => 0,
  recordPerformance: jest.fn()
}))

jest.mock('../fonts/skia', () => ({
  useCodeySkiaFontFaces: () => {
    const state = (
      globalThis as typeof globalThis & { __editorCanvasTestState: EditorCanvasTestState }
    ).__editorCanvasTestState
    if (state.fontLoadStatus === 'pending') {
      return { status: 'pending', fonts: null, error: null }
    }
    if (state.fontLoadStatus === 'error') {
      return { status: 'error', fonts: null, error: state.fontLoadError }
    }
    return { status: 'ready', fonts: state.sourceFonts, error: null }
  }
}))

jest.mock('../editor/grid-picture', () => ({
  recordGridPicture: (options: unknown) => {
    const state = (
      globalThis as typeof globalThis & { __editorCanvasTestState: EditorCanvasTestState }
    ).__editorCanvasTestState
    const picture = {
      __typename__: 'Picture',
      id: state.pictures.length + 1,
      dispose: jest.fn()
    }
    state.recordings.push(options)
    state.pictures.push(picture)
    return picture
  },
  sanitizedPictureDimension: (value: number) =>
    Number.isFinite(value) ? Math.max(0, value) : 0,
  visibleGridSize: (grid: Grid | null, width: number, height: number) => ({
    columns: grid === null ? 0 : Math.min(grid.width, Math.max(0, Math.ceil(width / 10))),
    rows: grid === null ? 0 : Math.min(grid.height, Math.max(0, Math.ceil(height / 22)))
  })
}))

jest.mock('@shopify/react-native-skia', () => {
  const React = require('react') as typeof import('react')
  const { View } = require('react-native') as typeof import('react-native')
  return {
    Canvas: ({ children }: { readonly children?: React.ReactNode }) =>
      React.createElement(View, { testID: 'skia-canvas' }, children),
    Picture: ({ picture }: { readonly picture: { readonly id: number } }) =>
      React.createElement(View, {
        testID: 'skia-picture',
        accessibilityLabel: `picture-${picture.id}`
      }),
    Rect: (props: Readonly<Record<string, unknown>>) =>
      React.createElement(View, { ...props, testID: 'skia-cursor' }),
    Skia: {
      Font: (typeface: unknown, fontSize: number) =>
        mockCreateTestFont({ source: 'bundled', typeface, fontSize })
    },
    matchFont: (style: Readonly<Record<string, unknown>>) => {
      return mockCreateTestFont({ source: 'system', ...style })
    }
  }
})

import { EditorCanvas } from '../editor/EditorCanvas'
import { recordPerformance } from '../performance'

interface TestPicture {
  readonly id: number
  readonly dispose: jest.Mock
}

interface TestFont {
  readonly id: number
  readonly style: Readonly<Record<string, unknown>>
  readonly dispose: jest.Mock
}

interface TestSourceFont {
  readonly getTypeface: jest.Mock
}

interface TestTypeface {
  readonly face: string
  readonly dispose: jest.Mock
}

interface EditorCanvasTestState {
  readonly recordings: unknown[]
  readonly pictures: TestPicture[]
  readonly fonts: TestFont[]
  readonly typefaces: TestTypeface[]
  readonly sourceFonts: {
    readonly normal: TestSourceFont
    readonly bold: TestSourceFont
    readonly italic: TestSourceFont
    readonly boldItalic: TestSourceFont
  }
  fontLoadStatus: 'pending' | 'ready' | 'error'
  fontLoadError: Error
  diagnosticsEnabled: boolean
}

const grid: Grid = {
  id: 1,
  width: 2,
  height: 1,
  cells: [
    { text: 'A', highlightId: 0 },
    { text: '界', highlightId: 0 }
  ]
}

const defaultColors = {
  foreground: 0xffffff,
  background: 0x101112,
  special: 0xff00ff,
  ctermForeground: 15,
  ctermBackground: 0
}

function snapshot(overrides: Partial<EditorSnapshot> = {}): EditorSnapshot {
  return {
    grid,
    cursor: { gridId: 1, row: 0, column: 0 },
    defaultColors,
    highlights: {},
    mode: {
      cursorStyleEnabled: true,
      infos: [{ cursor_shape: 'vertical', cell_percentage: 30 }],
      name: 'insert',
      index: 0
    },
    flushCount: 1,
    ...overrides
  }
}

describe('EditorCanvas picture lifecycle', () => {
  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { __editorCanvasTestState: EditorCanvasTestState }
    ).__editorCanvasTestState = {
      recordings: [],
      pictures: [],
      fonts: [],
      typefaces: [],
      sourceFonts: {
        normal: sourceFont('normal'),
        bold: sourceFont('bold'),
        italic: sourceFont('italic'),
        boldItalic: sourceFont('boldItalic')
      },
      fontLoadStatus: 'ready',
      fontLoadError: new Error('Bundled font failed'),
      diagnosticsEnabled: false
    }
    jest.mocked(recordPerformance).mockClear()
  })

  it('maps a completed canvas press to a visible grid cell', () => {
    const onCellPress = jest.fn()
    const screen = render(
      <EditorCanvas
        height={44}
        onCellPress={onCellPress}
        onLayout={jest.fn()}
        snapshot={snapshot({
          grid: {
            id: 1,
            width: 3,
            height: 2,
            cells: Array.from({ length: 6 }, () => ({ text: ' ', highlightId: 0 }))
          }
        })}
        width={35}
      />
    )

    fireEvent.press(screen.getByTestId('editor-canvas-frame'), {
      nativeEvent: { locationX: 19.5, locationY: 23 }
    })
    expect(onCellPress).toHaveBeenCalledWith({ row: 1, column: 1 })

    fireEvent.press(screen.getByTestId('editor-canvas-frame'), {
      nativeEvent: { locationX: 31, locationY: 23 }
    })
    expect(onCellPress).toHaveBeenCalledTimes(1)
  })

  it('disables touch dispatch without a current grid or callback', () => {
    const onCellPress = jest.fn()
    const screen = render(
      <EditorCanvas
        height={22}
        onCellPress={onCellPress}
        onLayout={jest.fn()}
        snapshot={snapshot({ grid: null })}
        width={20}
      />
    )

    expect(screen.getByTestId('editor-canvas-frame').props.accessibilityState).toEqual({
      disabled: true
    })
    fireEvent.press(screen.getByTestId('editor-canvas-frame'), {
      nativeEvent: { locationX: 1, locationY: 1 }
    })
    expect(onCellPress).not.toHaveBeenCalled()
  })

  it('does not use the system font while bundled faces are still pending', () => {
    const state = currentState()
    state.fontLoadStatus = 'pending'
    const screen = render(
      <EditorCanvas height={22} onLayout={jest.fn()} snapshot={snapshot()} width={20} />
    )

    expect(state.fonts).toHaveLength(0)
    expect(state.recordings).toHaveLength(0)
    expect(screen.queryByTestId('skia-picture')).toBeNull()

    state.fontLoadStatus = 'ready'
    screen.rerender(
      <EditorCanvas height={22} onLayout={jest.fn()} snapshot={snapshot()} width={20} />
    )
    expect(state.fonts).toHaveLength(4)
    expect(state.fonts.every((font) => font.style.source === 'bundled')).toBe(true)
    expect(state.recordings).toHaveLength(1)
  })

  it('uses system monospace only after a bundled-font load error', () => {
    const state = currentState()
    state.fontLoadStatus = 'error'
    const screen = render(
      <EditorCanvas height={22} onLayout={jest.fn()} snapshot={snapshot()} width={20} />
    )

    expect(screen.getByTestId('skia-picture')).toBeTruthy()
    expect(state.fonts).toHaveLength(4)
    expect(state.fonts.every((font) => font.style.source === 'system')).toBe(true)
    expect(state.fonts.map((font) => font.style.fontFamily)).toEqual([
      'monospace',
      'monospace',
      'monospace',
      'monospace'
    ])
  })

  it('replaces and disposes a timeout fallback when bundled faces arrive late', () => {
    const state = currentState()
    const initial = snapshot()
    state.fontLoadStatus = 'pending'
    const screen = render(
      <EditorCanvas height={22} onLayout={jest.fn()} snapshot={initial} width={20} />
    )
    expect(state.fonts).toHaveLength(0)
    expect(state.pictures).toHaveLength(0)

    state.fontLoadStatus = 'error'
    screen.rerender(
      <EditorCanvas height={22} onLayout={jest.fn()} snapshot={initial} width={20} />
    )
    const systemFonts = state.fonts.slice()
    const systemPicture = state.pictures[0]
    expect(systemFonts).toHaveLength(4)
    expect(systemFonts.every((font) => font.style.source === 'system')).toBe(true)
    expect(systemPicture?.dispose).not.toHaveBeenCalled()

    state.fontLoadStatus = 'ready'
    screen.rerender(
      <EditorCanvas height={22} onLayout={jest.fn()} snapshot={initial} width={20} />
    )
    const bundledFonts = state.fonts.slice(4)
    expect(bundledFonts).toHaveLength(4)
    expect(bundledFonts.every((font) => font.style.source === 'bundled')).toBe(true)
    expect(systemPicture?.dispose).toHaveBeenCalledTimes(1)
    expect(systemFonts.every((font) => font.dispose.mock.calls.length === 1)).toBe(true)
    expect(state.pictures).toHaveLength(2)
    expect(state.pictures[1]?.dispose).not.toHaveBeenCalled()

    screen.unmount()
    expect(state.pictures[1]?.dispose).toHaveBeenCalledTimes(1)
    expect(bundledFonts.every((font) => font.dispose.mock.calls.length === 1)).toBe(true)
  })

  it('releases temporary typefaces and partial clones when a bundled face is unusable', () => {
    const state = currentState()
    state.sourceFonts.italic.getTypeface.mockReturnValueOnce(null)
    const screen = render(
      <EditorCanvas height={22} onLayout={jest.fn()} snapshot={snapshot()} width={20} />
    )

    expect(state.typefaces.map(({ face }) => face)).toEqual(['normal', 'bold'])
    expect(state.typefaces.every(({ dispose }) => dispose.mock.calls.length === 1)).toBe(true)
    expect(state.fonts).toHaveLength(6)
    expect(state.fonts.slice(0, 2).every((font) => font.style.source === 'bundled')).toBe(true)
    expect(state.fonts.slice(0, 2).every((font) => font.dispose.mock.calls.length === 1)).toBe(true)
    expect(state.fonts.slice(2).every((font) => font.style.source === 'system')).toBe(true)

    screen.unmount()
    expect(state.fonts.slice(2).every((font) => font.dispose.mock.calls.length === 1)).toBe(true)
  })

  it('does not rebuild for cursor, mode, or flush-only snapshots and disposes replacements', () => {
    const state = currentState()
    const initial = snapshot()
    const screen = render(
      <EditorCanvas
        height={22}
        onLayout={jest.fn()}
        snapshot={initial}
        width={20}
      />
    )

    expect(state.recordings).toHaveLength(1)
    expect(screen.getAllByTestId('skia-picture')).toHaveLength(1)
    expect(screen.getAllByTestId('skia-cursor')).toHaveLength(1)
    expect(screen.getByTestId('skia-cursor').props).toMatchObject({
      x: 0,
      y: 0,
      width: 3,
      height: 22,
      opacity: 0.75
    })

    screen.rerender(
      <EditorCanvas
        height={22}
        onLayout={jest.fn()}
        snapshot={{ ...initial, flushCount: 2 }}
        width={20}
      />
    )
    screen.rerender(
      <EditorCanvas
        height={22}
        onLayout={jest.fn()}
        snapshot={{ ...initial, cursor: { gridId: 1, row: 0, column: 1 }, flushCount: 3 }}
        width={20}
      />
    )
    screen.rerender(
      <EditorCanvas
        height={22}
        onLayout={jest.fn()}
        snapshot={{
          ...initial,
          mode: {
            cursorStyleEnabled: true,
            infos: [{ cursor_shape: 'horizontal', cell_percentage: 50 }],
            name: 'replace',
            index: 0
          },
          flushCount: 4
        }}
        width={20}
      />
    )

    expect(state.recordings).toHaveLength(1)
    expect(state.pictures[0]?.dispose).not.toHaveBeenCalled()
    expect(screen.getByTestId('skia-cursor').props).toMatchObject({
      x: 0,
      y: 11,
      width: 10,
      height: 11,
      opacity: 0.75
    })

    const paletteSnapshot = snapshot({
      defaultColors: { ...defaultColors, background: 0x202122 },
      flushCount: 5
    })
    screen.rerender(
      <EditorCanvas height={22} onLayout={jest.fn()} snapshot={paletteSnapshot} width={20} />
    )
    expect(state.recordings).toHaveLength(2)
    expect(state.pictures[0]?.dispose).toHaveBeenCalledTimes(1)

    const changedHighlights = { ...initial.highlights }
    const highlightsSnapshot = snapshot({
      defaultColors: paletteSnapshot.defaultColors,
      highlights: changedHighlights,
      flushCount: 6
    })
    screen.rerender(
      <EditorCanvas height={22} onLayout={jest.fn()} snapshot={highlightsSnapshot} width={20} />
    )
    expect(state.recordings).toHaveLength(3)
    expect(state.pictures[1]?.dispose).toHaveBeenCalledTimes(1)

    const largeGrid: Grid = { id: 1, width: 125, height: 25, cells: grid.cells }
    const gridSnapshot = snapshot({
      grid: largeGrid,
      defaultColors: paletteSnapshot.defaultColors,
      highlights: changedHighlights,
      flushCount: 7
    })
    screen.rerender(
      <EditorCanvas
        height={22}
        onLayout={jest.fn()}
        snapshot={gridSnapshot}
        width={20}
      />
    )
    screen.rerender(
      <EditorCanvas
        height={22}
        onLayout={jest.fn()}
        snapshot={{ ...gridSnapshot, flushCount: 8 }}
        width={30}
      />
    )
    screen.rerender(
      <EditorCanvas
        height={44}
        onLayout={jest.fn()}
        snapshot={{ ...gridSnapshot, flushCount: 9 }}
        width={30}
      />
    )

    expect(state.recordings).toHaveLength(6)
    expect(screen.getAllByTestId('skia-picture')).toHaveLength(1)
    expect(screen.getAllByTestId('skia-cursor')).toHaveLength(1)
    expect(state.pictures.slice(0, -1).every((picture) => picture.dispose.mock.calls.length === 1))
      .toBe(true)
    expect(state.pictures.at(-1)?.dispose).not.toHaveBeenCalled()

    screen.unmount()
    expect(state.pictures.at(-1)?.dispose).toHaveBeenCalledTimes(1)
    expect(state.fonts).toHaveLength(4)
    expect(state.fonts.every((font) => font.dispose.mock.calls.length === 1)).toBe(true)
  })

  it('reclaims StrictMode probes without disposing the committed resources early', () => {
    const state = currentState()
    const screen = render(
      <StrictMode>
        <EditorCanvas
          height={22}
          onLayout={jest.fn()}
          snapshot={snapshot()}
          width={20}
        />
      </StrictMode>
    )

    // StrictMode replays the font creation layout effect. The first native set
    // is never published and must be reclaimed; only the committed set is used
    // to record a picture.
    expect(state.fonts).toHaveLength(8)
    expect(state.fonts.slice(0, 4).every((font) => font.dispose.mock.calls.length === 1))
      .toBe(true)
    expect(state.fonts.slice(4).every((font) => font.dispose.mock.calls.length === 0))
      .toBe(true)
    expect(state.recordings).toHaveLength(1)
    expect(state.pictures).toHaveLength(1)
    expect(state.pictures[0]?.dispose).not.toHaveBeenCalled()
    expect(screen.getByTestId('skia-picture').props.accessibilityLabel).toBe('picture-1')

    screen.unmount()

    expect(state.pictures[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(state.fonts.every((font) => font.dispose.mock.calls.length === 1)).toBe(true)
  })

  it('does not allocate a picture for an abandoned concurrent replacement', () => {
    const state = currentState()
    const initial = snapshot()
    const replacement = snapshot({
      defaultColors: { ...defaultColors, background: 0x202122 },
      flushCount: 2
    })
    const never = new Promise<never>(() => undefined)
    let requestReplacement: (() => void) | null = null

    function SuspendReplacement({ active }: { readonly active: boolean }) {
      if (active) throw never
      return null
    }

    function Harness() {
      const [current, setCurrent] = useState(initial)
      requestReplacement = () => setCurrent(replacement)
      return (
        <Suspense fallback={null}>
          <EditorCanvas
            height={22}
            onLayout={jest.fn()}
            snapshot={current}
            width={20}
          />
          <SuspendReplacement active={current === replacement} />
        </Suspense>
      )
    }

    const screen = render(<Harness />)
    expect(state.recordings).toHaveLength(1)
    expect(state.pictures).toHaveLength(1)

    act(() => {
      startTransition(() => requestReplacement?.())
    })

    // The replacement EditorCanvas rendered before its later sibling
    // suspended, but no native resource was allocated because the tree never
    // committed. The previously committed picture remains live and visible.
    expect(state.recordings).toHaveLength(1)
    expect(state.pictures).toHaveLength(1)
    expect(state.pictures[0]?.dispose).not.toHaveBeenCalled()
    expect(screen.getByTestId('skia-picture').props.accessibilityLabel).toBe('picture-1')

    screen.unmount()
    expect(state.pictures[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(state.fonts.every((font) => font.dispose.mock.calls.length === 1)).toBe(true)
  })

  it('records every published input sample once at the visible layout commit', () => {
    const state = currentState()
    state.diagnosticsEnabled = true
    const firstSamples = [
      {
        sampleId: 42,
        inputStartedAtMs: 11,
        source: 'hardware' as const,
        inputLength: 1,
        flushCount: 3
      },
      {
        sampleId: 41,
        inputStartedAtMs: 10,
        source: 'ime' as const,
        inputLength: 1,
        flushCount: 3
      }
    ]
    const initial = snapshot({ flushCount: 3 })
    const screen = render(
      <EditorCanvas
        height={22}
        onLayout={jest.fn()}
        performanceSamples={firstSamples}
        snapshot={initial}
        width={20}
      />
    )

    const keyToVisibleCalls = () => jest.mocked(recordPerformance).mock.calls.filter(
      ([stage]) => stage === 'key_to_visible'
    )
    expect(keyToVisibleCalls().map(([, options]) => options?.tags?.sampleId)).toEqual([42, 41])
    expect(keyToVisibleCalls()[0]?.[1]).toMatchObject({
      startedAtMs: 11,
      tags: {
        source: 'hardware',
        flushCount: 3,
        pictureChanged: true
      }
    })

    screen.rerender(
      <EditorCanvas
        height={22}
        onLayout={jest.fn()}
        performanceSamples={firstSamples}
        snapshot={{ ...initial, mode: { ...initial.mode, name: 'replace' } }}
        width={20}
      />
    )
    expect(keyToVisibleCalls()).toHaveLength(2)

    screen.rerender(
      <EditorCanvas
        height={22}
        onLayout={jest.fn()}
        performanceSamples={[
          {
            sampleId: 43,
            inputStartedAtMs: 12,
            source: 'action-pad',
            inputLength: 5,
            flushCount: 4
          }
        ]}
        snapshot={{ ...initial, flushCount: 4 }}
        width={20}
      />
    )
    expect(keyToVisibleCalls().map(([, options]) => options?.tags?.sampleId)).toEqual([
      42,
      41,
      43
    ])
    expect(state.recordings).toHaveLength(1)
  })

  it('omits the cursor overlay when it belongs to another grid', () => {
    const screen = render(
      <EditorCanvas
        height={22}
        onLayout={jest.fn()}
        snapshot={snapshot({ cursor: { gridId: 2, row: 0, column: 0 } })}
        width={20}
      />
    )

    expect(screen.getAllByTestId('skia-picture')).toHaveLength(1)
    expect(screen.queryByTestId('skia-cursor')).toBeNull()
  })
})

function currentState(): EditorCanvasTestState {
  return (
    globalThis as typeof globalThis & { __editorCanvasTestState: EditorCanvasTestState }
  ).__editorCanvasTestState
}

function sourceFont(face: string): TestSourceFont {
  return {
    getTypeface: jest.fn(() => {
      const typeface = { face, dispose: jest.fn() }
      currentState().typefaces.push(typeface)
      return typeface
    })
  }
}

function mockCreateTestFont(style: Readonly<Record<string, unknown>>): TestFont {
  const state = currentState()
  const font = {
    id: state.fonts.length + 1,
    style,
    dispose: jest.fn()
  }
  state.fonts.push(font)
  return font
}
