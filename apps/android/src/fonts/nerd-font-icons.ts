type NerdFontGlyphRow = readonly [
  glyph: string,
  primaryName: string,
  ...aliases: string[]
]

export interface NerdFontIcon {
  readonly glyph: string
  readonly name: string
  readonly source: string
  readonly names: readonly string[]
  readonly codepoint: number
  readonly codepointLabel: string
  readonly searchText: string
}

const SOURCE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  cod: 'Codicons',
  custom: 'Custom Icons',
  dev: 'Devicons',
  extra: 'Progress Icons',
  fa: 'Font Awesome',
  fae: 'Font Awesome Extension',
  iec: 'IEC Power Symbols',
  indent: 'Indentation Guides',
  indentation: 'Indentation Guides',
  linux: 'Font Logos',
  md: 'Material Design Icons',
  oct: 'Octicons',
  pl: 'Powerline Symbols',
  ple: 'Powerline Extra Symbols',
  pom: 'Pomicons',
  seti: 'Seti-UI',
  weather: 'Weather Icons'
})

function iconSource(rawName: string): string {
  const separator = rawName.indexOf('-')
  const prefix = separator === -1 ? rawName : rawName.slice(0, separator)
  return SOURCE_NAMES[prefix] ?? 'Nerd Fonts'
}

function iconDisplayName(rawName: string): string {
  const separator = rawName.indexOf('-')
  const unprefixed = separator === -1 ? rawName : rawName.slice(separator + 1)
  return unprefixed
    .split(/[_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ')
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function createIcon(row: NerdFontGlyphRow): NerdFontIcon {
  const [glyph, ...rawNames] = row
  const primaryName = rawNames[0]
  if (primaryName === undefined) {
    throw new Error('Nerd Font catalog row is missing its primary name')
  }

  const codepoint = glyph.codePointAt(0)
  if (codepoint === undefined) {
    throw new Error(`Nerd Font catalog glyph ${primaryName} is empty`)
  }

  const names = Object.freeze(rawNames)
  const name = iconDisplayName(primaryName)
  const source = iconSource(primaryName)
  const codepointHex = codepoint.toString(16).toUpperCase().padStart(4, '0')
  const codepointLabel = `U+${codepointHex}`
  const aliasSources = names.map(iconSource)
  const searchText = normalizeSearchText(
    [name, ...names, source, ...aliasSources, codepointHex, codepointLabel].join(' ')
  )

  return Object.freeze({
    glyph,
    name,
    source,
    names,
    codepoint,
    codepointLabel,
    searchText
  })
}

let cachedIcons: readonly NerdFontIcon[] | undefined

/** Expand the compact catalog only when the icon picker is first opened. */
export function getNerdFontIcons(): readonly NerdFontIcon[] {
  if (cachedIcons === undefined) {
    const glyphRows = require('./nerd-font-glyphs.json') as readonly NerdFontGlyphRow[]
    cachedIcons = Object.freeze(glyphRows.map(createIcon))
  }
  return cachedIcons
}

export function filterNerdFontIcons(
  query: string,
  icons: readonly NerdFontIcon[] = getNerdFontIcons()
): readonly NerdFontIcon[] {
  const normalizedQuery = normalizeSearchText(query)
  if (normalizedQuery.length === 0) {
    return icons
  }

  const tokens = normalizedQuery
    .split(' ')
    .filter((token, index) => index !== 0 || token !== 'nf')
  if (tokens.length === 0) {
    return icons
  }
  return icons.filter((icon) =>
    tokens.every((token) => icon.searchText.includes(token))
  )
}
