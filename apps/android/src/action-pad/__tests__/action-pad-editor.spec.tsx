import { useState } from 'react'
import { Alert, Dimensions, ScrollView, StyleSheet, TextInput } from 'react-native'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react-native'

import { ActionPadEditor, type ActionPadEditorProps } from '../ActionPadEditor'
import { ActionPad } from '../ActionPad'
import { NerdFontIconPicker } from '../NerdFontIconPicker'
import { resolveActionPadConfig, type ActionPadConfig } from '../document'
import type { ActionPadNotice, ActionPadOperation } from '../store'
import { type ActionButtonLabel } from '../types'

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
              id: 'input', label: 'Run input', styles: { size: '1/2' }, tap: { type: 'input', nvimInput: 'x', after: 'stay' },
              longPress: { type: 'input', nvimInput: '<C-x>', after: 'stay' }
            },
            { id: 'open', label: 'Open child', styles: { size: '1/2' }, tap: { type: 'menu', menuId: 'child', after: 'stay' } },
            { id: 'keyboard', label: 'Keyboard', styles: { size: '1/2' }, tap: { type: 'keyboard', after: 'stay' } }
          ]
        }]
      },
      {
        id: 'child', label: 'Child', groups: [{
          id: 'target', buttons: [{ id: 'back', label: 'Go back', styles: { size: '1/2' }, tap: { type: 'back', after: 'stay' } }]
        }]
      }
    ]
  }
}

function menuManagerConfig(): ActionPadConfig {
  return {
    version: 1,
    rootMenuId: 'home',
    menus: [
      {
        id: 'home', label: 'Home', groups: [{
          id: 'actions', buttons: [
            {
              id: 'launch', label: 'Launch child', styles: { size: '1/2' },
              tap: { type: 'menu', menuId: 'child', after: 'stay' },
              longPress: { type: 'group', menuId: 'child', groupId: 'target', after: 'stay' }
            },
            {
              id: 'alternate', label: 'Alternate child', styles: { size: '1/2' },
              tap: { type: 'group', menuId: 'child', groupId: 'target', after: 'stay' },
              longPress: { type: 'menu', menuId: 'child', after: 'stay' }
            }
          ]
        }]
      },
      {
        id: 'child', label: 'Child', groups: [{
          id: 'target', buttons: [{ id: 'back', label: 'Go back', styles: { size: '1/2' }, tap: { type: 'back', after: 'stay' } }]
        }]
      },
      {
        id: 'orphan-parent', label: 'Orphan parent', groups: [{
          id: 'tools', buttons: [{
            id: 'open-orphan', label: 'Open orphan child', styles: { size: '1/2' },
            tap: { type: 'menu', menuId: 'orphan-child', after: 'stay' }
          }]
        }]
      },
      {
        id: 'orphan-child', label: 'Orphan child', groups: [{
          id: 'leaf', buttons: [{
            id: 'noop', label: 'No-op', styles: { size: '1/2' }, tap: { type: 'input', nvimInput: '<Nop>', after: 'stay' }
          }]
        }]
      }
    ]
  }
}

function props(overrides: Partial<ActionPadEditorProps> = {}): ActionPadEditorProps {
  return {
    config: config(), onChange: jest.fn(), connected: true, busy: false, dirty: false,
    initialLoadPending: false,
    sourcePath: '/storage/emulated/0/Codey/action-pad.yaml',
    onLoad: jest.fn().mockResolvedValue(undefined), onSave: jest.fn().mockResolvedValue(undefined),
    onCancel: jest.fn(), onOpenLogs: jest.fn(),
    initialButton: { menuId: 'home', groupId: 'actions', buttonId: 'input' },
    ...overrides
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

function configWithLabel(label: ActionButtonLabel): ActionPadConfig {
  const original = config()
  return {
    ...original,
    menus: original.menus.map((menu, menuIndex) => menuIndex === 0 ? {
      ...menu,
      groups: menu.groups.map((group, groupIndex) => groupIndex === 0 ? {
        ...group,
        buttons: group.buttons.map((button, buttonIndex) => buttonIndex === 0 ? { ...button, label } : button)
      } : group)
    } : menu)
  }
}

function selectRunText(screen: ReturnType<typeof render>, run: number, start: number, end = start) {
  fireEvent(screen.getByLabelText(run === 1 ? 'Button label' : `Button label run ${run}`), 'selectionChange', {
    nativeEvent: { selection: { start, end } }
  })
}

function captureIconInsertion(screen: ReturnType<typeof render>) {
  const onSelect: (icon: typeof mockBmpIcon) => void = screen.UNSAFE_getByType(NerdFontIconPicker).props.onSelect
  return () => onSelect(mockBmpIcon)
}

function emitLayout(screen: ReturnType<typeof render>, testID: string, y: number) {
  fireEvent(screen.getByTestId(testID), 'layout', { nativeEvent: { layout: { x: 0, y, width: 600, height: 200 } } })
}

describe('ActionPadEditor', () => {
  it('opens Logs from the editor header without cancelling the editor', () => {
    const onOpenLogs = jest.fn()
    const onCancel = jest.fn()
    const screen = renderEditor({ onOpenLogs, onCancel })

    fireEvent.press(screen.getByRole('button', { name: 'Logs' }))

    expect(onOpenLogs).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByTestId('action-pad-editor')).toBeTruthy()
  })

  it('opens general entry in Manage menus while a targeted entry opens Button settings', () => {
    const general = renderEditor({ initialButton: undefined })
    expect(general.getByTestId('action-pad-menu-manager')).toBeTruthy()
    expect(general.getByRole('button', { name: 'Manage menus' }).props.accessibilityState.selected).toBe(true)
    expect(general.queryByTestId('action-pad-button-form')).toBeNull()
    general.unmount()

    const targeted = renderEditor()
    expect(targeted.getByTestId('action-pad-button-form')).toBeTruthy()
    expect(targeted.getByRole('button', { name: 'Button settings' }).props.accessibilityState.selected).toBe(true)
    expect(targeted.queryByTestId('action-pad-menu-manager')).toBeNull()
  })

  it('lists label, ID, structure, incoming count and Root, Reachable or Unused status for every menu', () => {
    const screen = renderEditor({ config: menuManagerConfig(), initialButton: undefined })
    const expected = [
      ['Home (home)', 'Root · Reachable', '1 group · 2 buttons · 0 incoming links'],
      ['Child (child)', 'Reachable', '1 group · 1 button · 4 incoming links'],
      ['Orphan parent (orphan-parent)', 'Unused', '1 group · 1 button · 0 incoming links'],
      ['Orphan child (orphan-child)', 'Unused', '1 group · 1 button · 1 incoming link']
    ] as const

    for (const [index, rowExpected] of expected.entries()) {
      const row = within(screen.getByTestId(`action-pad-menu-row-${index}`))
      for (const text of rowExpected) expect(row.getByText(text)).toBeTruthy()
    }
    expect(screen.getByTestId('action-pad-remove-unused-menus')).toBeEnabled()
  })

  it('names exact Tap, Hold, Menu and Group blockers and navigates to the highlighted interaction', () => {
    const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockClear()
    const screen = renderEditor({ config: menuManagerConfig(), initialButton: undefined })
    const expectedLabels = [
      'Home (home) / actions / Launch child (launch) · Tap Menu action',
      'Home (home) / actions / Launch child (launch) · Hold Group action',
      'Home (home) / actions / Alternate child (alternate) · Tap Group action',
      'Home (home) / actions / Alternate child (alternate) · Hold Menu action'
    ]
    const showReferences = () => fireEvent.press(screen.getByRole('button', {
      name: 'Show 4 blocking references for Child (child)'
    }))

    showReferences()
    expectedLabels.forEach((label, index) => {
      expect(screen.getByTestId(`action-pad-reference-1-${index}`).props.accessibilityLabel).toBe(label)
    })
    expect(screen.getByRole('button', { name: 'Delete Child (child)' })).toBeDisabled()

    fireEvent.press(screen.getByTestId('action-pad-reference-1-0'))
    expect(screen.getByLabelText('Button ID').props.value).toBe('launch')
    expect(within(screen.getByTestId('action-pad-interaction-tap')).getByText(
      /^This Tap Menu action links to Child \(child\)\./
    )).toBeTruthy()
    fireEvent(screen.getByTestId('action-pad-editor-scroll'), 'contentSizeChange', 600, 2500)
    emitLayout(screen, 'action-pad-editor-workspace', 300)
    emitLayout(screen, 'action-pad-editor-details', 200)
    emitLayout(screen, 'action-pad-button-form', 40)
    emitLayout(screen, 'action-pad-interaction-tap', 500)
    expect(scrollTo).toHaveBeenCalledWith({ y: 1040, animated: true })

    fireEvent.press(screen.getByRole('button', { name: 'Manage menus' }))
    showReferences()
    fireEvent.press(screen.getByTestId('action-pad-reference-1-1'))
    expect(screen.getByLabelText('Button ID').props.value).toBe('launch')
    expect(within(screen.getByTestId('action-pad-interaction-longPress')).getByText(
      /^This Hold Group action links to Child \(child\)\./
    )).toBeTruthy()

    fireEvent.press(screen.getByRole('button', { name: 'Manage menus' }))
    showReferences()
    fireEvent.press(screen.getByTestId('action-pad-reference-1-2'))
    expect(screen.getByLabelText('Button ID').props.value).toBe('alternate')
    expect(within(screen.getByTestId('action-pad-interaction-tap')).getByText(
      /^This Tap Group action links to Child \(child\)\./
    )).toBeTruthy()

    fireEvent.press(screen.getByRole('button', { name: 'Manage menus' }))
    showReferences()
    fireEvent.press(screen.getByTestId('action-pad-reference-1-3'))
    expect(screen.getByLabelText('Button ID').props.value).toBe('alternate')
    expect(within(screen.getByTestId('action-pad-interaction-longPress')).getByText(
      /^This Hold Menu action links to Child \(child\)\./
    )).toBeTruthy()
  })

  it('keeps large blocker sets collapsed and pages them without mounting every reference', () => {
    const base = config()
    const home = base.menus[0]!
    const manyReferences: ActionPadConfig = {
      ...base,
      menus: [{
        ...home,
        groups: [{
          id: 'actions',
          buttons: Array.from({ length: 30 }, (_, index) => ({
            id: `link-${index + 1}`,
            label: `Link ${index + 1}`,
            styles: { size: '1/2' as const },
            tap: { type: 'menu' as const, menuId: 'child', after: 'stay' as const }
          }))
        }]
      }, base.menus[1]!]
    }
    const screen = renderEditor({ config: manyReferences, initialButton: undefined })

    expect(screen.queryByTestId('action-pad-reference-1-0')).toBeNull()
    fireEvent.press(screen.getByRole('button', { name: 'Show 30 blocking references for Child (child)' }))
    expect(screen.getByText('Showing 1–25 of 30.')).toBeTruthy()
    expect(screen.getByTestId('action-pad-reference-1-0')).toBeTruthy()
    expect(screen.getByTestId('action-pad-reference-1-24')).toBeTruthy()
    expect(screen.queryByTestId('action-pad-reference-1-25')).toBeNull()

    fireEvent.press(screen.getByRole('button', { name: 'Next references for Child (child)' }))
    expect(screen.getByText('Showing 26–30 of 30.')).toBeTruthy()
    expect(screen.queryByTestId('action-pad-reference-1-24')).toBeNull()
    expect(screen.getByTestId('action-pad-reference-1-25')).toBeTruthy()
    expect(screen.getByTestId('action-pad-reference-1-29')).toBeTruthy()
  })

  it.each([false, true])('opens the exact scoped button independently of labels or array order (reordered: %s)', (reordered) => {
    let draft: ActionPadConfig = {
      ...config(), menus: [...config().menus, {
        id: 'another', label: 'Home', groups: [
          { id: 'elsewhere', buttons: [{ id: 'input', label: 'Run input', styles: { size: '1/2' }, tap: { type: 'input', nvimInput: 'wrong group', after: 'stay' } }] },
          { id: 'actions', buttons: [
            { id: 'other', label: 'Other', styles: { size: '1/2' }, tap: { type: 'back', after: 'stay' } },
            { id: 'input', label: 'Run input', styles: { size: '1/2' }, tap: { type: 'input', nvimInput: 'chosen', after: 'stay' } }
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
  ])('keeps the general editor and working copy when target $menuId/$groupId/$buttonId is missing', (initialButton) => {
    const screen = renderEditor({ initialButton })
    expect(screen.getByTestId('action-pad-menu-manager')).toBeTruthy()
    expect(screen.queryByTestId('action-pad-button-form')).toBeNull()
    expect(screen.getByTestId('action-pad-editor-target-notice')).toHaveTextContent(/moved, renamed, or removed/)
    expect(screen.getByTestId('action-pad-editor-save')).toBeEnabled()
    expect(screen.draft()).toEqual(config())
    expect(screen.props.onChange).not.toHaveBeenCalled()
  })

  it('does not guess between ambiguous accepted ID tuples in an incomplete edit', () => {
    const draft = config()
    const child = draft.menus[1]!
    const group = child.groups[0]!
    const duplicate: ActionPadConfig = {
      ...draft, menus: [draft.menus[0]!, { ...child, groups: [{ ...group, buttons: [...group.buttons, ...group.buttons] }] }]
    }
    const screen = renderEditor({ config: duplicate, initialButton: { menuId: 'child', groupId: 'target', buttonId: 'back' } })
    expect(screen.getByTestId('action-pad-menu-manager')).toBeTruthy()
    expect(screen.getByTestId('action-pad-editor-target-notice')).toBeTruthy()
    expect(screen.props.onChange).not.toHaveBeenCalled()
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
    fireEvent.press(screen.getByRole('button', { name: 'Destination group: Home (home) / actions' }))
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

  it.each(['Save', 'Reload'])('resets targeted selection to the accepted root after %s', async (operation) => {
    const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockClear()
    const initial = props({ initialButton: { menuId: 'child', groupId: 'target', buttonId: 'back' } })
    function Harness() {
      const [draft, setDraft] = useState(initial.config)
      async function accept(callback: () => Promise<void>) {
        await callback()
        setDraft(JSON.parse(JSON.stringify(draft)) as ActionPadConfig)
      }
      return <ActionPadEditor {...initial} config={draft} onChange={(next) => setDraft(JSON.parse(JSON.stringify(next)) as ActionPadConfig)} onSave={() => accept(initial.onSave)} onLoad={() => accept(initial.onLoad)} />
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
    fireEvent(screen.getByTestId('action-pad-editor-scroll'), 'contentSizeChange', 600, 2500)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('edits labels, exact Neovim input, accessibility text and size with regular text fields', () => {
    const screen = renderEditor()
    const exactInput = '  <C-w>h\n\t0\uf07c🙂  '
    expect(screen.getByRole('button', { name: 'Button size: Half' }).props.accessibilityState.selected).toBe(true)
    expect(screen.queryByRole('button', { name: 'Button size: Default' })).toBeNull()
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

  it('edits every size plus appearance and colour overrides without discarding sibling styles', () => {
    const screen = renderEditor()
    for (const size of ['Whole', 'Half', 'Third', 'Quarter', 'Fifth']) {
      expect(screen.getByRole('button', { name: `Button size: ${size}` })).toBeTruthy()
    }

    fireEvent.press(screen.getByRole('button', { name: 'Button size: Third' }))
    fireEvent.press(screen.getByRole('button', { name: 'Button appearance: Outline' }))
    fireEvent.press(screen.getByRole('button', { name: 'Button background color: Green' }))
    fireEvent.changeText(screen.getByLabelText('Button outline color custom hex'), '#ABCDEF')

    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.styles).toEqual({
      size: '1/3', appearance: 'outline', backgroundColor: '#9ece6a', outlineColor: '#ABCDEF'
    })
    expect(StyleSheet.flatten(screen.getByTestId('action-button-label-preview-button', { includeHiddenElements: true }).props.style)).toMatchObject({
      width: '30.6666%', backgroundColor: '#9ece6a', borderColor: '#ABCDEF'
    })

    fireEvent.press(screen.getByRole('button', { name: 'Button size: Whole' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.styles).toEqual({
      size: '1/1', appearance: 'outline', backgroundColor: '#9ece6a', outlineColor: '#ABCDEF'
    })
    fireEvent.press(screen.getByRole('button', { name: 'Button background color: Default' }))
    fireEvent.press(screen.getByRole('button', { name: 'Button appearance: Filled' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.styles).toEqual({
      size: '1/1', outlineColor: '#ABCDEF'
    })
    expect(StyleSheet.flatten(screen.getByTestId('action-button-label-preview-button', { includeHiddenElements: true }).props.style)).toMatchObject({
      width: '100%', backgroundColor: '#24283b', borderColor: '#ABCDEF'
    })
  })

  it('keeps incomplete button colours while mounted, blocks save and previews appearance defaults', () => {
    const screen = renderEditor()
    fireEvent.press(screen.getByRole('button', { name: 'Button appearance: Outline' }))
    fireEvent.changeText(screen.getByLabelText('Button background color custom hex'), '#12')

    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.styles).toEqual({
      size: '1/2', appearance: 'outline', backgroundColor: '#12'
    })
    expect(screen.getByTestId('action-pad-editor-save')).toBeDisabled()
    expect(StyleSheet.flatten(screen.getByLabelText('Button background color custom hex').props.style).borderColor).toBe('#ff7b72')
    expect(StyleSheet.flatten(screen.getByTestId('action-button-label-preview-button', { includeHiddenElements: true }).props.style)).toMatchObject({
      backgroundColor: 'transparent', borderColor: '#353b52'
    })

    fireEvent.changeText(screen.getByLabelText('Button background color custom hex'), '#123456')
    expect(screen.getByTestId('action-pad-editor-save')).toBeEnabled()
    expect(StyleSheet.flatten(screen.getByTestId('action-button-label-preview-button', { includeHiddenElements: true }).props.style).backgroundColor).toBe('#123456')
    fireEvent.press(screen.getByRole('button', { name: 'Button background color: Transparent' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.styles.backgroundColor).toBe('transparent')
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

    const selectedMenu = within(screen.getByRole('button', { name: 'Choose menu' })).getByText(`${childLabel} (child)`)
    const selectedButton = within(screen.getByRole('button', { name: 'Choose button' })).getByText(`${buttonLabel} (back)`)
    fireEvent.press(screen.getByRole('button', { name: 'Choose button' }))
    const buttonOption = within(screen.getByRole('button', { name: `Button: ${buttonLabel} (back)` })).getByText(`${buttonLabel} (back)`)

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

  it('keeps text-only legacy edits as strings and converts to ordered runs for typography controls', async () => {
    const focus = jest.spyOn(TextInput.prototype, 'focus').mockClear()
    const screen = renderEditor()

    fireEvent.press(screen.getByRole('button', { name: 'Run 1 font size: 15' }))
    fireEvent.press(screen.getByRole('button', { name: 'Run 1 weight: Regular' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toBe('Run input')
    expect(screen.props.onChange).not.toHaveBeenCalled()

    fireEvent.changeText(screen.getByLabelText('Button label'), 'Edited legacy')
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toBe('Edited legacy')

    fireEvent.press(screen.getByRole('button', { name: 'Run 1 font size: 18' }))
    fireEvent.press(screen.getByRole('button', { name: 'Run 1 weight: Bold' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toEqual([
      { text: 'Edited legacy', fontSize: 18, bold: true }
    ])

    fireEvent.press(screen.getByRole('button', { name: 'Add run' }))
    await waitFor(() => expect(focus).toHaveBeenCalled())
    expect(screen.getByTestId('action-pad-editor-save')).toBeDisabled()
    expect(StyleSheet.flatten(screen.getByLabelText('Button label run 2').props.style).borderColor).toBe('#ff7b72')
    fireEvent.changeText(screen.getByLabelText('Button label run 2'), ' first')
    expect(screen.getByTestId('action-pad-editor-save')).toBeEnabled()

    fireEvent.press(screen.getByRole('button', { name: 'Move label run 2 earlier' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toEqual([
      { text: ' first', fontSize: 15, bold: false },
      { text: 'Edited legacy', fontSize: 18, bold: true }
    ])
    fireEvent.press(screen.getByRole('button', { name: 'Delete label run 1' }))
    fireEvent.press(screen.getByRole('button', { name: 'Remove label formatting' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toBe('Edited legacy')
    expect(screen.queryByRole('button', { name: 'Remove label formatting' })).toBeNull()
  })

  it('promotes scalar labels for colour, validates custom hex and resets colour independently', () => {
    const screen = renderEditor()
    fireEvent.press(screen.getByRole('button', { name: 'Run 1 font color: Green' }))

    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toEqual([
      { text: 'Run input', fontSize: 15, bold: false, color: '#9ece6a' }
    ])
    expect(StyleSheet.flatten(screen.getByLabelText('Button label').props.style).color).toBe('#9ece6a')
    expect(screen.getByTestId('action-button-label-preview-text', { includeHiddenElements: true }).props.runs[0].color).toBe('#9ece6a')

    fireEvent.changeText(screen.getByLabelText('Run 1 font color custom hex'), '#9e')
    expect(screen.getByTestId('action-pad-editor-save')).toBeDisabled()
    expect(StyleSheet.flatten(screen.getByLabelText('Button label').props.style).color).toBe('#c0caf5')
    expect(screen.getByTestId('action-button-label-preview-text', { includeHiddenElements: true }).props.runs[0].color).toBe('#c0caf5')
    expect(StyleSheet.flatten(screen.getByLabelText('Run 1 font color custom hex').props.style).borderColor).toBe('#ff7b72')

    fireEvent.changeText(screen.getByLabelText('Run 1 font color custom hex'), '#E0AF68')
    expect(screen.getByTestId('action-pad-editor-save')).toBeEnabled()
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toEqual([
      { text: 'Run input', fontSize: 15, bold: false, color: '#E0AF68' }
    ])
    fireEvent.press(screen.getByRole('button', { name: 'Run 1 font color: Default' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toEqual([
      { text: 'Run input', fontSize: 15, bold: false }
    ])
    fireEvent.press(screen.getByRole('button', { name: 'Remove label formatting' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toBe('Run input')
  })

  it('previews the selected button width at normal and compact density with production metrics', () => {
    const screen = renderEditor()
    const stageNode = () => screen.getByTestId('action-button-label-preview', { includeHiddenElements: true })
    const stage = () => StyleSheet.flatten(stageNode().props.style)
    const previewButton = () => StyleSheet.flatten(screen.getByTestId('action-button-label-preview-button', { includeHiddenElements: true }).props.style)
    const previewText = () => StyleSheet.flatten(screen.getByTestId('action-button-label-preview-text', { includeHiddenElements: true }).props.style)

    expect(stage()).toMatchObject({ width: 336, padding: 24, borderLeftWidth: 2 })
    expect(previewButton()).toMatchObject({ width: '48%', height: 52, borderWidth: 1, borderColor: 'transparent' })
    expect(previewText()).toMatchObject({ fontSize: 15, fontFamily: 'CodeyNerdFont-Regular' })
    expect(stageNode().props).toMatchObject({
      accessible: false,
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants'
    })
    expect(screen.getByRole('button', { name: 'Preview density: Normal' }).props.accessibilityState.selected).toBe(true)

    fireEvent.press(screen.getByRole('button', { name: 'Preview density: Compact' }))
    expect(stage().padding).toBe(8)
    expect(previewButton()).toMatchObject({ width: '48%', height: 48 })
    expect(previewText()).toMatchObject({ fontSize: 13, fontFamily: 'CodeyNerdFont-Regular' })
    fireEvent.press(screen.getByRole('button', { name: 'Button size: Quarter' }))
    expect(previewButton().width).toBe('22%')
  })

  it('caps new runs at 64 but still inserts icons into existing runs', () => {
    const original = config()
    const home = original.menus[0]!
    const group = home.groups[0]!
    const draft: ActionPadConfig = {
      ...original,
      menus: [{
        ...home,
        groups: [{
          ...group,
          buttons: group.buttons.map((button, index) => index === 0 ? {
            ...button,
            label: Array.from({ length: 64 }, (_, runIndex) => ({ text: String(runIndex), fontSize: 15 as const, bold: false }))
          } : button)
        }]
      }, original.menus[1]!]
    }
    const screen = renderEditor({ config: draft })

    expect(screen.getByRole('button', { name: 'Add run' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Run 64: Insert Nerd Font icon…' })).toBeEnabled()
    fireEvent.press(screen.getByRole('button', { name: 'Run 64: Insert Nerd Font icon…' }))
    fireEvent.press(screen.getByRole('button', { name: 'Insert mock BMP icon' }))
    expect(screen.queryByTestId('mock-nerd-font-icon-picker')).toBeNull()
    const label = screen.draft().menus[0]?.groups[0]?.buttons[0]?.label
    expect(label).toHaveLength(64)
    expect(label?.[63]).toEqual({ text: `63${mockBmpIcon.glyph}`, fontSize: 15, bold: false })
  })

  it.each([
    { name: 'BMP', action: 'Insert mock BMP icon', icon: mockBmpIcon },
    { name: 'astral', action: 'Insert mock astral icon', icon: mockAstralIcon }
  ])('appends a $name icon to a legacy string and warns without blocking Save', ({ action, icon }) => {
    const screen = renderEditor()
    expect(screen.queryByRole('button', { name: 'Add Nerd Font icon run…' })).toBeNull()
    fireEvent.press(screen.getByRole('button', { name: 'Run 1: Insert Nerd Font icon…' }))
    expect(screen.getByTestId('mock-nerd-font-icon-picker')).toBeTruthy()

    fireEvent.press(screen.getByRole('button', { name: action }))

    expect(screen.queryByTestId('mock-nerd-font-icon-picker')).toBeNull()
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toBe(`Run input${icon.glyph}`)
    expect(screen.getAllByTestId(/^action-button-label-run-/)).toHaveLength(1)
    expect(screen.getByTestId('action-pad-label-accessibility-warning')).toHaveTextContent(/human-readable Accessibility label/)
    expect(screen.getByTestId('action-pad-editor-save')).toBeEnabled()
    fireEvent.changeText(screen.getByLabelText('Accessibility label'), 'Run Neovim input')
    expect(screen.queryByTestId('action-pad-label-accessibility-warning')).toBeNull()
    fireEvent.changeText(screen.getByLabelText('Accessibility label'), '   ')
    expect(screen.getByTestId('action-pad-label-accessibility-warning')).toBeTruthy()
  })

  it('dismisses icon selection without changing the legacy label', () => {
    const screen = renderEditor()
    selectRunText(screen, 1, 2, 5)
    fireEvent.press(screen.getByRole('button', { name: 'Run 1: Insert Nerd Font icon…' }))
    const staleInsert = captureIconInsertion(screen)
    fireEvent.press(screen.getByRole('button', { name: 'Close mock icon picker' }))
    act(() => staleInsert())
    expect(screen.draft()).toEqual(config())
    expect(screen.props.onChange).not.toHaveBeenCalled()
  })

  it('ignores a deleted button’s stale picker callback when its successor takes the same indexes', () => {
    const alert = jest.spyOn(Alert, 'alert')
    const screen = renderEditor()
    selectRunText(screen, 1, 1)
    fireEvent.press(screen.getByRole('button', { name: 'Run 1: Insert Nerd Font icon…' }))
    const staleInsert = captureIconInsertion(screen)
    fireEvent.press(screen.getByRole('button', { name: 'Delete button' }))
    act(() => { alert.mock.calls[0]?.[2]?.find((item) => item.text === 'Delete')?.onPress?.() })
    expect(screen.getByLabelText('Button label').props.value).toBe('Open child')
    expect(screen.queryByTestId('mock-nerd-font-icon-picker')).toBeNull()
    act(() => staleInsert())
    expect(screen.getByLabelText('Button label').props.value).toBe('Open child')

    fireEvent.press(screen.getByRole('button', { name: 'Run 1: Insert Nerd Font icon…' }))
    fireEvent.press(screen.getByRole('button', { name: 'Insert mock BMP icon' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toBe(`Open child${mockBmpIcon.glyph}`)
  })

  it.each([
    { loaded: false, error: null, name: 'Loading Nerd Font icons…' },
    { loaded: false, error: new Error('font failed'), name: 'Nerd Font icons unavailable' }
  ])('disables the icon chooser when the font is not ready ($name)', ({ loaded, error, name }) => {
    mockUseCodeyNerdFontFaces.mockReturnValue([loaded, error])
    const screen = renderEditor()
    expect(screen.getByRole('button', { name: `Run 1: ${name}` })).toBeDisabled()
    if (error) expect(screen.getByText(/icon previews are unavailable/)).toBeTruthy()
    expect(screen.queryByTestId('mock-nerd-font-icon-picker')).toBeNull()
  })

  it('closes the icon picker when work starts or the controlled document is replaced', async () => {
    const initial = props()
    const screen = render(<ActionPadEditor {...initial} />)
    fireEvent.press(screen.getByRole('button', { name: 'Run 1: Insert Nerd Font icon…' }))
    const busyInsert = captureIconInsertion(screen)
    expect(screen.getByTestId('mock-nerd-font-icon-picker')).toBeTruthy()

    screen.rerender(<ActionPadEditor {...initial} busy />)
    expect(screen.queryByTestId('mock-nerd-font-icon-picker')).toBeNull()
    act(() => busyInsert())
    expect(initial.onChange).not.toHaveBeenCalled()

    screen.rerender(<ActionPadEditor {...initial} />)
    selectRunText(screen, 1, 1)
    fireEvent.press(screen.getByRole('button', { name: 'Run 1: Insert Nerd Font icon…' }))
    const staleInsert = captureIconInsertion(screen)
    const replacement = { ...initial.config, menus: initial.config.menus.map((menu, index) => index === 0 ? { ...menu, label: 'Replacement' } : menu) }
    screen.rerender(<ActionPadEditor {...initial} config={replacement} />)
    await waitFor(() => expect(screen.queryByTestId('mock-nerd-font-icon-picker')).toBeNull())
    act(() => staleInsert())
    expect(initial.onChange).not.toHaveBeenCalled()
    fireEvent.press(screen.getByRole('button', { name: 'Run 1: Insert Nerd Font icon…' }))
    fireEvent.press(screen.getByRole('button', { name: 'Insert mock BMP icon' }))
    const changed = (initial.onChange as jest.Mock).mock.calls[0]?.[0] as ActionPadConfig
    expect(changed.menus[0]?.groups[0]?.buttons[0]?.label).toBe(`Run input${mockBmpIcon.glyph}`)
  })

  it.each([true, false])('uses regular/bold in run fields and both previews (fonts loaded: %s)', (loaded) => {
    mockUseCodeyNerdFontFaces.mockReturnValue([loaded, loaded ? null : new Error('font failed')])
    const screen = renderEditor({ config: configWithLabel([
      { text: 'regular content', fontSize: 12, bold: false },
      { text: 'bold content', fontSize: 22, bold: true }
    ]) })
    for (const [field, fontFamily, fontWeight] of [
      ['Button label', 'CodeyNerdFont-Regular', '400'],
      ['Button label run 2', 'CodeyNerdFont-Bold', '700']
    ]) {
      expect(StyleSheet.flatten(screen.getByLabelText(field!).props.style)).toMatchObject({
        fontFamily: loaded ? fontFamily : 'monospace', fontWeight: loaded ? 'normal' : fontWeight
      })
    }
    for (const compact of [false, true]) {
      if (compact) fireEvent.press(screen.getByRole('button', { name: 'Preview density: Compact' }))
      const preview = screen.getByTestId('action-button-label-preview-text', { includeHiddenElements: true })
      expect(preview.props.runs).toEqual([
        {
          text: 'regular content', color: '#c0caf5', fontFamily: loaded ? 'CodeyNerdFont-Regular' : undefined,
          fontWeight: 400, fontSize: compact ? 10 : 12
        },
        {
          text: 'bold content', color: '#c0caf5', fontFamily: loaded ? 'CodeyNerdFont-Bold' : undefined,
          fontWeight: 700, fontSize: compact ? 19 : 22
        }
      ])
      expect(preview.props.defaultFontSize).toBe(compact ? 13 : 15)
      expect(preview.props.defaultFontFamily).toBe(loaded ? 'CodeyNerdFont-Regular' : undefined)
    }
  })

  it.each([true, false])('matches native production inputs and preview dimensions (fonts loaded: %s)', (loaded) => {
    mockUseCodeyNerdFontFaces.mockReturnValue([loaded, loaded ? null : new Error('font failed')])
    const initial = props({ config: configWithLabel([
      { text: `${mockAstralIcon.glyph} `, fontSize: 22, bold: false },
      { text: 'Save all\nfiles', fontSize: 12, bold: true }
    ]) })
    const onInput = jest.fn()
    const onKeyboardPress = jest.fn()
    function Harness({ compact }: { readonly compact: boolean }) {
      const [draft, setDraft] = useState(initial.config)
      return <>
        <ActionPadEditor {...initial} config={draft} onChange={setDraft} />
        <ActionPad compact={compact} enabled onInput={onInput} onKeyboardPress={onKeyboardPress} rootMenu={resolveActionPadConfig(draft)} />
      </>
    }
    const screen = render(<Harness compact={false} />)

    for (const compact of [false, true]) {
      screen.rerender(<Harness compact={compact} />)
      fireEvent.press(screen.getByRole('button', { name: 'Button appearance: Outline' }))
      fireEvent.press(screen.getByRole('button', { name: 'Button background color: Yellow' }))
      fireEvent.changeText(screen.getByLabelText('Button outline color custom hex'), '#123456')
      for (const size of ['Whole', 'Half', 'Third', 'Quarter', 'Fifth']) {
        fireEvent.press(screen.getByRole('button', { name: `Button size: ${size}` }))
        fireEvent.press(screen.getByRole('button', { name: `Preview density: ${compact ? 'Compact' : 'Normal'}` }))
        const preview = screen.getByTestId('action-button-label-preview-text', { includeHiddenElements: true })
        const native = screen.getByTestId('action-pad-input-label', { includeHiddenElements: true })
        for (const prop of ['runs', 'defaultFontSize', 'defaultFontFamily', 'color', 'style']) {
          expect(preview.props[prop]).toEqual(native.props[prop])
        }
        const previewStyle = StyleSheet.flatten(screen.getByTestId('action-button-label-preview-button', { includeHiddenElements: true }).props.style)
        const buttonStyle = StyleSheet.flatten(screen.getByTestId('action-pad-input').props.style)
        for (const prop of ['width', 'height', 'paddingHorizontal', 'borderWidth', 'backgroundColor', 'borderColor']) {
          expect(previewStyle[prop]).toEqual(buttonStyle[prop])
        }
        expect(screen.queryByTestId('action-button-label-preview-text')).toBeNull()
      }
    }
  })

  it.each([
    { text: 'Save', start: 0, end: 0, expected: `${mockAstralIcon.glyph}Save`, cursor: 2 },
    { text: 'Save', start: 2, end: 2, expected: `Sa${mockAstralIcon.glyph}ve`, cursor: 4 },
    { text: 'Save', start: 4, end: 4, expected: `Save${mockAstralIcon.glyph}`, cursor: 6 },
    { text: 'Save all', start: 0, end: 4, expected: `${mockAstralIcon.glyph} all`, cursor: 2 },
    { text: 'A😀B', start: 3, end: 3, expected: `A😀${mockAstralIcon.glyph}B`, cursor: 5 },
    { text: `A${mockAstralIcon.glyph}😀B`, start: 1, end: 3, expected: `A${mockAstralIcon.glyph}😀B`, cursor: 3 }
  ])('inserts into $text at $start–$end and restores focus/caret', async ({ text, start, end, expected, cursor }) => {
    const focus = jest.spyOn(TextInput.prototype, 'focus').mockClear()
    const screen = renderEditor({ config: configWithLabel(text) })
    selectRunText(screen, 1, start, end)
    fireEvent.press(screen.getByRole('button', { name: 'Run 1: Insert Nerd Font icon…' }))
    // Blurring the input for the picker must not change the captured selection.
    selectRunText(screen, 1, text.length)
    fireEvent.press(screen.getByRole('button', { name: 'Insert mock astral icon' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toBe(expected)
    expect(screen.getByLabelText('Button label').props.selection).toEqual({ start: cursor, end: cursor })
    await waitFor(() => expect(focus).toHaveBeenCalled())
    selectRunText(screen, 1, cursor)
    expect(screen.getByLabelText('Button label').props.selection).toBeUndefined()
  })

  it('supports consecutive insertions and then a new native cursor position', () => {
    const screen = renderEditor({ config: configWithLabel('A😀B') })
    selectRunText(screen, 1, 3)
    fireEvent.press(screen.getByRole('button', { name: 'Run 1: Insert Nerd Font icon…' }))
    fireEvent.press(screen.getByRole('button', { name: 'Insert mock astral icon' }))
    selectRunText(screen, 1, 3) // A late event for the pre-insertion text.
    expect(screen.getByLabelText('Button label').props.selection).toEqual({ start: 5, end: 5 })
    fireEvent.press(screen.getByRole('button', { name: 'Run 1: Insert Nerd Font icon…' }))
    fireEvent.press(screen.getByRole('button', { name: 'Insert mock BMP icon' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toBe(`A😀${mockAstralIcon.glyph}${mockBmpIcon.glyph}B`)
    selectRunText(screen, 1, 6) // Acknowledge the restored caret.
    selectRunText(screen, 1, 0)
    fireEvent.press(screen.getByRole('button', { name: 'Run 1: Insert Nerd Font icon…' }))
    fireEvent.press(screen.getByRole('button', { name: 'Insert mock BMP icon' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toBe(`${mockBmpIcon.glyph}A😀${mockAstralIcon.glyph}${mockBmpIcon.glyph}B`)
  })

  it('inserts into a mixed run without changing its size/weight or neighbouring runs', () => {
    const first = { text: 'Save ', fontSize: 12 as const, bold: false }
    const screen = renderEditor({ config: configWithLabel([
      first, { text: 'all files', fontSize: 18, bold: true }
    ]) })
    selectRunText(screen, 2, 3)
    fireEvent.press(screen.getByRole('button', { name: 'Run 2: Insert Nerd Font icon…' }))
    fireEvent.press(screen.getByRole('button', { name: 'Insert mock BMP icon' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toEqual([
      first, { text: `all${mockBmpIcon.glyph} files`, fontSize: 18, bold: true }
    ])
    expect(screen.getAllByTestId(/^action-button-label-run-/)).toHaveLength(2)
    expect(screen.getByLabelText('Button label run 2').props.selection).toEqual({ start: 4, end: 4 })
  })

  it('creates an icon-only run through Add run and permits restyling it', async () => {
    const focus = jest.spyOn(TextInput.prototype, 'focus').mockClear()
    const screen = renderEditor()
    fireEvent.press(screen.getByRole('button', { name: 'Add run' }))
    await waitFor(() => expect(focus).toHaveBeenCalled())
    expect(screen.getByTestId('action-pad-editor-save')).toBeDisabled()
    fireEvent.press(screen.getByRole('button', { name: 'Run 2: Insert Nerd Font icon…' }))
    fireEvent.press(screen.getByRole('button', { name: 'Insert mock astral icon' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toEqual([
      { text: 'Run input', fontSize: 15, bold: false },
      { text: mockAstralIcon.glyph, fontSize: 15, bold: false }
    ])
    expect(screen.getByTestId('action-pad-editor-save')).toBeEnabled()
    fireEvent.press(screen.getByRole('button', { name: 'Run 2 font size: 22' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label?.[1]).toEqual({
      text: mockAstralIcon.glyph, fontSize: 22, bold: false
    })
  })

  it('keeps remembered selections and native input identities with reordered and surviving runs', () => {
    const screen = renderEditor({ config: configWithLabel([
      { text: 'First', fontSize: 15, bold: false },
      { text: 'Second', fontSize: 18, bold: true },
      { text: 'Third', fontSize: 12, bold: false }
    ]) })
    const firstInput = screen.getByLabelText('Button label')
    const secondInput = screen.getByLabelText('Button label run 2')
    selectRunText(screen, 1, 2)
    selectRunText(screen, 2, 3)
    selectRunText(screen, 3, 1)
    fireEvent.press(screen.getByRole('button', { name: 'Move label run 2 earlier' }))
    expect(screen.getByLabelText('Button label')).toBe(secondInput)
    expect(screen.getByLabelText('Button label run 2')).toBe(firstInput)
    fireEvent.press(screen.getByRole('button', { name: 'Run 1: Insert Nerd Font icon…' }))
    fireEvent.press(screen.getByRole('button', { name: 'Insert mock BMP icon' }))
    expect(screen.getByLabelText('Button label').props.value).toBe(`Sec${mockBmpIcon.glyph}ond`)
    fireEvent.press(screen.getByRole('button', { name: 'Delete label run 1' }))
    expect(screen.getByLabelText('Button label')).toBe(firstInput)
    fireEvent.press(screen.getByRole('button', { name: 'Run 1: Insert Nerd Font icon…' }))
    fireEvent.press(screen.getByRole('button', { name: 'Insert mock BMP icon' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toEqual([
      { text: `Fi${mockBmpIcon.glyph}rst`, fontSize: 15, bold: false },
      { text: 'Third', fontSize: 12, bold: false }
    ])
  })

  it.each(['Move label run 2 earlier', 'Delete label run 2', 'Remove label formatting', 'Run 2 weight: Regular'])(
    'cancels a captured insertion after %s, including callbacks arriving during a newer picker', (action) => {
      const screen = renderEditor({ config: configWithLabel([
        { text: 'First', fontSize: 15, bold: false },
        { text: 'Second', fontSize: 18, bold: true }
      ]) })
      selectRunText(screen, 2, 3)
      fireEvent.press(screen.getByRole('button', { name: 'Run 2: Insert Nerd Font icon…' }))
      const staleInsert = captureIconInsertion(screen)
      fireEvent.press(screen.getByRole('button', { name: action }))
      const changedDraft = screen.draft()
      expect(screen.queryByTestId('mock-nerd-font-icon-picker')).toBeNull()
      fireEvent.press(screen.getByRole('button', { name: 'Run 1: Insert Nerd Font icon…' }))
      act(() => staleInsert())
      expect(screen.draft()).toEqual(changedDraft)
      expect(screen.getByTestId('mock-nerd-font-icon-picker')).toBeTruthy()
      fireEvent.press(screen.getByRole('button', { name: 'Close mock icon picker' }))
    }
  )

  it('cancels the picker if fonts become unavailable and rejects its late callback', () => {
    const initial = props()
    const screen = render(<ActionPadEditor {...initial} />)
    fireEvent.press(screen.getByRole('button', { name: 'Run 1: Insert Nerd Font icon…' }))
    const staleInsert = captureIconInsertion(screen)
    mockUseCodeyNerdFontFaces.mockReturnValue([false, new Error('font failed')])
    screen.rerender(<ActionPadEditor {...initial} />)
    expect(screen.queryByTestId('mock-nerd-font-icon-picker')).toBeNull()
    act(() => staleInsert())
    expect(initial.onChange).not.toHaveBeenCalled()
  })

  it('cancels insertion and resets remembered selections when another button is selected', () => {
    const screen = renderEditor()
    selectRunText(screen, 1, 1)
    fireEvent.press(screen.getByRole('button', { name: 'Run 1: Insert Nerd Font icon…' }))
    const staleInsert = captureIconInsertion(screen)
    fireEvent.press(screen.getByRole('button', { name: 'Choose button' }))
    fireEvent.press(screen.getByRole('button', { name: 'Button: Open child (open)' }))
    expect(screen.queryByTestId('mock-nerd-font-icon-picker')).toBeNull()
    act(() => staleInsert())
    expect(screen.props.onChange).not.toHaveBeenCalled()
    fireEvent.press(screen.getByRole('button', { name: 'Run 1: Insert Nerd Font icon…' }))
    fireEvent.press(screen.getByRole('button', { name: 'Insert mock BMP icon' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[1]?.label).toBe(`Open child${mockBmpIcon.glyph}`)
  })

  it('rejects a captured text range when the target run text changes', () => {
    const screen = renderEditor()
    selectRunText(screen, 1, 1, 4)
    fireEvent.press(screen.getByRole('button', { name: 'Run 1: Insert Nerd Font icon…' }))
    const staleInsert = captureIconInsertion(screen)
    fireEvent.changeText(screen.getByLabelText('Button label'), 'New text')
    expect(screen.queryByTestId('mock-nerd-font-icon-picker')).toBeNull()
    act(() => staleInsert())
    expect(screen.getByLabelText('Button label').props.value).toBe('New text')
    expect(screen.props.onChange).toHaveBeenCalledTimes(1)
  })

  it('drops old run selections when formatting is removed', () => {
    const screen = renderEditor({ config: configWithLabel([
      { text: 'First', fontSize: 15, bold: false },
      { text: 'Second', fontSize: 18, bold: true }
    ]) })
    selectRunText(screen, 1, 1)
    fireEvent.press(screen.getByRole('button', { name: 'Remove label formatting' }))
    fireEvent.press(screen.getByRole('button', { name: 'Run 1: Insert Nerd Font icon…' }))
    fireEvent.press(screen.getByRole('button', { name: 'Insert mock BMP icon' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toBe(`FirstSecond${mockBmpIcon.glyph}`)
  })

  it('discards a pending insertion when the editor is closed', () => {
    const screen = renderEditor()
    fireEvent.press(screen.getByRole('button', { name: 'Run 1: Insert Nerd Font icon…' }))
    const staleInsert = captureIconInsertion(screen)
    screen.unmount()
    act(() => staleInsert())
    expect(screen.props.onChange).not.toHaveBeenCalled()
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

  it('creates tap and hold group actions with destination pickers and resets the group when the menu changes', () => {
    const base = config()
    const draft: ActionPadConfig = {
      ...base,
      menus: [...base.menus, {
        id: 'other', label: 'Other', groups: [{
          id: 'choices', buttons: [{ id: 'choice', label: 'Choice', styles: { size: '1/2' }, tap: { type: 'back', after: 'stay' } }]
        }]
      }]
    }
    const screen = renderEditor({ config: draft })

    fireEvent.press(screen.getByRole('button', { name: 'Tap action: Group' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.tap).toEqual({
      type: 'group', menuId: '', groupId: '', after: 'stay'
    })
    expect(screen.getByRole('button', { name: 'Choose tap destination group' })).toBeDisabled()
    fireEvent.press(screen.getByRole('button', { name: 'Choose tap destination menu' }))
    expect(screen.queryByRole('button', { name: 'Tap destination menu: Home (home)' })).toBeNull()
    fireEvent.press(screen.getByRole('button', { name: 'Tap destination menu: Child (child)' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.tap).toEqual({
      type: 'group', menuId: 'child', groupId: '', after: 'stay'
    })
    expect(screen.getByRole('button', { name: 'Choose tap destination group' })).toBeEnabled()
    fireEvent.press(screen.getByRole('button', { name: 'Choose tap destination group' }))
    fireEvent.press(screen.getByRole('button', { name: 'Tap destination group: target' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.tap).toEqual({
      type: 'group', menuId: 'child', groupId: 'target', after: 'stay'
    })

    fireEvent.press(screen.getByRole('button', { name: 'Choose tap destination menu' }))
    fireEvent.press(screen.getByRole('button', { name: 'Tap destination menu: Other (other)' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.tap).toEqual({
      type: 'group', menuId: 'other', groupId: '', after: 'stay'
    })

    fireEvent.press(screen.getByRole('button', { name: 'Hold action: Group' }))
    fireEvent.press(screen.getByRole('button', { name: 'Choose hold destination menu' }))
    fireEvent.press(screen.getByRole('button', { name: 'Hold destination menu: Child (child)' }))
    fireEvent.press(screen.getByRole('button', { name: 'Choose hold destination group' }))
    fireEvent.press(screen.getByRole('button', { name: 'Hold destination group: target' }))
    fireEvent.press(screen.getByRole('button', { name: 'Hold after: Return to root' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.longPress).toEqual({
      type: 'group', menuId: 'child', groupId: 'target', after: 'root'
    })
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

  it('does not apply a stale Delete confirmation after a host document replaces the working copy', () => {
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

  it('cancels or confirms individual deletion, updates every picker, and clamps final-index selection', () => {
    const alert = jest.spyOn(Alert, 'alert')
    const screen = renderEditor({ config: menuManagerConfig(), initialButton: undefined })

    fireEvent.press(screen.getByRole('button', { name: 'Delete Orphan parent (orphan-parent)' }))
    expect(alert).toHaveBeenLastCalledWith(
      'Delete menu?',
      'Delete Orphan parent (orphan-parent) and all its groups and buttons?',
      expect.any(Array)
    )
    expect(screen.draft().menus).toHaveLength(4)
    expect(alert.mock.calls.at(-1)?.[2]?.find((item) => item.text === 'Cancel')).toBeDefined()

    fireEvent.press(screen.getByRole('button', { name: 'Delete Orphan parent (orphan-parent)' }))
    act(() => { alert.mock.calls.at(-1)?.[2]?.find((item) => item.text === 'Delete')?.onPress?.() })
    expect(screen.draft().menus.map((candidate) => candidate.id)).toEqual(['home', 'child', 'orphan-child'])
    expect(screen.queryByText('Open orphan child')).toBeNull()
    expect(within(screen.getByTestId('action-pad-menu-row-2')).getByText('Orphan child (orphan-child)')).toBeTruthy()
    expect(within(screen.getByTestId('action-pad-menu-row-2')).getByText('Unused')).toBeTruthy()
    expect(screen.props.onSave).not.toHaveBeenCalled()

    fireEvent.press(screen.getByRole('button', { name: 'Choose menu' }))
    expect(screen.queryByRole('button', { name: 'Menu: Orphan parent (orphan-parent)' })).toBeNull()
    fireEvent.press(screen.getByRole('button', { name: 'Choose menu' }))

    fireEvent.press(screen.getByRole('button', { name: 'Edit Home (home)' }))
    fireEvent.press(screen.getByRole('button', { name: 'Button settings' }))
    fireEvent.press(screen.getByRole('button', { name: 'Choose tap menu' }))
    expect(screen.queryByRole('button', { name: 'Tap menu: Orphan parent (orphan-parent)' })).toBeNull()
    fireEvent.press(screen.getByRole('button', { name: 'Choose tap menu' }))
    fireEvent.press(screen.getByRole('button', { name: 'Choose hold destination menu' }))
    expect(screen.queryByRole('button', { name: 'Hold destination menu: Orphan parent (orphan-parent)' })).toBeNull()
    fireEvent.press(screen.getByRole('button', { name: 'Choose hold destination menu' }))
    fireEvent.press(screen.getByRole('button', { name: 'Choose destination group' }))
    expect(screen.queryByRole('button', { name: 'Destination group: Orphan parent (orphan-parent) / tools' })).toBeNull()
    fireEvent.press(screen.getByRole('button', { name: 'Choose destination group' }))

    fireEvent.press(screen.getByRole('button', { name: 'Manage menus' }))
    fireEvent.press(screen.getByRole('button', { name: 'Delete Orphan child (orphan-child)' }))
    act(() => { alert.mock.calls.at(-1)?.[2]?.find((item) => item.text === 'Delete')?.onPress?.() })
    expect(screen.draft().menus.map((candidate) => candidate.id)).toEqual(['home', 'child'])
    expect(within(screen.getByRole('button', { name: 'Choose menu' })).getByText('Child (child)')).toBeTruthy()
  })

  it('clamps Menu settings selection when repairing a root-missing working copy by deleting its only menu', () => {
    const alert = jest.spyOn(Alert, 'alert')
    const screen = renderEditor({
      config: { version: 1, rootMenuId: 'missing', menus: [{ id: 'only', label: 'Only', groups: [] }] },
      initialButton: undefined
    })

    fireEvent.press(screen.getByRole('button', { name: 'Edit Only (only)' }))
    fireEvent.press(screen.getByRole('button', { name: 'Delete menu' }))
    act(() => { alert.mock.calls.at(-1)?.[2]?.find((item) => item.text === 'Delete')?.onPress?.() })
    expect(screen.draft().menus).toEqual([])
    expect(within(screen.getByRole('button', { name: 'Choose menu' })).getByText('No menus')).toBeTruthy()
    expect(screen.getByText('Add a menu to start building your Action Pad.')).toBeTruthy()
  })

  it('summarizes, cancels and atomically removes an internally linked unused subtree', () => {
    const original = menuManagerConfig()
    const screen = renderEditor({ config: original, initialButton: undefined })

    fireEvent.press(screen.getByTestId('action-pad-remove-unused-menus'))
    const confirmation = within(screen.getByTestId('action-pad-cleanup-confirmation'))
    expect(confirmation.getByText('Orphan parent (orphan-parent)')).toBeTruthy()
    expect(confirmation.getByText('Orphan child (orphan-child)')).toBeTruthy()
    expect(confirmation.getByText('Total: 2 menus, 2 groups, and 2 buttons.')).toBeTruthy()
    fireEvent.press(confirmation.getByRole('button', { name: 'Keep menus' }))
    expect(screen.queryByTestId('action-pad-cleanup-confirmation')).toBeNull()
    expect(screen.draft()).toEqual(original)

    fireEvent.press(screen.getByTestId('action-pad-remove-unused-menus'))
    fireEvent.press(screen.getByTestId('action-pad-confirm-remove-unused-menus'))
    expect(screen.draft().menus).toEqual(original.menus.slice(0, 2))
    expect(screen.draft().rootMenuId).toBe('home')
    expect(screen.queryByTestId('action-pad-menu-row-2')).toBeNull()
    expect(screen.getByTestId('action-pad-remove-unused-menus')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'No unused menus' })).toBeTruthy()
  })

  it.each([
    { name: 'a semantic error', overrides: { config: { ...menuManagerConfig(), rootMenuId: 'missing' } } },
    { name: 'host work', overrides: { config: menuManagerConfig(), busy: true } }
  ])('disables unused-menu cleanup during $name', ({ overrides }) => {
    const screen = renderEditor({ ...overrides, initialButton: undefined })
    expect(screen.getByTestId('action-pad-remove-unused-menus')).toBeDisabled()
    fireEvent.press(screen.getByTestId('action-pad-remove-unused-menus'))
    expect(screen.queryByTestId('action-pad-cleanup-confirmation')).toBeNull()
  })

  it('disables unused-menu cleanup during a local pending ID edit', () => {
    const screen = renderEditor({ config: menuManagerConfig(), initialButton: undefined })
    fireEvent.press(screen.getByRole('button', { name: 'Menu settings' }))
    fireEvent.changeText(screen.getByLabelText('Menu ID'), 'child')
    fireEvent.press(screen.getByRole('button', { name: 'Manage menus' }))
    expect(screen.getByTestId('action-pad-remove-unused-menus')).toBeDisabled()
    fireEvent.press(screen.getByTestId('action-pad-remove-unused-menus'))
    expect(screen.queryByTestId('action-pad-cleanup-confirmation')).toBeNull()
  })

  it('creates menus and groups, updates root IDs and protects linked menus', () => {
    const screen = renderEditor()
    fireEvent.press(screen.getByRole('button', { name: 'Menu settings' }))
    fireEvent.changeText(screen.getByLabelText('Menu ID'), 'start')
    expect(screen.draft().rootMenuId).toBe('start')
    expect(screen.getByRole('button', { name: 'Delete menu' })).toBeDisabled()
    fireEvent.press(screen.getByRole('button', { name: 'Choose menu' }))
    fireEvent.press(screen.getByRole('button', { name: 'Menu: Child (child)' }))
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

  it('propagates destination IDs and protects a group linked from another menu', () => {
    const base = config()
    const home = base.menus[0]!
    const linked: ActionPadConfig = {
      ...base,
      menus: [{
        ...home,
        groups: [{
          ...home.groups[0]!,
          buttons: home.groups[0]!.buttons.map((button, index) => index === 0 ? ({
            ...button,
            tap: { type: 'group', menuId: 'child', groupId: 'target', after: 'stay' }
          }) : button)
        }]
      }, base.menus[1]!]
    }
    const screen = renderEditor({
      config: linked,
      initialButton: { menuId: 'child', groupId: 'target', buttonId: 'back' }
    })

    fireEvent.press(screen.getByRole('button', { name: 'Group settings' }))
    expect(screen.getByRole('button', { name: 'Delete group' })).toBeDisabled()
    expect(screen.getByText('Remove group links from Home before deleting this group.')).toBeTruthy()
    fireEvent.changeText(screen.getByLabelText('Group ID'), 'options')
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.tap).toMatchObject({
      type: 'group', menuId: 'child', groupId: 'options'
    })

    fireEvent.press(screen.getByRole('button', { name: 'Menu settings' }))
    fireEvent.changeText(screen.getByLabelText('Menu ID'), 'tools')
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.tap).toMatchObject({
      type: 'group', menuId: 'tools', groupId: 'options'
    })
  })

  it('moves buttons to a group in another menu and keeps the moved button selected', () => {
    const screen = renderEditor()
    fireEvent.press(screen.getByRole('button', { name: 'Choose destination group' }))
    fireEvent.press(screen.getByRole('button', { name: 'Destination group: Child (child) / target' }))
    fireEvent.press(screen.getByRole('button', { name: 'Move to group' }))
    expect(screen.draft().menus[0]?.groups[0]?.buttons.map((button) => button.id)).toEqual(['open', 'keyboard'])
    expect(screen.draft().menus[1]?.groups[0]?.buttons.map((button) => button.id)).toEqual(['back', 'input'])
    expect(screen.getByLabelText('Button ID').props.value).toBe('input')
  })

  it('shows field errors and gates Save while a field is incomplete', () => {
    const screen = renderEditor()
    fireEvent.changeText(screen.getByLabelText('Button label'), '')
    expect(screen.getByTestId('action-pad-editor-save')).toBeDisabled()
    expect(screen.getAllByText('Must not be empty.').length).toBeGreaterThan(0)
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toBe('')
    expect(StyleSheet.flatten(screen.getByLabelText('Button label').props.style).borderColor).toBe('#ff7b72')
    fireEvent.changeText(screen.getByLabelText('Button label'), 'Updated')
    expect(screen.draft().menus[0]?.groups[0]?.buttons[0]?.label).toBe('Updated')
    expect(screen.getByTestId('action-pad-editor-save')).toBeEnabled()

    fireEvent.changeText(screen.getByLabelText('Button ID'), 'open')
    expect(screen.getByLabelText('Button ID').props.value).toBe('open')
    expect(screen.getAllByText('A button with ID “open” already exists in this group.').length).toBeGreaterThan(0)
    expect(screen.getByTestId('action-pad-editor-save')).toBeDisabled()
    fireEvent.changeText(screen.getByLabelText('Button ID'), 'unique')
    expect(screen.getByTestId('action-pad-editor-save')).toBeEnabled()
  })

  it('buffers colliding ID prefixes without rewriting another menu’s references', () => {
    const onPendingEditsChange = jest.fn()
    const screen = renderEditor({ onPendingEditsChange })
    fireEvent.press(screen.getByRole('button', { name: 'Menu settings' }))
    fireEvent.changeText(screen.getByLabelText('Menu ID'), '')
    fireEvent.changeText(screen.getByLabelText('Menu ID'), 'chil')
    fireEvent.changeText(screen.getByLabelText('Menu ID'), 'child')
    expect(screen.getByLabelText('Menu ID').props.value).toBe('child')
    expect(screen.draft().rootMenuId).toBe('chil')
    expect(screen.draft().menus[1]?.id).toBe('child')
    expect(screen.getByTestId('action-pad-editor-save')).toBeDisabled()
    expect(onPendingEditsChange).toHaveBeenLastCalledWith({ fieldEdits: true })
    fireEvent.changeText(screen.getByLabelText('Menu ID'), 'child-new')
    expect(screen.draft().rootMenuId).toBe('child-new')
    expect(screen.draft().menus[0]?.groups[0]?.buttons[1]?.tap).toMatchObject({ menuId: 'child' })
    expect(screen.getByTestId('action-pad-editor-save')).toBeEnabled()
    expect(onPendingEditsChange).toHaveBeenLastCalledWith({ fieldEdits: false })
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
    fireEvent.press(screen.getByRole('button', { name: 'Menu: Child (child)' }))
    fireEvent.press(screen.getByRole('button', { name: 'Menu settings' }))
    fireEvent.changeText(screen.getByLabelText('Menu ID'), 'home')
    expect(screen.getByTestId('action-pad-editor-save')).toBeDisabled()
    const replacement: ActionPadConfig = {
      version: 1, rootMenuId: 'new-root', menus: [
        { id: 'other', label: 'Other', groups: [] },
        { id: 'new-root', label: 'Loaded root', groups: [{ id: 'loaded-group', buttons: [{ id: 'loaded-button', label: 'Loaded button', styles: { size: '1/2' }, tap: { type: 'back', after: 'stay' } }] }] }
      ]
    }
    screen.rerender(<ActionPadEditor {...initial} config={replacement} />)
    expect(screen.getByLabelText('Button label').props.value).toBe('Loaded button')
    expect(within(screen.getByRole('button', { name: 'Choose menu' })).getByText('Loaded root (new-root) · Root')).toBeTruthy()
    expect(screen.getByTestId('action-pad-editor-save')).toBeEnabled()
    expect(screen.queryByText('A menu with ID “home” already exists. Choose a unique ID.')).toBeNull()
  })

  it('keeps incomplete ID text only while the editor remains mounted', () => {
    const onPendingEditsChange = jest.fn()
    const screen = renderEditor({ onPendingEditsChange })
    fireEvent.changeText(screen.getByLabelText('Button ID'), 'open')
    expect(screen.getByLabelText('Button ID').props.value).toBe('open')
    expect(screen.getByTestId('action-pad-editor-save')).toBeDisabled()
    expect(screen.getByText('Unsaved changes · Neovim running')).toBeTruthy()
    expect(onPendingEditsChange).toHaveBeenLastCalledWith({ fieldEdits: true })
    screen.unmount()
    expect(onPendingEditsChange).toHaveBeenLastCalledWith({ fieldEdits: false })
  })

  it('serializes file requests while waiting for the parent’s confirmation', async () => {
    let finishLoad!: () => void
    const onLoad = jest.fn(() => new Promise<void>((resolve) => { finishLoad = resolve }))
    const screen = renderEditor({ onLoad })
    fireEvent.press(screen.getByRole('button', { name: 'Reload' }))
    fireEvent.press(screen.getByRole('button', { name: 'Reload' }))
    expect(onLoad).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Button label').props.editable).toBe(false)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await act(async () => { finishLoad() })
    expect(screen.getByLabelText('Button label').props.editable).toBe(true)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('invokes fixed-file load and save callbacks without activating or saving implicitly', async () => {
    const screen = renderEditor({ dirty: true })
    expect(screen.getByText('Unsaved changes · Neovim running')).toBeTruthy()
    expect(screen.getByText(`Local file: ${screen.props.sourcePath}`)).toBeTruthy()
    fireEvent.press(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(screen.props.onLoad).toHaveBeenCalledWith())
    fireEvent.press(screen.getByTestId('action-pad-editor-save'))
    await waitFor(() => expect(screen.props.onSave).toHaveBeenCalledWith())
    expect(screen.queryByRole('button', { name: 'Export copy…' })).toBeNull()
    expect(screen.props.onChange).not.toHaveBeenCalled()
    expect(screen.getByText('Unsaved changes · Neovim running')).toBeTruthy()
    fireEvent.press(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.props.onCancel).toHaveBeenCalledTimes(1)
  })

  it('shows the fixed local destination without a path editor', async () => {
    const path = '/storage/emulated/0/Codey/action-pad.yaml'
    const screen = renderEditor({ sourcePath: path, dirty: true })

    expect(screen.getByText(`Local file: ${path}`)).toBeTruthy()
    fireEvent.press(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(screen.props.onLoad).toHaveBeenCalledWith())
    fireEvent.press(screen.getByTestId('action-pad-editor-save'))

    await waitFor(() => expect(screen.props.onSave).toHaveBeenCalledWith())
  })

  it('keeps Save disabled while a clean editor is waiting for its first load', () => {
    const clean = renderEditor({ initialLoadPending: true })
    expect(clean.getByTestId('action-pad-editor-save')).toBeDisabled()
    clean.unmount()

    const dirty = renderEditor({ dirty: true, initialLoadPending: true })
    expect(dirty.getByTestId('action-pad-editor-save')).toBeEnabled()
    dirty.unmount()
  })

  it('allows offline edits but blocks file operations, and disables editing while busy', () => {
    const screen = renderEditor({ connected: false })
    expect(screen.getByText('No unsaved changes · Neovim stopped')).toBeTruthy()
    fireEvent.press(screen.getByTestId('action-pad-editor-save'))
    fireEvent.press(screen.getByRole('button', { name: 'Reload' }))
    fireEvent.changeText(screen.getByLabelText('Button label'), 'Offline change')
    expect(screen.props.onChange).toHaveBeenCalledTimes(1)
    expect(screen.props.onSave).not.toHaveBeenCalled()
    expect(screen.props.onLoad).not.toHaveBeenCalled()
    screen.unmount()

    const busy = renderEditor({ busy: true })
    expect(busy.getByTestId('action-pad-editor-save')).toBeDisabled()
    expect(busy.getByLabelText('Button label').props.editable).toBe(false)
    expect(busy.getByRole('button', { name: 'Run 1 font size: 22' })).toBeDisabled()
    expect(busy.getByRole('button', { name: 'Run 1 weight: Bold' })).toBeDisabled()
    expect(busy.getByRole('button', { name: 'Add run' })).toBeDisabled()
    expect(busy.getByRole('button', { name: 'Preview density: Compact' })).toBeDisabled()
    expect(busy.getByRole('button', { name: 'Run 1: Insert Nerd Font icon…' })).toBeDisabled()
    expect(busy.getByRole('button', { name: 'Add button' })).toBeDisabled()
    expect(busy.getByRole('button', { name: 'Duplicate button' })).toBeDisabled()
    expect(busy.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('retains in-memory edits when a local file callback fails and shows the actionable error', async () => {
    const screen = renderEditor({ onSave: jest.fn().mockRejectedValue(new Error('Permission denied. Reload, retry, or restore your backup.')) })
    fireEvent.changeText(screen.getByLabelText('Button label'), 'Keep this edit')
    fireEvent.press(screen.getByTestId('action-pad-editor-save'))
    await waitFor(() => expect(screen.getByText('Permission denied. Reload, retry, or restore your backup.')).toBeTruthy())
    expect(screen.getByLabelText('Button label').props.value).toBe('Keep this edit')
  })

  it('shows an accessible slow-operation card and exposes explicit stop waiting', () => {
    const onStopWaiting = jest.fn()
    const operation: ActionPadOperation = {
      id: 7,
      kind: 'save',
      phase: 'writing',
      startedAtMs: Date.now() - 16_000,
      path: '/host/action-pad.yaml',
      byteCount: 431,
      slow: true,
      writeStarted: true
    }
    const screen = renderEditor({ busy: true, operation, onStopWaiting })

    const progress = screen.getByRole('progressbar')
    expect(progress.props.accessibilityLiveRegion).toBe('polite')
    expect(screen.getByText('Taking longer than expected. The Neovim request is still pending.')).toBeTruthy()
    expect(screen.getByTestId('action-pad-editor-save')).toBeDisabled()
    fireEvent.press(screen.getByRole('button', { name: 'Stop waiting and stop Neovim' }))
    expect(onStopWaiting).toHaveBeenCalledTimes(1)
  })

  it('renders severity-aware notices with collapsed technical details', () => {
    const notice: ActionPadNotice = {
      severity: 'error',
      summary: 'The local write failed.',
      recommendedAction: 'Reload, retry, or restore your backup.',
      details: {
        operation: 'save',
        phase: 'writing',
        durationMs: 15_200,
        path: '/storage/emulated/0/Codey/action-pad.yaml',
        byteCount: 431,
        hostErrorCode: 'io',
        nativeCode: 'E_NVIM_EXIT',
        nativeMessage: 'process exited'
      }
    }
    const screen = renderEditor({ notice })

    const alert = screen.getByRole('alert')
    expect(alert.props.accessibilityLiveRegion).toBe('assertive')
    expect(screen.queryByTestId('action-pad-technical-details')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reconnect & check save' })).toBeNull()
    fireEvent.press(screen.getByRole('button', { name: 'Show technical details' }))
    expect(screen.getByText('Native process code: E_NVIM_EXIT')).toBeTruthy()
    expect(screen.getByText('Native process message: process exited')).toBeTruthy()
    expect(screen.getByText('Serialized bytes: 431')).toBeTruthy()
  })

  it('shows the controller connection failure inside the full-screen editor', () => {
    const screen = renderEditor({
      connectionFailure: {
        code: 'E_NVIM_EXIT',
        nativeCode: 'E_NVIM_EXIT',
        message: 'process exited',
        nativeMessage: 'exit code 1'
      }
    })
    expect(screen.getByText('Local Neovim failed: process exited')).toBeTruthy()
    fireEvent.press(screen.getByRole('button', { name: 'Show technical details' }))
    expect(screen.getByText('Native process code: E_NVIM_EXIT')).toBeTruthy()
    expect(screen.getByText('Native process message: exit code 1')).toBeTruthy()
  })

  it('adapts across supported landscape widths without losing selected fields and keeps controls at least 48dp', () => {
    const previousWindow = Dimensions.get('window')
    const previousScreen = Dimensions.get('screen')
    act(() => { Dimensions.set({ window: { width: 800, height: 600, scale: 1, fontScale: 1 }, screen: { width: 800, height: 600, scale: 1, fontScale: 1 } }) })
    const screen = renderEditor()
    fireEvent.changeText(screen.getByLabelText('Button label'), 'Landscape resize draft')
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-editor-workspace').props.style).flexDirection).toBeUndefined()
    act(() => { Dimensions.set({ window: { width: 1280, height: 800, scale: 1, fontScale: 1 }, screen: { width: 1280, height: 800, scale: 1, fontScale: 1 } }) })
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-editor-workspace').props.style).flexDirection).toBe('row')
    expect(screen.getByLabelText('Button label').props.value).toBe('Landscape resize draft')
    for (const name of ['Save', 'Add menu', 'Add group', 'Add button', 'Duplicate button', 'Choose menu', 'Choose group', 'Choose button']) {
      const style = StyleSheet.flatten(screen.getByRole('button', { name }).props.style)
      expect(style.minHeight).toBeGreaterThanOrEqual(48)
    }
    act(() => { Dimensions.set({ window: previousWindow, screen: previousScreen }) })
  })
})
