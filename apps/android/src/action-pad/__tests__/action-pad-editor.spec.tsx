import { useState } from 'react'
import { Alert, Dimensions, ScrollView, StyleSheet, TextInput } from 'react-native'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react-native'

import { ActionPadEditor, type ActionPadEditorProps } from '../ActionPadEditor'
import { type ActionPadConfig } from '../document'

const mockUseCodeyNerdFontFaces = jest.fn((): [boolean, Error | null] => [true, null])
const mockBmpIcon = {
  glyph: '\uf07c', name: 'folder open', source: 'Font Awesome', names: ['fa-folder_open'],
  codepoint: 0xf07c, codepointLabel: 'U+F07C', searchText: 'folder open'
}
const mockAstralIcon = {
  glyph: '\u{f01c9}', name: 'ab testing', source: 'Material Design', names: ['md-ab_testing'],
  codepoint: 0xf01c9, codepointLabel: 'U+F01C9', searchText: 'ab testing'
}

jest.mock('../../fonts', () => ({
  CODEY_NERD_FONT_FAMILIES: {
    regular: 'CodeyNerdFont-Regular', semiBold: 'CodeyNerdFont-SemiBold', bold: 'CodeyNerdFont-Bold'
  },
  useCodeyNerdFontFaces: () => mockUseCodeyNerdFontFaces()
}))

jest.mock('../NerdFontIconPicker', () => {
  const { Pressable, Text, View } = jest.requireActual<typeof import('react-native')>('react-native')
  return {
    NerdFontIconPicker: ({ visible, onDismiss, onSelect }: {
      readonly visible: boolean
      readonly onDismiss: () => void
      readonly onSelect: (icon: typeof mockBmpIcon) => void
    }) => visible ? (
      <View testID="mock-nerd-font-icon-picker">
        <Pressable accessibilityLabel="Insert mock BMP icon" accessibilityRole="button" onPress={() => onSelect(mockBmpIcon)}><Text>BMP</Text></Pressable>
        <Pressable accessibilityLabel="Insert mock astral icon" accessibilityRole="button" onPress={() => onSelect(mockAstralIcon)}><Text>Astral</Text></Pressable>
        <Pressable accessibilityLabel="Close mock icon picker" accessibilityRole="button" onPress={onDismiss}><Text>Close</Text></Pressable>
      </View>
    ) : null
  }
})

afterEach(() => {
  cleanup()
  jest.restoreAllMocks()
  mockUseCodeyNerdFontFaces.mockReturnValue([true, null])
})

function config(): ActionPadConfig {
  return {
    version: 1,
    rootMenuId: 'home',
    menus: [
      {
        id: 'home', label: 'Home', groups: [{
          id: 'actions', buttons: [
            {
              id: 'input', label: 'Run input', tap: { type: 'input', nvimInput: 'x', after: 'stay' },
              longPress: { type: 'input', nvimInput: '<C-x>', after: 'stay' }
            },
            { id: 'open', label: 'Open child', tap: { type: 'menu', menuId: 'child', after: 'stay' } },
            { id: 'keyboard', label: 'Keyboard', tap: { type: 'keyboard', after: 'stay' } }
          ]
        }]
      },
      {
        id: 'child', label: 'Child', groups: [{
          id: 'target', buttons: [{ id: 'back', label: 'Go back', tap: { type: 'back', after: 'stay' } }]
        }]
      }
    ]
  }
}

function props(overrides: Partial<ActionPadEditorProps> = {}): ActionPadEditorProps {
  return {
    config: config(), onChange: jest.fn(), connected: true, busy: false, dirty: false,
    sourcePath: '~/.config/nvim/codey/action-pad.yaml', message: '',
    onLoad: jest.fn().mockResolvedValue(undefined), onSave: jest.fn().mockResolvedValue(undefined),
    onExport: jest.fn().mockResolvedValue(undefined), onCancel: jest.fn(), ...overrides
  }
}

function renderEditor(overrides: Partial<ActionPadEditorProps> = {}) {
  const initialProps = props(overrides)
  let latest = initialProps.config
  function Harness() {
    const [draft, setDraft] = useState(initialProps.config)
    return <ActionPadEditor {...initialProps} config={draft} onChange={(next) => {
      latest = JSON.parse(JSON.stringify(next)) as ActionPadConfig
      setDraft(latest)
      initialProps.onChange(next)
    }} />
  }
  const screen = render(<Harness />)
  return { ...screen, props: initialProps, draft: () => latest }
}

function emitLayout(screen: ReturnType<typeof render>, testID: string, y: number) {
  fireEvent(screen.getByTestId(testID), 'layout', { nativeEvent: { layout: { x: 0, y, width: 600, height: 200 } } })
}

describe('ActionPadEditor', () => {
  it.each([false, true])('opens the exact scoped button independently of labels or array order (reordered: %s)', (reordered) => {
    let draft: ActionPadConfig = {
      ...config(), menus: [...config().menus, {
        id: 'another', label: 'Home', groups: [
          { id: 'elsewhere', buttons: [{ id: 'input', label: 'Run input', tap: { type: 'input', nvimInput: 'wrong group', after: 'stay' } }] },
          { id: 'actions', buttons: [
            { id: 'other', label: 'Other', tap: { type: 'back', after: 'stay' } },
            { id: 'input', label: 'Run input', tap: { type: 'input', nvimInput: 'chosen', after: 'stay' } }
          ] }
        ]
      }]
    }
    if (reordered) draft = {
      ...draft, menus: [...draft.menus].reverse().map((menu) => ({
        ...menu, groups: [...menu.groups].reverse().map((group) => ({ ...group, buttons: [...group.buttons].reverse() }))
      }))
    }
    const screen = renderEditor({ config: draft, initialButton: { menuId: 'another', groupId: 'actions', buttonId: 'input' } })
    expect(screen.getByLabelText('Tap Neovim input').props.value).toBe('chosen')
    expect(screen.queryByTestId('action-pad-editor-target-notice')).toBeNull()
    fireEvent.changeText(screen.getByLabelText('Button label'), 'Changed scoped button')
    const changed = screen.draft().menus.find((menu) => menu.id === 'another')!
    expect(changed.groups.find((group) => group.id === 'actions')?.buttons.find((button) => button.id === 'input')?.label).toBe('Changed scoped button')
    expect(changed.groups.find((group) => group.id === 'elsewhere')?.buttons[0]?.label).toBe('Run input')
    expect(screen.draft().menus.find((menu) => menu.id === 'home')?.groups[0]?.buttons.find((button) => button.id === 'input')?.label).toBe('Run input')
  })

  it.each([
    { menuId: 'missing', groupId: 'actions', buttonId: 'input' },
    { menuId: 'home', groupId: 'missing', buttonId: 'input' },
    { menuId: 'home', groupId: 'actions', buttonId: 'missing' },
    { menuId: 'child', groupId: 'actions', buttonId: 'input' }
  ])('keeps the general editor and draft when target $menuId/$groupId/$buttonId is missing', (initialButton) => {
    const screen = renderEditor({ initialButton })
    expect(screen.getByLabelText('Button label').props.value).toBe('Run input')
    expect(screen.getByTestId('action-pad-editor-target-notice')).toHaveTextContent(/moved, renamed, or removed/)
    expect(screen.getByTestId('action-pad-editor-save')).toBeEnabled()
    expect(screen.draft()).toEqual(config())
    expect(screen.props.onChange).not.toHaveBeenCalled()
  })

  it('does not guess between ambiguous accepted ID tuples in an incomplete draft', () => {
    const draft = config()
    const child = draft.menus[1]!
    const group = child.groups[0]!
    const duplicate: ActionPadConfig = {
      ...draft, menus: [draft.menus[0]!, { ...child, groups: [{ ...group, buttons: [...group.buttons, ...group.buttons] }] }]
    }
    const screen = renderEditor({ config: duplicate, initialButton: { menuId: 'child', groupId: 'target', buttonId: 'back' } })
    expect(screen.getByLabelText('Button label').props.value).toBe('Run input')
    expect(screen.getByTestId('action-pad-editor-target-notice')).toBeTruthy()
    expect(screen.props.onChange).not.toHaveBeenCalled()
  })

  it('matches accepted IDs rather than colliding recovered text and keeps those raw edits', () => {
    const initialIdDrafts = { 'menus[0].groups[0].buttons[0].id': 'open', 'menus[0].groups[0].buttons[1].id': 'keyboard' }
    const onIdDraftsChange = jest.fn()
    const screen = renderEditor({ initialButton: { menuId: 'home', groupId: 'actions', buttonId: 'open' }, initialIdDrafts, onIdDraftsChange })
    expect(screen.getByLabelText('Button label').props.value).toBe('Open child')
    expect(screen.getByLabelText('Button ID').props.value).toBe('keyboard')
    expect(screen.getByTestId('action-pad-editor-save')).toBeDisabled()
    expect(screen.props.onChange).not.toHaveBeenCalled()
    expect(onIdDraftsChange).toHaveBeenLastCalledWith(initialIdDrafts)
    screen.unmount()
    expect(onIdDraftsChange).toHaveBeenLastCalledWith(initialIdDrafts)
  })

  it('preserves recovery when only a raw menu ID matches the requested target', () => {
    const initialIdDrafts = { 'menus[1].id': 'renamed' }
    const onIdDraftsChange = jest.fn()
    const screen = renderEditor({ initialButton: { menuId: 'renamed', groupId: 'target', buttonId: 'back' }, initialIdDrafts, onIdDraftsChange })
    expect(screen.getByLabelText('Button label').props.value).toBe('Run input')
    expect(screen.getByTestId('action-pad-editor-target-notice')).toBeTruthy()
    expect(screen.getByTestId('action-pad-editor-save')).toBeDisabled()
    expect(screen.draft()).toEqual(config())
    expect(onIdDraftsChange).toHaveBeenLastCalledWith(initialIdDrafts)
  })

  it('keeps the targeted button selected through ID renames, reordering and moving', () => {
    const screen = renderEditor({ initialButton: { menuId: 'child', groupId: 'target', buttonId: 'back' } })
    fireEvent.press(screen.getByRole('button', { name: 'Menu settings' }))
    fireEvent.changeText(screen.getByLabelText('Menu ID'), 'tools')
    fireEvent.press(screen.getByRole('button', { name: 'Group settings' }))
    fireEvent.changeText(screen.getByLabelText('Group ID'), 'renamed-group')
    fireEvent.press(screen.getByRole('button', { name: 'Button settings' }))
    fireEvent.changeText(screen.getByLabelText('Button ID'), 'renamed-button')
    expect(screen.getByLabelText('Button label').props.value).toBe('Go back')
    fireEvent.press(screen.getByRole('button', { name: 'Choose destination group' }))
    fireEvent.press(screen.getByRole('button', { name: 'Destination group: Home / actions' }))
    fireEvent.press(screen.getByRole('button', { name: 'Move to group' }))
    fireEvent.press(screen.getByRole('button', { name: 'Move button earlier' }))
    expect(screen.getByLabelText('Button label').props.value).toBe('Go back')
    expect(screen.getByLabelText('Button ID').props.value).toBe('renamed-button')
    expect(screen.draft().menus[0]?.groups[0]?.buttons[2]?.id).toBe('renamed-button')
    expect(screen.queryByTestId('action-pad-editor-target-notice')).toBeNull()
  })

  it('does not retarget an already open editor when the entry prop changes', () => {
    const initial = props({ initialButton: { menuId: 'child', groupId: 'target', buttonId: 'back' } })
    const screen = render(<ActionPadEditor {...initial} />)
    screen.rerender(<ActionPadEditor {...initial} initialButton={{ menuId: 'home', groupId: 'actions', buttonId: 'input' }} />)
    expect(screen.getByLabelText('Button label').props.value).toBe('Go back')
  })

  it.each(['Save', 'Load / Reload'])('resets targeted selection to the accepted root after %s', async (operation) => {
    const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockClear()
    const initial = props({ initialButton: { menuId: 'child', groupId: 'target', buttonId: 'back' } })
    function Harness() {
      const [draft, setDraft] = useState(initial.config)
      async function accept(callback: (path: string) => Promise<void>, path: string) {
        await callback(path)
        setDraft(JSON.parse(JSON.stringify(draft)) as ActionPadConfig)
      }
      return <ActionPadEditor {...initial} config={draft} onChange={(next) => setDraft(JSON.parse(JSON.stringify(next)) as ActionPadConfig)} onSave={(path) => accept(initial.onSave, path)} onLoad={(path) => accept(initial.onLoad, path)} />
    }
    const screen = render(<Harness />)
    fireEvent.changeText(screen.getByLabelText('Button label'), 'Edited target')
    fireEvent.press(screen.getByRole('button', { name: operation }))
    await waitFor(() => expect(screen.getByLabelText('Button label').props.value).toBe('Run input'))
    emitLayout(screen, 'action-pad-editor-workspace', 300)
    emitLayout(screen, 'action-pad-editor-details', 200)
    emitLayout(screen, 'action-pad-button-form', 0)
    fireEvent(screen.getByTestId('action-pad-editor-scroll'), 'contentSizeChange', 600, 2500)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('scrolls targeted entry to the card only after layout, once, without focusing any field', () => {
    const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockClear()
    const focus = jest.spyOn(TextInput.prototype, 'focus').mockClear()
    const screen = renderEditor({ initialButton: { menuId: 'child', groupId: 'target', buttonId: 'back' } })
    expect(scrollTo).not.toHaveBeenCalled()
    emitLayout(screen, 'action-pad-button-form', 0)
    emitLayout(screen, 'action-pad-editor-details', 240)
    fireEvent(screen.getByTestId('action-pad-editor-scroll'), 'contentSizeChange', 600, 2500)
    expect(scrollTo).not.toHaveBeenCalled()
    emitLayout(screen, 'action-pad-editor-workspace', 320)
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ y: 560, animated: false })
    fireEvent.changeText(screen.getByLabelText('Button label'), 'Still selected')
    emitLayout(screen, 'action-pad-editor-details', 0)
    emitLayout(screen, 'action-pad-editor-workspace', 400)
    fireEvent(screen.getByTestId('action-pad-editor-scroll'), 'contentSizeChange', 1200, 2000)
    expect(scrollTo).toHaveBeenCalledTimes(1)
    for (const input of screen.UNSAFE_getAllByType(TextInput)) expect(input.props.autoFocus).not.toBe(true)
    expect(focus).not.toHaveBeenCalled()
  })

  it.each([undefined, { menuId: 'missing', groupId: 'actions', buttonId: 'input' }])('does not scroll general or unmatched entry (%j)', (initialButton) => {
    const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockClear()
    const screen = renderEditor({ initialButton })
    emitLayout(screen, 'action-pad-editor-workspace', 320)
    emitLayout(screen, 'action-pad-editor-details', 240)
    emitLayout(screen, 'action-pad-button-form', 0)
    fireEvent(screen.getByTestId('action-pad-editor-scroll'), 'contentSizeChange', 600, 2500)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('edits labels, exact Neovim input, accessibility text and size with regular text fields', () => {
    const screen = renderEditor()
    const exactInput = '  <C-w>h\n\t0\uf07c🙂  '
    fireEvent.changeText(screen.getByLabelText('Button label'), '001 \uf07c')
    fireEvent.changeText(screen.getByLabelText('Tap Neovim input'), exactInput)
    fireEvent.changeText(screen.getByLabelText('Button ID'), 'new-id')
    fireEvent.changeText(screen.getByLabelText('Accessibility label'), 'Focus the previous pane')
    fireEvent.changeText(screen.getByLabelText('Accessibility hint'), 'Hold for the alternative')
    fireEvent.press(screen.getByRole('button', { name: 'Button size: Quarter' }))
    fireEvent.press(screen.getByRole('button', { name: 'Tap after: Return to root' }))

    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]).toEqual({
      id: 'new-id', label: '001 \uf07c', accessibilityLabel: 'Focus the previous pane',
      accessibilityHint: 'Hold for the alternative', styles: { size: '1/4' },
      tap: { type: 'input', nvimInput: exactInput, after: 'root' },
      longPress: { type: 'input', nvimInput: '<C-x>', after: 'stay' }
    })
    expect(StyleSheet.flatten(screen.getByLabelText('Button label').props.style)).toMatchObject({
      minHeight: 84, fontFamily: 'CodeyNerdFont-Regular'
    })
    expect(screen.props.onSave).not.toHaveBeenCalled()
    expect(screen.props.onLoad).not.toHaveBeenCalled()
  })

  it.each([true, false])('renders configurable editor labels with the Nerd Font when loaded (%s)', (loaded) => {
    mockUseCodeyNerdFontFaces.mockReturnValue([loaded, null])
    const original = config()
    const home = original.menus[0]!
    const child = original.menus[1]!
    const childGroup = child.groups[0]!
    const homeLabel = `Home ${mockBmpIcon.glyph}`
    const childLabel = `Child ${mockBmpIcon.glyph}`
    const buttonLabel = `Go back ${mockBmpIcon.glyph}`
    const draft: ActionPadConfig = {
      ...original,
      menus: [
        { ...home, label: homeLabel },
        {
          ...child,
          label: childLabel,
          groups: [{
            ...childGroup,
            buttons: childGroup.buttons.map((button, index) => index === 0 ? { ...button, label: buttonLabel } : button)
          }]
        }
      ]
    }
    const screen = renderEditor({
      config: draft,
      initialButton: { menuId: 'child', groupId: 'target', buttonId: 'back' }
    })

    const selectedMenu = within(screen.getByRole('button', { name: 'Choose menu' })).getByText(childLabel)
    const selectedButton = within(screen.getByRole('button', { name: 'Choose button' })).getByText(buttonLabel)
    fireEvent.press(screen.getByRole('button', { name: 'Choose button' }))
    const buttonOption = within(screen.getByRole('button', { name: `Button: ${buttonLabel}` })).getByText(buttonLabel)

    for (const selected of [selectedMenu, selectedButton]) {
      const style = StyleSheet.flatten(selected.props.style)
      expect(style.fontFamily).toBe(loaded ? 'CodeyNerdFont-Regular' : undefined)
      expect(style.fontWeight).toBe(loaded ? 'normal' : undefined)
    }
    const optionStyle = StyleSheet.flatten(buttonOption.props.style)
    expect(optionStyle.fontFamily).toBe(loaded ? 'CodeyNerdFont-SemiBold' : undefined)
    expect(optionStyle.fontWeight).toBe(loaded ? 'normal' : '600')

    fireEvent.press(screen.getByRole('button', { name: 'Choose button' }))
    fireEvent.press(screen.getByRole('button', { name: 'Menu settings' }))
    const deletionNotice = screen.getByText(`Remove menu links from ${homeLabel} before deleting this menu.`)
    const noticeStyle = StyleSheet.flatten(deletionNotice.props.style)
    expect(noticeStyle.fontFamily).toBe(loaded ? 'CodeyNerdFont-Regular' : undefined)
    expect(noticeStyle.fontWeight).toBe(loaded ? 'normal' : undefined)
  })

  it.each([
    {
      name: 'BMP icon at a collapsed cursor', selection: { start: 3, end: 3 }, action: 'Insert mock BMP icon',
      expected: `Run${mockBmpIcon.glyph} input`, caret: 4
    },
    {
      name: 'astral icon over selected text', selection: { start: 0, end: 3 }, action: 'Insert mock astral icon',
      expected: `${mockAstralIcon.glyph} input`, caret: 2
    }
  ])('inserts a $name and restores the label caret', async ({ selection, action, expected, caret }) => {
    const focus = jest.spyOn(TextInput.prototype, 'focus').mockClear()
    const screen = renderEditor()
    const label = screen.getByLabelText('Button label')
    fireEvent(label, 'selectionChange', { nativeEvent: { selection } })
    fireEvent.press(screen.getByRole('button', { name: 'Choose Nerd Font icon…' }))
    expect(screen.getByTestId('mock-nerd-font-icon-picker')).toBeTruthy()

    fireEvent.press(screen.getByRole('button', { name: action }))

    expect(screen.queryByTestId('mock-nerd-font-icon-picker')).toBeNull()
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toBe(expected)
    expect(screen.getByLabelText('Button label').props.selection).toEqual({ start: caret, end: caret })
    await waitFor(() => expect(focus).toHaveBeenCalled())
  })

  it('defaults icon insertion to the label end and dismisses without changing the draft', () => {
    const screen = renderEditor()
    fireEvent.press(screen.getByRole('button', { name: 'Choose Nerd Font icon…' }))
    fireEvent.press(screen.getByRole('button', { name: 'Close mock icon picker' }))
    expect(screen.draft()).toEqual(config())
    expect(screen.props.onChange).not.toHaveBeenCalled()

    fireEvent.press(screen.getByRole('button', { name: 'Choose Nerd Font icon…' }))
    fireEvent.press(screen.getByRole('button', { name: 'Insert mock BMP icon' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toBe(`Run input${mockBmpIcon.glyph}`)
  })

  it('does not reuse a deleted button selection when its successor takes the same indexes', () => {
    const alert = jest.spyOn(Alert, 'alert')
    const screen = renderEditor()
    fireEvent(screen.getByLabelText('Button label'), 'selectionChange', {
      nativeEvent: { selection: { start: 0, end: 3 } }
    })
    fireEvent.press(screen.getByRole('button', { name: 'Delete button' }))
    act(() => { alert.mock.calls[0]?.[2]?.find((item) => item.text === 'Delete')?.onPress?.() })
    expect(screen.getByLabelText('Button label').props.value).toBe('Open child')

    fireEvent.press(screen.getByRole('button', { name: 'Choose Nerd Font icon…' }))
    fireEvent.press(screen.getByRole('button', { name: 'Insert mock BMP icon' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toBe(`Open child${mockBmpIcon.glyph}`)
  })

  it.each([
    { loaded: false, error: null, name: 'Loading Nerd Font icons…' },
    { loaded: false, error: new Error('font failed'), name: 'Nerd Font icons unavailable' }
  ])('disables the icon chooser when the font is not ready ($name)', ({ loaded, error, name }) => {
    mockUseCodeyNerdFontFaces.mockReturnValue([loaded, error])
    const screen = renderEditor()
    expect(screen.getByRole('button', { name })).toBeDisabled()
    if (error) expect(screen.getByText(/icon previews are unavailable/)).toBeTruthy()
    expect(screen.queryByTestId('mock-nerd-font-icon-picker')).toBeNull()
  })

  it('closes the icon picker when work starts or the controlled document is replaced', async () => {
    const initial = props()
    const screen = render(<ActionPadEditor {...initial} />)
    fireEvent.press(screen.getByRole('button', { name: 'Choose Nerd Font icon…' }))
    expect(screen.getByTestId('mock-nerd-font-icon-picker')).toBeTruthy()

    screen.rerender(<ActionPadEditor {...initial} busy />)
    expect(screen.queryByTestId('mock-nerd-font-icon-picker')).toBeNull()

    screen.rerender(<ActionPadEditor {...initial} />)
    fireEvent.press(screen.getByRole('button', { name: 'Choose Nerd Font icon…' }))
    const replacement = { ...initial.config, menus: initial.config.menus.map((menu, index) => index === 0 ? { ...menu, label: 'Replacement' } : menu) }
    screen.rerender(<ActionPadEditor {...initial} config={replacement} />)
    await waitFor(() => expect(screen.queryByTestId('mock-nerd-font-icon-picker')).toBeNull())
  })

  it('configures tap and hold independently and supports hold-only buttons', () => {
    const screen = renderEditor()
    fireEvent.press(screen.getByRole('button', { name: 'Hold action: Menu' }))
    expect(screen.getByTestId('action-pad-editor-save')).toBeDisabled()
    fireEvent.press(screen.getByRole('button', { name: 'Choose hold menu' }))
    fireEvent.press(screen.getByRole('button', { name: 'Hold menu: Child (child)' }))
    fireEvent.press(screen.getByRole('button', { name: 'Hold after: Return to root' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.tap).toEqual({ type: 'input', nvimInput: 'x', after: 'stay' })
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.longPress).toEqual({ type: 'menu', menuId: 'child', after: 'root' })

    fireEvent.press(screen.getByRole('button', { name: 'Tap action: None' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]).not.toHaveProperty('tap')
    expect(screen.getByTestId('action-pad-editor-save')).toBeEnabled()
    fireEvent.press(screen.getByRole('button', { name: 'Hold action: None' }))
    expect(screen.getByTestId('action-pad-editor-save')).toBeDisabled()
    expect(screen.getAllByText('A button must define tap or longPress.').length).toBeGreaterThan(0)

    fireEvent.press(screen.getByRole('button', { name: 'Hold action: Back' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.longPress).toEqual({ type: 'back', after: 'stay' })
    expect(screen.getByTestId('action-pad-editor-save')).toBeEnabled()
    fireEvent.press(screen.getByRole('button', { name: 'Hold action: Keyboard' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.longPress?.type).toBe('keyboard')
  })

  it('creates, orders and removes buttons with a destructive confirmation', () => {
    const alert = jest.spyOn(Alert, 'alert')
    const screen = renderEditor()
    fireEvent.press(screen.getByRole('button', { name: 'Add button' }))
    expect(screen.getByLabelText('Button ID').props.value).toBe('button')
    expect(screen.getByTestId('action-pad-editor-save')).toBeDisabled()
    fireEvent.changeText(screen.getByLabelText('Tap Neovim input'), 'b')
    expect(screen.getByTestId('action-pad-editor-save')).toBeEnabled()
    fireEvent.press(screen.getByRole('button', { name: 'Move button earlier' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons.map((button) => button.id)).toEqual(['input', 'open', 'button', 'keyboard'])
    expect(screen.getByLabelText('Button ID').props.value).toBe('button')
    fireEvent.press(screen.getByRole('button', { name: 'Move button later' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons.map((button) => button.id)).toEqual(['input', 'open', 'keyboard', 'button'])
    fireEvent.press(screen.getByRole('button', { name: 'Delete button' }))
    expect(alert).toHaveBeenCalledWith('Delete button?', expect.any(String), expect.any(Array))
    expect(screen.draft().menus[0]?.groups[0]?.buttons).toHaveLength(4)
    act(() => { alert.mock.calls[0]?.[2]?.find((item) => item.text === 'Delete')?.onPress?.() })
    expect(screen.draft().menus[0]?.groups[0]?.buttons.map((button) => button.id)).toEqual(['input', 'open', 'keyboard'])
  })

  it('duplicates the selected button beside its source and selects an independent copy', () => {
    const screen = renderEditor()
    fireEvent.changeText(screen.getByLabelText('Accessibility label'), 'Run Neovim input')
    fireEvent.changeText(screen.getByLabelText('Accessibility hint'), 'Hold for the alternate input')
    fireEvent.press(screen.getByRole('button', { name: 'Button size: Quarter' }))
    fireEvent.press(screen.getByRole('button', { name: 'Duplicate button' }))

    expect(screen.draft().menus[0]?.groups[0]?.buttons.map((button) => button.id)).toEqual(['input', 'input-2', 'open', 'keyboard'])
    expect(screen.draft().menus[0]?.groups[0]?.buttons[1]).toEqual({
      id: 'input-2', label: 'Run input copy',
      accessibilityLabel: 'Run Neovim input', accessibilityHint: 'Hold for the alternate input',
      styles: { size: '1/4' },
      tap: { type: 'input', nvimInput: 'x', after: 'stay' },
      longPress: { type: 'input', nvimInput: '<C-x>', after: 'stay' }
    })
    expect(screen.getByLabelText('Button ID').props.value).toBe('input-2')
    expect(screen.getByLabelText('Button label').props.value).toBe('Run input copy')

    fireEvent.changeText(screen.getByLabelText('Button label'), 'Independent copy')
    fireEvent.changeText(screen.getByLabelText('Tap Neovim input'), 'copy-only')
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]).toMatchObject({
      id: 'input', label: 'Run input', tap: { type: 'input', nvimInput: 'x', after: 'stay' }
    })
    expect(screen.draft().menus[0]?.groups[0]?.buttons[1]).toMatchObject({
      id: 'input-2', label: 'Independent copy', tap: { type: 'input', nvimInput: 'copy-only', after: 'stay' }
    })
  })

  it('disables duplication when there is no selected button', () => {
    const screen = renderEditor({
      config: { version: 1, rootMenuId: 'empty', menus: [{ id: 'empty', label: 'Empty', groups: [{ id: 'actions', buttons: [] }] }] }
    })
    expect(screen.getByRole('button', { name: 'Duplicate button' })).toBeDisabled()
  })

  it('does not apply a stale Delete confirmation after a host document replaces the draft', () => {
    const alert = jest.spyOn(Alert, 'alert')
    const initial = props()
    const screen = render(<ActionPadEditor {...initial} />)
    fireEvent.press(screen.getByRole('button', { name: 'Delete button' }))
    const replacement: ActionPadConfig = {
      version: 1, rootMenuId: 'loaded', menus: [{ id: 'loaded', label: 'Loaded', groups: [] }]
    }
    screen.rerender(<ActionPadEditor {...initial} config={replacement} />)
    act(() => { alert.mock.calls[0]?.[2]?.find((item) => item.text === 'Delete')?.onPress?.() })
    expect(initial.onChange).not.toHaveBeenCalled()
    expect(screen.getByText('The configuration changed while the confirmation was open. Review the new document and try again.')).toBeTruthy()
  })

  it('creates menus and groups, updates root IDs and protects linked menus', () => {
    const screen = renderEditor()
    fireEvent.press(screen.getByRole('button', { name: 'Menu settings' }))
    fireEvent.changeText(screen.getByLabelText('Menu ID'), 'start')
    expect(screen.draft().rootMenuId).toBe('start')
    expect(screen.getByRole('button', { name: 'Delete menu' })).toBeDisabled()
    fireEvent.press(screen.getByRole('button', { name: 'Choose menu' }))
    fireEvent.press(screen.getByRole('button', { name: 'Menu: Child' }))
    fireEvent.press(screen.getByRole('button', { name: 'Menu settings' }))
    fireEvent.changeText(screen.getByLabelText('Menu ID'), 'tools')
    expect(screen.draft().menus[0]?.groups[0]?.buttons[1]?.tap).toMatchObject({ menuId: 'tools' })
    expect(screen.getByRole('button', { name: 'Delete menu' })).toBeDisabled()
    expect(screen.getByText('Remove menu links from Home before deleting this menu.')).toBeTruthy()

    fireEvent.press(screen.getByRole('button', { name: 'Add menu' }))
    fireEvent.changeText(screen.getByLabelText('Menu label'), 'New root')
    fireEvent.press(screen.getByRole('button', { name: 'Use as root menu' }))
    expect(screen.draft().rootMenuId).toBe('menu')
    fireEvent.press(screen.getByRole('button', { name: 'Add group' }))
    fireEvent.changeText(screen.getByLabelText('Group ID'), 'custom-group')
    expect(screen.draft().menus[2]?.groups[0]?.id).toBe('custom-group')
    fireEvent.press(screen.getByRole('button', { name: 'Add group' }))
    fireEvent.press(screen.getByRole('button', { name: 'Move group earlier' }))
    expect(screen.draft().menus[2]?.groups.map((group) => group.id)).toEqual(['group', 'custom-group'])
    fireEvent.press(screen.getByRole('button', { name: 'Delete group' }))
    expect(screen.draft().menus[2]?.groups.map((group) => group.id)).toEqual(['custom-group'])
  })

  it('moves buttons to a group in another menu and keeps the moved button selected', () => {
    const screen = renderEditor()
    fireEvent.press(screen.getByRole('button', { name: 'Choose destination group' }))
    fireEvent.press(screen.getByRole('button', { name: 'Destination group: Child / target' }))
    fireEvent.press(screen.getByRole('button', { name: 'Move to group' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons.map((button) => button.id)).toEqual(['open', 'keyboard'])
    expect(screen.draft().menus[1]?.groups[0]?.buttons.map((button) => button.id)).toEqual(['back', 'input'])
    expect(screen.getByLabelText('Button ID').props.value).toBe('input')
  })

  it('shows field errors and keeps the last valid preview while a field is incomplete', () => {
    const screen = renderEditor()
    const preview = () => within(screen.getByTestId('action-pad-editor-preview'))
    fireEvent.changeText(screen.getByLabelText('Button label'), '')
    expect(screen.getByTestId('action-pad-editor-save')).toBeDisabled()
    expect(preview().getByText('Run input')).toBeTruthy()
    expect(preview().getByText('Showing the last valid preview while you complete the fields.')).toBeTruthy()
    expect(StyleSheet.flatten(screen.getByLabelText('Button label').props.style).borderColor).toBe('#ff7b72')
    fireEvent.changeText(screen.getByLabelText('Button label'), 'Updated')
    expect(preview().getByText('Updated')).toBeTruthy()
    expect(preview().queryByText('Run input')).toBeNull()
    expect(screen.getByTestId('action-pad-editor-save')).toBeEnabled()

    fireEvent.changeText(screen.getByLabelText('Button ID'), 'open')
    expect(screen.getByLabelText('Button ID').props.value).toBe('open')
    expect(screen.getAllByText('A button with ID “open” already exists in this group.').length).toBeGreaterThan(0)
    expect(screen.getByTestId('action-pad-editor-save')).toBeDisabled()
    fireEvent.changeText(screen.getByLabelText('Button ID'), 'unique')
    expect(screen.getByTestId('action-pad-editor-save')).toBeEnabled()
  })

  it('buffers colliding ID prefixes without rewriting another menu’s references', () => {
    const onIdDraftsChange = jest.fn()
    const onPendingEditsChange = jest.fn()
    const screen = renderEditor({ onIdDraftsChange, onPendingEditsChange })
    fireEvent.press(screen.getByRole('button', { name: 'Menu settings' }))
    fireEvent.changeText(screen.getByLabelText('Menu ID'), '')
    fireEvent.changeText(screen.getByLabelText('Menu ID'), 'chil')
    fireEvent.changeText(screen.getByLabelText('Menu ID'), 'child')
    expect(screen.getByLabelText('Menu ID').props.value).toBe('child')
    expect(screen.draft().rootMenuId).toBe('chil')
    expect(screen.draft().menus[1]?.id).toBe('child')
    expect(screen.getByTestId('action-pad-editor-save')).toBeDisabled()
    expect(onIdDraftsChange).toHaveBeenLastCalledWith({ 'menus[0].id': 'child' })
    expect(onPendingEditsChange).toHaveBeenLastCalledWith(true)
    fireEvent.changeText(screen.getByLabelText('Menu ID'), 'child-new')
    expect(screen.draft().rootMenuId).toBe('child-new')
    expect(screen.draft().menus[0]?.groups[0]?.buttons[1]?.tap).toMatchObject({ menuId: 'child' })
    expect(screen.getByTestId('action-pad-editor-save')).toBeEnabled()
    expect(onIdDraftsChange).toHaveBeenLastCalledWith({})
    expect(onPendingEditsChange).toHaveBeenLastCalledWith(false)
  })

  it('keeps a pending ID across other edits and navigation, with structure guarded until undo', () => {
    const screen = renderEditor()
    fireEvent.changeText(screen.getByLabelText('Button ID'), 'open')
    fireEvent.changeText(screen.getByLabelText('Button label'), 'A different label')
    expect(screen.getByLabelText('Button ID').props.value).toBe('open')
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.id).toBe('input')
    expect(screen.getByRole('button', { name: 'Move button later' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete button' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Duplicate button' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add menu' })).toBeDisabled()
    fireEvent.press(screen.getByRole('button', { name: 'Menu settings' }))
    expect(screen.getByTestId('action-pad-editor-save')).toBeDisabled()
    fireEvent.press(screen.getByRole('button', { name: 'Button settings' }))
    expect(screen.getByLabelText('Button ID').props.value).toBe('open')
    fireEvent.press(screen.getByRole('button', { name: 'Undo Button ID edit' }))
    expect(screen.getByLabelText('Button ID').props.value).toBe('input')
    expect(screen.getByTestId('action-pad-editor-save')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Move button later' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Duplicate button' })).toBeEnabled()
  })

  it('clears stale ID errors and selections when a replacement document is loaded', () => {
    const initial = props()
    const screen = render(<ActionPadEditor {...initial} />)
    fireEvent.press(screen.getByRole('button', { name: 'Choose menu' }))
    fireEvent.press(screen.getByRole('button', { name: 'Menu: Child' }))
    fireEvent.press(screen.getByRole('button', { name: 'Menu settings' }))
    fireEvent.changeText(screen.getByLabelText('Menu ID'), 'home')
    expect(screen.getByTestId('action-pad-editor-save')).toBeDisabled()
    const replacement: ActionPadConfig = {
      version: 1, rootMenuId: 'new-root', menus: [
        { id: 'other', label: 'Other', groups: [] },
        { id: 'new-root', label: 'Loaded root', groups: [{ id: 'loaded-group', buttons: [{ id: 'loaded-button', label: 'Loaded button', tap: { type: 'back', after: 'stay' } }] }] }
      ]
    }
    screen.rerender(<ActionPadEditor {...initial} config={replacement} />)
    expect(screen.getByLabelText('Button label').props.value).toBe('Loaded button')
    expect(screen.getByTestId('action-pad-editor-save')).toBeEnabled()
    expect(screen.queryByText('A menu with ID “home” already exists. Choose a unique ID.')).toBeNull()
  })

  it('restores raw ID drafts and leaves them available for recovery when the editor closes', () => {
    const onIdDraftsChange = jest.fn()
    const screen = renderEditor({ initialIdDrafts: { 'menus[0].groups[0].buttons[0].id': 'open' }, onIdDraftsChange })
    expect(screen.getByLabelText('Button ID').props.value).toBe('open')
    expect(screen.getByTestId('action-pad-editor-save')).toBeDisabled()
    expect(screen.getByText('Unsaved changes · Host connected')).toBeTruthy()
    expect(onIdDraftsChange).toHaveBeenLastCalledWith({ 'menus[0].groups[0].buttons[0].id': 'open' })
    screen.unmount()
    expect(onIdDraftsChange).toHaveBeenLastCalledWith({ 'menus[0].groups[0].buttons[0].id': 'open' })
  })

  it('serializes file requests while waiting for the parent’s confirmation', async () => {
    let finishLoad!: () => void
    const onLoad = jest.fn(() => new Promise<void>((resolve) => { finishLoad = resolve }))
    const screen = renderEditor({ onLoad })
    fireEvent.press(screen.getByRole('button', { name: 'Load / Reload' }))
    fireEvent.press(screen.getByRole('button', { name: 'Load / Reload' }))
    expect(onLoad).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Button label').props.editable).toBe(false)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await act(async () => { finishLoad() })
    expect(screen.getByLabelText('Button label').props.editable).toBe(true)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('isolates input and keyboard preview actions while allowing menu navigation', () => {
    const screen = renderEditor()
    const preview = within(screen.getByTestId('action-pad-editor-preview'))
    const input = preview.getByTestId('action-pad-input')
    fireEvent.press(input)
    fireEvent(input, 'pressIn')
    fireEvent(input, 'longPress')
    fireEvent.press(input)
    fireEvent.press(preview.getByTestId('action-pad-keyboard'))
    fireEvent.press(preview.getByTestId('action-pad-open'))
    expect(preview.getByLabelText('Current action path: Child')).toBeTruthy()
    fireEvent.press(preview.getByTestId('action-pad-back'))
    expect(preview.getByTestId('action-pad-input')).toBeTruthy()

    expect(screen.props.onChange).not.toHaveBeenCalled()
    expect(screen.props.onLoad).not.toHaveBeenCalled()
    expect(screen.props.onSave).not.toHaveBeenCalled()
    expect(screen.props.onExport).not.toHaveBeenCalled()
    expect(screen.props.onCancel).not.toHaveBeenCalled()
  })

  it('passes host paths and file commands to the parent without activating or saving implicitly', async () => {
    const screen = renderEditor({ dirty: true })
    expect(screen.getByText('Unsaved changes · Host connected')).toBeTruthy()
    fireEvent.changeText(screen.getByLabelText('Host YAML path'), '/repo/config/action pad.yaml')
    fireEvent.press(screen.getByRole('button', { name: 'Load' }))
    await waitFor(() => expect(screen.props.onLoad).toHaveBeenCalledWith('/repo/config/action pad.yaml'))
    fireEvent.press(screen.getByTestId('action-pad-editor-save'))
    await waitFor(() => expect(screen.props.onSave).toHaveBeenCalledWith('/repo/config/action pad.yaml'))
    fireEvent.press(screen.getByRole('button', { name: 'Export copy…' }))
    fireEvent.changeText(screen.getByLabelText('Export YAML path'), '~/repo/copy.yaml')
    fireEvent.press(screen.getByRole('button', { name: 'Write exported copy' }))
    await waitFor(() => expect(screen.props.onExport).toHaveBeenCalledWith('~/repo/copy.yaml'))
    expect(screen.props.onChange).not.toHaveBeenCalled()
    expect(screen.getByText('Unsaved changes · Host connected')).toBeTruthy()
    fireEvent.press(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.props.onCancel).toHaveBeenCalledTimes(1)
  })

  it('allows offline edits but blocks file operations, and disables editing while busy', () => {
    const screen = renderEditor({ connected: false })
    expect(screen.getByText('No unsaved changes · Offline editing')).toBeTruthy()
    fireEvent.press(screen.getByTestId('action-pad-editor-save'))
    fireEvent.press(screen.getByRole('button', { name: 'Load / Reload' }))
    fireEvent.press(screen.getByRole('button', { name: 'Export copy…' }))
    fireEvent.changeText(screen.getByLabelText('Export YAML path'), '~/copy.yaml')
    expect(screen.getByRole('button', { name: 'Write exported copy' })).toBeDisabled()
    fireEvent.changeText(screen.getByLabelText('Button label'), 'Offline change')
    expect(screen.props.onChange).toHaveBeenCalledTimes(1)
    expect(screen.props.onSave).not.toHaveBeenCalled()
    expect(screen.props.onLoad).not.toHaveBeenCalled()
    expect(screen.props.onExport).not.toHaveBeenCalled()
    screen.unmount()

    const busy = renderEditor({ busy: true })
    expect(busy.getByTestId('action-pad-editor-save')).toBeDisabled()
    expect(busy.getByLabelText('Button label').props.editable).toBe(false)
    expect(busy.getByRole('button', { name: 'Add button' })).toBeDisabled()
    expect(busy.getByRole('button', { name: 'Duplicate button' })).toBeDisabled()
    expect(busy.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('retains a draft when a host callback fails and shows the actionable error', async () => {
    const screen = renderEditor({ onSave: jest.fn().mockRejectedValue(new Error('Host file changed. Reload or export your draft.')) })
    fireEvent.changeText(screen.getByLabelText('Button label'), 'Keep this draft')
    fireEvent.press(screen.getByTestId('action-pad-editor-save'))
    await waitFor(() => expect(screen.getByText('Host file changed. Reload or export your draft.')).toBeTruthy())
    expect(screen.getByLabelText('Button label').props.value).toBe('Keep this draft')
  })

  it('adapts to tablet rotation without losing selected fields and keeps controls at least 48dp', () => {
    const previousWindow = Dimensions.get('window')
    const previousScreen = Dimensions.get('screen')
    act(() => { Dimensions.set({ window: { width: 600, height: 1000, scale: 1, fontScale: 1 }, screen: { width: 600, height: 1000, scale: 1, fontScale: 1 } }) })
    const screen = renderEditor()
    fireEvent.changeText(screen.getByLabelText('Button label'), 'Rotation draft')
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-editor-workspace').props.style).flexDirection).toBeUndefined()
    act(() => { Dimensions.set({ window: { width: 1280, height: 800, scale: 1, fontScale: 1 }, screen: { width: 1280, height: 800, scale: 1, fontScale: 1 } }) })
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-editor-workspace').props.style).flexDirection).toBe('row')
    expect(screen.getByLabelText('Button label').props.value).toBe('Rotation draft')
    for (const name of ['Save', 'Add menu', 'Add group', 'Add button', 'Duplicate button', 'Choose menu', 'Choose group', 'Choose button']) {
      const style = StyleSheet.flatten(screen.getByRole('button', { name }).props.style)
      expect(style.minHeight).toBeGreaterThanOrEqual(48)
    }
    act(() => { Dimensions.set({ window: previousWindow, screen: previousScreen }) })
  })
})
