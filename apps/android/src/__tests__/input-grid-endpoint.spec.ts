import { validateEndpoint } from '../endpoint'
import { gridCellForPoint, gridSizeForBounds } from '../grid'
import {
  committedTextToNvimInput,
  escapeNvimText,
  keyRowInput,
  specialKeyToNvimInput
} from '../input'

describe('endpoint validation', () => {
  it('normalizes a trusted LAN endpoint and rejects invalid values', () => {
    expect(validateEndpoint(' 192.168.0.10 ', '6666')).toEqual({
      host: '192.168.0.10',
      port: 6666
    })
    expect(() => validateEndpoint('', 6666)).toThrow('hostname')
    expect(() => validateEndpoint('host name', 6666)).toThrow('hostname')
    expect(() => validateEndpoint('localhost', '0')).toThrow('Port')
    expect(() => validateEndpoint('localhost', '65536')).toThrow('Port')
  })
})

describe('grid sizing', () => {
  it('calculates dimensions, clamps tiny bounds, and ignores invalid metrics', () => {
    expect(gridSizeForBounds(1_000, 440)).toEqual({ columns: 100, rows: 20 })
    expect(gridSizeForBounds(1_000, 220)).toEqual({ columns: 100, rows: 10 })
    expect(gridSizeForBounds(1, 1)).toEqual({ columns: 2, rows: 2 })
    expect(gridSizeForBounds(Number.NaN, 100)).toEqual({ columns: 2, rows: 2 })
    expect(gridSizeForBounds(100, 100, { width: 0, height: 20 })).toEqual({
      columns: 2,
      rows: 2
    })
  })

  it('maps touch points to cells and rejects invalid or trailing coordinates', () => {
    const grid = { width: 3, height: 2 }
    expect(gridCellForPoint(0, 0, grid)).toEqual({ row: 0, column: 0 })
    expect(gridCellForPoint(9.999, 21.999, grid)).toEqual({ row: 0, column: 0 })
    expect(gridCellForPoint(10, 22, grid)).toEqual({ row: 1, column: 1 })
    expect(gridCellForPoint(29.999, 43.999, grid)).toEqual({ row: 1, column: 2 })
    expect(gridCellForPoint(30, 0, grid)).toBeNull()
    expect(gridCellForPoint(0, 44, grid)).toBeNull()
    expect(gridCellForPoint(-1, 0, grid)).toBeNull()
    expect(gridCellForPoint(Number.NaN, 0, grid)).toBeNull()
    expect(gridCellForPoint(0, 0, { width: 0, height: 2 })).toBeNull()
    expect(gridCellForPoint(0, 0, grid, { width: 0, height: 22 })).toBeNull()
  })
})

describe('Neovim key translation', () => {
  it('escapes literal less-than text and preserves committed Unicode', () => {
    expect(escapeNvimText('a<界')).toBe('a<lt>界')
    expect(committedTextToNvimInput('Codey tablet ✓')).toBe('Codey tablet ✓')
  })

  it('maps the persistent key row and one-shot control modifier', () => {
    expect(keyRowInput('Escape')).toBe('<Esc>')
    expect(keyRowInput('ArrowLeft', true)).toBe('<C-Left>')
    expect(committedTextToNvimInput('c', true)).toBe('<C-c>')
    expect(committedTextToNvimInput('ab', true)).toBe('<C-a>b')
  })

  it('maps special and printable hardware keys with modifiers', () => {
    expect(specialKeyToNvimInput({ key: 'Enter', modifiers: { shift: true } })).toBe('<S-CR>')
    expect(specialKeyToNvimInput({ key: 'c', modifiers: { ctrl: true } })).toBe('<C-c>')
    expect(specialKeyToNvimInput({ key: 'X', modifiers: { shift: true } })).toBe('X')
    expect(specialKeyToNvimInput({ key: 'Unknown' })).toBeNull()
  })
})
