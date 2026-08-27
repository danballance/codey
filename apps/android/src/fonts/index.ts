import { useFonts as useExpoFonts } from 'expo-font'

const regular = require('./assets/JetBrainsMonoNerdFontMono-Regular.ttf') as number
const semiBold = require('./assets/JetBrainsMonoNerdFontMono-SemiBold.ttf') as number
const bold = require('./assets/JetBrainsMonoNerdFontMono-Bold.ttf') as number
const italic = require('./assets/JetBrainsMonoNerdFontMono-Italic.ttf') as number
const boldItalic = require('./assets/JetBrainsMonoNerdFontMono-BoldItalic.ttf') as number

/** Static Metro assets shared by the Skia editor and React Native text. */
export const CODEY_NERD_FONT_ASSETS = Object.freeze({
  regular,
  semiBold,
  bold,
  italic,
  boldItalic
})

/**
 * Expo registers each bundled face under its own name. Select the concrete
 * family instead of asking Android to synthesize a weight or slant.
 */
export const CODEY_NERD_FONT_FAMILIES = Object.freeze({
  regular: 'CodeyJetBrainsMonoNerdFont-Regular',
  semiBold: 'CodeyJetBrainsMonoNerdFont-SemiBold',
  bold: 'CodeyJetBrainsMonoNerdFont-Bold',
  italic: 'CodeyJetBrainsMonoNerdFont-Italic',
  boldItalic: 'CodeyJetBrainsMonoNerdFont-BoldItalic'
})

const EXPO_FONT_MAP = Object.freeze({
  [CODEY_NERD_FONT_FAMILIES.regular]: CODEY_NERD_FONT_ASSETS.regular,
  [CODEY_NERD_FONT_FAMILIES.semiBold]: CODEY_NERD_FONT_ASSETS.semiBold,
  [CODEY_NERD_FONT_FAMILIES.bold]: CODEY_NERD_FONT_ASSETS.bold
})

/** Load only the three upright faces currently needed by React Native Text. */
export function useCodeyNerdFontFaces(): [boolean, Error | null] {
  return useExpoFonts(EXPO_FONT_MAP)
}
