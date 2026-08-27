import { act, renderHook } from '@testing-library/react-native'

const mockUseExpoFonts = jest.fn(
  (_fontMap: Readonly<Record<string, unknown>>): [boolean, Error | null] => [true, null]
)
const mockUseSkiaFont = jest.fn()

jest.mock('expo-font', () => ({
  useFonts: (fontMap: Readonly<Record<string, unknown>>) => mockUseExpoFonts(fontMap)
}))

jest.mock('@shopify/react-native-skia', () => ({
  useFont: (...arguments_: unknown[]) => mockUseSkiaFont(...arguments_)
}))

import {
  CODEY_NERD_FONT_ASSETS,
  CODEY_NERD_FONT_FAMILIES,
  useCodeyNerdFontFaces
} from '../fonts'
import {
  CODEY_SKIA_FONT_LOAD_TIMEOUT_MS,
  useCodeySkiaFontFaces
} from '../fonts/skia'

beforeEach(() => {
  mockUseExpoFonts.mockClear()
  mockUseSkiaFont.mockReset()
  mockUseSkiaFont.mockReturnValue(null)
})

it('registers only the upright React Native text faces', () => {
  const { result } = renderHook(() => useCodeyNerdFontFaces())

  expect(result.current).toEqual([true, null])
  expect(mockUseExpoFonts).toHaveBeenCalledTimes(1)
  expect(mockUseExpoFonts.mock.calls[0]?.[0]).toEqual({
    [CODEY_NERD_FONT_FAMILIES.regular]: CODEY_NERD_FONT_ASSETS.regular,
    [CODEY_NERD_FONT_FAMILIES.semiBold]: CODEY_NERD_FONT_ASSETS.semiBold,
    [CODEY_NERD_FONT_FAMILIES.bold]: CODEY_NERD_FONT_ASSETS.bold
  })
})

it('loads four concrete Skia faces and stays pending until all are ready', () => {
  const { result } = renderHook(() => useCodeySkiaFontFaces(16))

  expect(result.current).toEqual({ status: 'pending', fonts: null, error: null })
  expect(mockUseSkiaFont.mock.calls.map(([asset, size]) => [asset, size])).toEqual([
    [CODEY_NERD_FONT_ASSETS.regular, 16],
    [CODEY_NERD_FONT_ASSETS.bold, 16],
    [CODEY_NERD_FONT_ASSETS.italic, 16],
    [CODEY_NERD_FONT_ASSETS.boldItalic, 16]
  ])
})

it('publishes loaded Skia faces and reports a genuine loader error', () => {
  const faces = {
    normal: { face: 'normal' },
    bold: { face: 'bold' },
    italic: { face: 'italic' },
    boldItalic: { face: 'boldItalic' }
  }
  mockUseSkiaFont
    .mockReturnValueOnce(faces.normal)
    .mockReturnValueOnce(faces.bold)
    .mockReturnValueOnce(faces.italic)
    .mockReturnValueOnce(faces.boldItalic)
  const ready = renderHook(() => useCodeySkiaFontFaces(16))
  expect(ready.result.current).toEqual({ status: 'ready', fonts: faces, error: null })
  ready.unmount()

  mockUseSkiaFont.mockReset()
  mockUseSkiaFont.mockReturnValue(null)
  const failed = renderHook(() => useCodeySkiaFontFaces(16))
  const error = new Error('invalid font data')
  const reportError = mockUseSkiaFont.mock.calls[0]?.[2]
  expect(typeof reportError).toBe('function')
  act(() => {
    ;(reportError as (cause: Error) => void)(error)
  })
  expect(failed.result.current).toEqual({ status: 'error', fonts: null, error })
})

it('falls back after a Skia Android asset read remains unsettled', () => {
  jest.useFakeTimers()
  const failed = renderHook(() => useCodeySkiaFontFaces(16))

  try {
    expect(failed.result.current.status).toBe('pending')
    act(() => {
      jest.advanceTimersByTime(CODEY_SKIA_FONT_LOAD_TIMEOUT_MS - 1)
    })
    expect(failed.result.current.status).toBe('pending')
    act(() => {
      jest.advanceTimersByTime(1)
    })
    expect(failed.result.current).toMatchObject({
      status: 'error',
      fonts: null,
      error: expect.objectContaining({
        message: 'Bundled Nerd Font faces did not finish loading'
      })
    })

    const faces = {
      normal: { face: 'late-normal' },
      bold: { face: 'late-bold' },
      italic: { face: 'late-italic' },
      boldItalic: { face: 'late-boldItalic' }
    }
    mockUseSkiaFont.mockReset()
    mockUseSkiaFont
      .mockReturnValueOnce(faces.normal)
      .mockReturnValueOnce(faces.bold)
      .mockReturnValueOnce(faces.italic)
      .mockReturnValueOnce(faces.boldItalic)
    failed.rerender({})
    expect(failed.result.current).toEqual({ status: 'ready', fonts: faces, error: null })
  } finally {
    failed.unmount()
    jest.useRealTimers()
  }
})
