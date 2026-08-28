import { Dimensions, FlatList, Modal, StyleSheet } from 'react-native'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native'

jest.mock('../../fonts', () => ({
  CODEY_NERD_FONT_FAMILIES: {
    regular: 'CodeyNerdFont-Regular'
  }
}))

jest.mock('../../fonts/nerd-font-icons', () => {
  const icons = [
    {
      glyph: '\uf07c',
      name: 'folder',
      source: 'Font Awesome',
      names: ['folder', 'directory'],
      codepoint: 0xf07c,
      codepointLabel: 'U+F07C',
      searchText: 'folder directory font awesome f07c u+f07c'
    },
    {
      glyph: '\udb80\uddc9',
      name: 'magnify',
      source: 'Material Design Icons',
      names: ['magnify', 'search'],
      codepoint: 0xf01c9,
      codepointLabel: 'U+F01C9',
      searchText: 'magnify search material design icons f01c9 u+f01c9'
    },
    {
      glyph: '\ue0b0',
      name: 'right hard divider',
      source: 'Powerline',
      names: ['right hard divider'],
      codepoint: 0xe0b0,
      codepointLabel: 'U+E0B0',
      searchText: 'right hard divider powerline e0b0 u+e0b0'
    }
  ]
  return {
    getNerdFontIcons: jest.fn(() => icons),
    filterNerdFontIcons: jest.fn((query: string) => {
      const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
      return icons.filter((icon) => terms.every((term) => icon.searchText.includes(term)))
    })
  }
})

import { filterNerdFontIcons, getNerdFontIcons } from '../../fonts/nerd-font-icons'
import { NerdFontIconPicker } from '../NerdFontIconPicker'

const mockGetNerdFontIcons = getNerdFontIcons as jest.MockedFunction<typeof getNerdFontIcons>
const mockNerdFontIcons = mockGetNerdFontIcons()
const mockFilterNerdFontIcons = filterNerdFontIcons as jest.MockedFunction<typeof filterNerdFontIcons>

beforeEach(() => {
  mockGetNerdFontIcons.mockClear()
  mockFilterNerdFontIcons.mockClear()
})

afterEach(() => {
  cleanup()
})

function renderPicker(overrides: Partial<React.ComponentProps<typeof NerdFontIconPicker>> = {}) {
  const props: React.ComponentProps<typeof NerdFontIconPicker> = {
    visible: true,
    onDismiss: jest.fn(),
    onSelect: jest.fn(),
    ...overrides
  }
  return { ...render(<NerdFontIconPicker {...props} />), props }
}

describe('NerdFontIconPicker', () => {
  it('defers expanding the catalog until the picker becomes visible', () => {
    const initial = renderPicker({ visible: false })
    expect(mockGetNerdFontIcons).not.toHaveBeenCalled()

    initial.rerender(<NerdFontIconPicker {...initial.props} visible />)
    expect(mockGetNerdFontIcons).toHaveBeenCalledTimes(1)
  })

  it('filters the searchable grid and publishes the result count as a live update', async () => {
    const screen = renderPicker()

    expect(screen.getByText('folder')).toBeTruthy()
    expect(screen.getByText('magnify')).toBeTruthy()
    expect(screen.getByText('right hard divider')).toBeTruthy()
    expect(screen.getByTestId('nerd-font-icon-result-count')).toHaveTextContent('3 icons')
    expect(screen.getByTestId('nerd-font-icon-result-count').props.accessibilityLiveRegion).toBe('polite')

    fireEvent.changeText(screen.getByLabelText('Search Nerd Font icons'), 'directory')

    await waitFor(() => expect(screen.getByTestId('nerd-font-icon-result-count')).toHaveTextContent('1 icon'))
    expect(mockFilterNerdFontIcons).toHaveBeenLastCalledWith('directory', mockNerdFontIcons)
    expect(screen.getByText('folder')).toBeTruthy()
    expect(screen.queryByText('magnify')).toBeNull()
    expect(screen.queryByText('right hard divider')).toBeNull()
  })

  it('shows a useful empty state when no icon matches', async () => {
    const screen = renderPicker()

    fireEvent.changeText(screen.getByLabelText('Search Nerd Font icons'), 'not-an-icon')

    await waitFor(() => expect(screen.getByText('No icons found')).toBeTruthy())
    expect(screen.getByTestId('nerd-font-icon-result-count')).toHaveTextContent('0 icons')
    expect(screen.getByText(/hexadecimal code point/)).toBeTruthy()
  })

  it('reports exactly one selected icon per press without dismissing itself', () => {
    const onDismiss = jest.fn()
    const onSelect = jest.fn()
    const screen = renderPicker({ onDismiss, onSelect })

    fireEvent.press(screen.getByRole('button', {
      name: 'Insert Font Awesome folder, U+F07C'
    }))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(mockNerdFontIcons[0])
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('supports the close action and the Android back request', () => {
    const onDismiss = jest.fn()
    const screen = renderPicker({ onDismiss })
    const modal = screen.UNSAFE_getByType(Modal)

    expect(modal.props.animationType).toBe('slide')
    expect(modal.props.presentationStyle).toBe('fullScreen')
    fireEvent.press(screen.getByRole('button', { name: 'Close icon picker' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)

    fireEvent(modal, 'requestClose')
    expect(onDismiss).toHaveBeenCalledTimes(2)
  })

  it('uses the bundled font for accessible glyph tiles with generous touch targets', () => {
    const screen = renderPicker()
    const search = screen.getByLabelText('Search Nerd Font icons')
    const tile = screen.getByRole('button', { name: 'Insert Font Awesome folder, U+F07C' })
    const close = screen.getByRole('button', { name: 'Close icon picker' })

    expect(search.props.autoFocus).toBe(true)
    expect(StyleSheet.flatten(screen.getByText('\uf07c').props.style)).toMatchObject({
      fontFamily: 'CodeyNerdFont-Regular',
      fontWeight: 'normal'
    })
    expect(StyleSheet.flatten(tile.props.style)).toMatchObject({
      minWidth: 48,
      minHeight: 112
    })
    expect(StyleSheet.flatten(close.props.style)).toMatchObject({
      minWidth: 48,
      minHeight: 48
    })
  })

  it('keeps uniform tile widths while increasing the column count on wider screens', () => {
    const previousWindow = Dimensions.get('window')
    const previousScreen = Dimensions.get('screen')
    let screen: ReturnType<typeof renderPicker> | undefined

    try {
      act(() => {
        Dimensions.set({
          window: { width: 360, height: 800, scale: 1, fontScale: 1 },
          screen: { width: 360, height: 800, scale: 1, fontScale: 1 }
        })
      })
      screen = renderPicker()
      expect(screen.UNSAFE_getByType(FlatList).props.numColumns).toBe(3)
      expect(StyleSheet.flatten(screen.getByRole('button', {
        name: 'Insert Font Awesome folder, U+F07C'
      }).props.style).width).toBe(104)

      act(() => {
        Dimensions.set({
          window: { width: 1280, height: 800, scale: 1, fontScale: 1 },
          screen: { width: 1280, height: 800, scale: 1, fontScale: 1 }
        })
      })
      expect(screen.UNSAFE_getByType(FlatList).props.numColumns).toBe(10)
      expect(StyleSheet.flatten(screen.getByRole('button', {
        name: 'Insert Font Awesome folder, U+F07C'
      }).props.style).width).toBe(117)
    } finally {
      screen?.unmount()
      act(() => { Dimensions.set({ window: previousWindow, screen: previousScreen }) })
    }
  })
})
