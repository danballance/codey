import type {
  DefaultColors,
  EditorSnapshot,
  HighlightAttributes
} from '@codey/editor-core'

export const FALLBACK_FOREGROUND = 0xd7dde4
export const FALLBACK_BACKGROUND = 0x111419

export interface CellColors {
  readonly foreground: string
  readonly background: string
  readonly special: string
}

export function colorString(value: unknown, fallback: number): string {
  const color = validRgb(value) ?? validRgb(fallback) ?? 0
  return `#${color.toString(16).padStart(6, '0')}`
}

export function colorsForSnapshot(
  snapshot: EditorSnapshot,
  attributes: HighlightAttributes | undefined
): CellColors {
  return colorsForDefaults(snapshot.defaultColors, attributes)
}

export function colorsForDefaults(
  defaultColors: DefaultColors | null,
  attributes: HighlightAttributes | undefined
): CellColors {
  const defaultForeground = validRgb(defaultColors?.foreground) ?? FALLBACK_FOREGROUND
  const defaultBackground = validRgb(defaultColors?.background) ?? FALLBACK_BACKGROUND
  const defaultSpecial = validRgb(defaultColors?.special) ?? defaultForeground
  let foreground = colorString(attributes?.foreground, defaultForeground)
  let background = colorString(attributes?.background, defaultBackground)
  if (attributes?.reverse === true) [foreground, background] = [background, foreground]

  return {
    foreground,
    background,
    special: colorString(attributes?.special, defaultSpecial)
  }
}

function validRgb(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value) & 0xffffff
    : null
}
