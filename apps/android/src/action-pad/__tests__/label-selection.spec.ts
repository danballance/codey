import { insertLabelText } from '../label-selection'

describe('label text insertion', () => {
  it.each([
    { text: '', selection: undefined, expected: '\uf07c', cursor: 1 },
    { text: 'Save', selection: undefined, expected: 'Save\uf07c', cursor: 5 },
    { text: 'Save', selection: { start: 0, end: 0 }, expected: '\uf07cSave', cursor: 1 },
    { text: 'Save', selection: { start: 2, end: 2 }, expected: 'Sa\uf07cve', cursor: 3 },
    { text: 'Save', selection: { start: 4, end: 4 }, expected: 'Save\uf07c', cursor: 5 },
    { text: 'Save all', selection: { start: 0, end: 4 }, expected: '\uf07c all', cursor: 1 },
    { text: 'Save all', selection: { start: 4, end: 0 }, expected: '\uf07c all', cursor: 1 },
    { text: 'Save', selection: { start: -10, end: 100 }, expected: '\uf07c', cursor: 1 },
    { text: 'Save', selection: { start: NaN, end: Infinity }, expected: 'Save\uf07c', cursor: 5 },
    { text: 'A😀B', selection: { start: 2, end: 2 }, expected: 'A😀\uf07cB', cursor: 4 },
    { text: 'A😀B', selection: { start: 1, end: 2 }, expected: 'A\uf07cB', cursor: 2 },
    { text: 'A😀B', selection: { start: 2, end: 3 }, expected: 'A\uf07cB', cursor: 2 }
  ])('inserts safely into $text at $selection', ({ text, selection, expected, cursor }) => {
    expect(insertLabelText(text, '\uf07c', selection)).toEqual({
      text: expected, selection: { start: cursor, end: cursor }
    })
  })

  it('uses UTF-16 cursor offsets for consecutive astral icons alongside emoji', () => {
    const first = insertLabelText('A😀B', '\u{f01c9}', { start: 3, end: 3 })
    expect(first).toEqual({ text: 'A😀\u{f01c9}B', selection: { start: 5, end: 5 } })
    expect(insertLabelText(first.text, '\u{f01c9}', first.selection)).toEqual({
      text: 'A😀\u{f01c9}\u{f01c9}B', selection: { start: 7, end: 7 }
    })
  })
})
