import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFont, type SkFont } from '@shopify/react-native-skia'

import { CODEY_NERD_FONT_ASSETS } from '.'

export const CODEY_SKIA_FONT_LOAD_TIMEOUT_MS = 5_000

export interface CodeySkiaFontFaces {
  readonly normal: SkFont
  readonly bold: SkFont
  readonly italic: SkFont
  readonly boldItalic: SkFont
}

export type CodeySkiaFontLoadState =
  | {
      readonly status: 'pending'
      readonly fonts: null
      readonly error: null
    }
  | {
      readonly status: 'ready'
      readonly fonts: CodeySkiaFontFaces
      readonly error: null
    }
  | {
      readonly status: 'error'
      readonly fonts: null
      readonly error: Error
    }

/**
 * Load the four faces used by Skia. A null face means loading is still in
 * progress; a loader error or the bounded Android watchdog authorizes the
 * editor fallback.
 */
export function useCodeySkiaFontFaces(fontSize: number): CodeySkiaFontLoadState {
  const [error, setError] = useState<Error | null>(null)
  const recordError = useCallback((nextError: Error) => {
    setError((currentError) => currentError ?? nextError)
  }, [])

  const normalFont = useFont(CODEY_NERD_FONT_ASSETS.regular, fontSize, recordError)
  const boldFont = useFont(CODEY_NERD_FONT_ASSETS.bold, fontSize, recordError)
  const italicFont = useFont(CODEY_NERD_FONT_ASSETS.italic, fontSize, recordError)
  const boldItalicFont = useFont(CODEY_NERD_FONT_ASSETS.boldItalic, fontSize, recordError)
  const fontsReady =
    normalFont !== null &&
    boldFont !== null &&
    italicFont !== null &&
    boldItalicFont !== null

  useEffect(() => {
    if (error !== null || fontsReady) return

    // Skia 2.6 can leave Android asset reads unsettled when a URI cannot be
    // opened. Convert that otherwise-permanent pending state into the editor's
    // existing system-font fallback without penalizing normal local loads.
    const timeout = setTimeout(() => {
      recordError(new Error('Bundled Nerd Font faces did not finish loading'))
    }, CODEY_SKIA_FONT_LOAD_TIMEOUT_MS)
    return () => clearTimeout(timeout)
  }, [error, fontsReady, recordError])

  return useMemo<CodeySkiaFontLoadState>(() => {
    if (
      normalFont === null ||
      boldFont === null ||
      italicFont === null ||
      boldItalicFont === null
    ) {
      if (error !== null) return { status: 'error', fonts: null, error }
      return { status: 'pending', fonts: null, error: null }
    }
    return {
      status: 'ready',
      fonts: {
        normal: normalFont,
        bold: boldFont,
        italic: italicFont,
        boldItalic: boldItalicFont
      },
      error: null
    }
  }, [boldFont, boldItalicFont, error, italicFont, normalFont])
}
