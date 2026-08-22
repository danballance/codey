import type { EditorSnapshot } from '@codey/editor-core'

import { colorString, colorsForSnapshot, renderCells } from '../editor/render-model'

const snapshot: EditorSnapshot = {
  grid: {
    id: 1,
    width: 2,
    height: 1,
    cells: [
      { text: 'A', highlightId: 4 },
      { text: '界', highlightId: 0 }
    ]
  },
  cursor: { gridId: 1, row: 0, column: 1 },
  defaultColors: {
    foreground: 0xffffff,
    background: 0x101112,
    special: 0xff00ff,
    ctermForeground: 15,
    ctermBackground: 0
  },
  highlights: {
    4: {
      id: 4,
      rgb: {
        foreground: 0x00ff00,
        background: 0x0000ff,
        special: 0xff0000,
        reverse: true,
        bold: true,
        italic: true,
        underline: true,
        undercurl: true,
        strikethrough: true
      },
      cterm: {},
      info: []
    }
  },
  mode: { cursorStyleEnabled: true, infos: [], name: 'insert', index: 0 },
  flushCount: 1
}

describe('Skia render model', () => {
  it('resolves RGB colors, reverse video, and decoration attributes', () => {
    expect(colorsForSnapshot(snapshot, snapshot.highlights[4]?.rgb)).toEqual({
      foreground: '#0000ff',
      background: '#00ff00',
      special: '#ff0000'
    })
    expect(renderCells(snapshot, 2, 1)[0]).toMatchObject({
      text: 'A',
      row: 0,
      column: 0,
      attributes: {
        bold: true,
        italic: true,
        underline: true,
        undercurl: true,
        strikethrough: true
      }
    })
  })

  it('clips the render model to visible cells and retains Unicode glyphs', () => {
    expect(renderCells(snapshot, 1, 1)).toHaveLength(1)
    expect(renderCells(snapshot, 2, 1)[1]?.text).toBe('界')
  })

  it('replaces Neovim unknown-color sentinels with valid renderer defaults', () => {
    const unknownDefaults: EditorSnapshot = {
      ...snapshot,
      defaultColors: {
        foreground: -1,
        background: -1,
        special: -1,
        ctermForeground: 0,
        ctermBackground: 0
      },
      highlights: {}
    }

    expect(colorsForSnapshot(unknownDefaults, undefined)).toEqual({
      foreground: '#d7dde4',
      background: '#111419',
      special: '#d7dde4'
    })
    expect(colorString(undefined, -1)).toBe('#000000')
  })
})
