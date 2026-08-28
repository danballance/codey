import {
  filterNerdFontIcons,
  getNerdFontIcons,
  type NerdFontIcon
} from '../fonts/nerd-font-icons'

const NERD_FONT_ICONS = getNerdFontIcons()

function iconWithRawName(rawName: string): NerdFontIcon {
  const icon = NERD_FONT_ICONS.find(({ names }) => names.includes(rawName))
  if (icon === undefined) {
    throw new Error(`Missing test icon ${rawName}`)
  }
  return icon
}

it('ships every pinned Nerd Fonts 3.4.0 glyph and alias exactly once', () => {
  expect(NERD_FONT_ICONS).toHaveLength(10_386)
  expect(NERD_FONT_ICONS.reduce((count, icon) => count + icon.names.length, 0)).toBe(
    10_764
  )

  const codepoints = new Set<number>()
  for (const icon of NERD_FONT_ICONS) {
    expect([...icon.glyph]).toHaveLength(1)
    expect(icon.glyph.codePointAt(0)).toBe(icon.codepoint)
    expect(codepoints.has(icon.codepoint)).toBe(false)
    codepoints.add(icon.codepoint)
  }
})

it('keeps generated rows and aliases in deterministic name order', () => {
  const primaryNames = NERD_FONT_ICONS.map((icon) => icon.names[0])
  expect(primaryNames).toEqual([...primaryNames].sort())

  const bazel = iconWithRawName('custom-bazel')
  expect(bazel.names).toEqual(['custom-bazel', 'seti-bazel'])
  expect(bazel).toMatchObject({
    name: 'Bazel',
    source: 'Custom Icons',
    codepointLabel: 'U+E63A'
  })
})

it('searches normalized names, aliases, icon families, and multiple tokens', () => {
  expect(filterNerdFontIcons('activate breakpoints')).toContain(
    iconWithRawName('cod-activate_breakpoints')
  )
  expect(filterNerdFontIcons('github badge')).toContain(iconWithRawName('dev-github'))
  expect(filterNerdFontIcons('seti bazel')).toContain(iconWithRawName('custom-bazel'))
  expect(filterNerdFontIcons('material-design account')).toContain(
    iconWithRawName('md-account')
  )
  expect(filterNerdFontIcons('nf-md-account')).toContain(iconWithRawName('md-account'))
})

it('searches hexadecimal and U+ code-point forms, including astral glyphs', () => {
  const account = iconWithRawName('md-account')
  expect(account.codepoint).toBe(0xf0004)
  expect(account.codepointLabel).toBe('U+F0004')
  expect(filterNerdFontIcons('f0004')).toContain(account)
  expect(filterNerdFontIcons('U+F0004')).toContain(account)
})

it('returns the supplied list unchanged for a blank query', () => {
  const icons = [iconWithRawName('cod-account')]
  expect(filterNerdFontIcons('  \n ', icons)).toBe(icons)
})
