import { StyleSheet } from 'react-native'
import { cleanup, fireEvent, render, within } from '@testing-library/react-native'

import {
  ACTION_PAD_LONG_PRESS_MS,
  ACTION_PAD_MENU,
  ActionPad,
  type ActionMenu,
  type ActionPadProps
} from '..'

afterEach(cleanup)

function actionPadProps(overrides: Partial<ActionPadProps> = {}): ActionPadProps {
  return {
    enabled: true,
    mode: 'NORMAL',
    dimensions: '100 × 20 · 1280 × 800dp',
    onInput: jest.fn(),
    onKeyboardPress: jest.fn(),
    ...overrides
  }
}

function input(nvimInput: string, after: 'root' | 'stay' = 'stay') {
  return { type: 'input' as const, nvimInput, after }
}

describe('ActionPad', () => {
  it('defaults to the roomy below-terminal presentation', () => {
    const screen = render(<ActionPad {...actionPadProps()} />)

    const panelStyle = StyleSheet.flatten(
      screen.getByTestId('action-pad').props.style
    )
    expect(panelStyle.minHeight).toBe(213)
    expect(panelStyle.borderTopWidth).toBe(2)
    expect(panelStyle.width).toBeUndefined()
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-groups').props.style)).toMatchObject({
      height: 116,
      flexDirection: 'row'
    })
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-leading-row-1').props.style)).toMatchObject({
      height: 52,
      flexDirection: 'row'
    })
    expect(screen.getByTestId('action-pad-leading-group')).toBeTruthy()
    expect(screen.getByTestId('action-pad-trailing-group')).toBeTruthy()
  })

  it('keeps two 48dp touch rows in each group in its keyboard-compact layout', () => {
    const screen = render(<ActionPad {...actionPadProps({ compact: true })} />)

    expect(StyleSheet.flatten(screen.getByTestId('action-pad').props.style).minHeight).toBe(144)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-groups').props.style).height).toBe(102)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-leading-row-1').props.style).height).toBe(48)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-leading-row-2').props.style).height).toBe(48)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-trailing-row-1').props.style).height).toBe(48)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-trailing-row-2').props.style).height).toBe(48)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-escape').props.style)).toMatchObject({
      minWidth: 48,
      height: 48
    })
  })

  it('keeps configured group membership while changing the group grid by placement', () => {
    const portrait = render(<ActionPad {...actionPadProps()} />)

    expect(within(portrait.getByTestId('action-pad-leading-row-1')).getByTestId(
      'action-pad-escape'
    )).toBeTruthy()
    expect(within(portrait.getByTestId('action-pad-leading-row-2')).getByTestId(
      'action-pad-backspace'
    )).toBeTruthy()
    expect(within(portrait.getByTestId('action-pad-trailing-row-1')).getByTestId(
      'action-pad-down'
    )).toBeTruthy()
    expect(within(portrait.getByTestId('action-pad-trailing-row-2')).getByTestId(
      'action-pad-leader'
    )).toBeTruthy()
    portrait.unmount()

    const landscape = render(<ActionPad {...actionPadProps({ placement: 'right' })} />)
    expect(within(landscape.getByTestId('action-pad-leading-group')).getByTestId(
      'action-pad-escape'
    )).toBeTruthy()
    expect(within(landscape.getByTestId('action-pad-trailing-group')).getByTestId(
      'action-pad-command'
    )).toBeTruthy()
  })

  it('uses scrollable ordered groups with two columns for right placement', () => {
    const screen = render(
      <ActionPad {...actionPadProps({ placement: 'right' })} />
    )

    expect(StyleSheet.flatten(screen.getByTestId('action-pad').props.style)).toMatchObject({
      flex: 1,
      minHeight: 0,
      borderTopWidth: 0,
      borderLeftWidth: 2
    })
    const scroll = screen.getByTestId('action-pad-flow-scroll')
    expect(StyleSheet.flatten(scroll.props.contentContainerStyle)).toMatchObject({
      flexGrow: 1,
      justifyContent: 'space-between'
    })
    expect(screen.queryByTestId('action-pad-leading-row-1')).toBeNull()
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-leading-group').props.style)).toMatchObject({
      width: '100%',
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      alignContent: 'flex-start',
      rowGap: 12
    })
    expect(screen.getByTestId('action-pad-trailing-group')).toBeTruthy()
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-escape').props.style)).toMatchObject({
      minWidth: 48,
      width: '48%',
      height: 52,
      flex: 0,
      borderRadius: 12
    })
    expect(screen.getAllByRole('button').map((button) => button.props.testID)).toEqual([
      'action-pad-escape',
      'action-pad-tab',
      'action-pad-enter',
      'action-pad-backspace',
      'action-pad-left',
      'action-pad-down',
      'action-pad-up',
      'action-pad-right',
      'action-pad-leader',
      'action-pad-command',
      'action-pad-keyboard'
    ])
  })

  it('keeps the right flow scrollable with 48dp controls when compact', () => {
    const screen = render(
      <ActionPad {...actionPadProps({ compact: true, placement: 'right' })} />
    )

    expect(screen.getByTestId('action-pad-flow-scroll')).toBeTruthy()
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-flow-scroll').props.contentContainerStyle).gap).toBe(6)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-leading-group').props.style).rowGap).toBe(6)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-escape').props.style)).toMatchObject({
      minWidth: 48,
      width: '48%',
      height: 48,
      flex: 0,
      borderRadius: 8
    })
  })

  it('renders any number of named groups in declaration order in both placements', () => {
    const rootMenu = {
      label: 'Home',
      groups: [
        {
          id: 'first',
          buttons: [{ id: 'one', label: 'One', tap: input('1') }]
        },
        {
          id: 'middle',
          buttons: [{ id: 'two', label: 'Two', tap: input('2') }]
        },
        {
          id: 'last',
          buttons: [{ id: 'three', label: 'Three', tap: input('3') }]
        }
      ]
    } satisfies ActionMenu
    const expectedGroups = [
      'action-pad-first-group',
      'action-pad-middle-group',
      'action-pad-last-group'
    ]
    const groupPattern = /^action-pad-(?:first|middle|last)-group$/

    const below = render(<ActionPad {...actionPadProps({ rootMenu })} />)
    expect(below.getAllByTestId(groupPattern).map((group) => group.props.testID)).toEqual(
      expectedGroups
    )
    expect(within(below.getByTestId('action-pad-middle-group')).getByTestId(
      'action-pad-two'
    )).toBeTruthy()
    below.unmount()

    const right = render(
      <ActionPad {...actionPadProps({ placement: 'right', rootMenu })} />
    )
    expect(right.getAllByTestId(groupPattern).map((group) => group.props.testID)).toEqual(
      expectedGroups
    )
    expect(right.getAllByRole('button').map((button) => button.props.testID)).toEqual([
      'action-pad-one',
      'action-pad-two',
      'action-pad-three'
    ])
  })

  it('renders Back only where configured, in its declared position, and pops one menu', () => {
    const childMenu = {
      label: 'Child',
      groups: [
        {
          id: 'child-actions',
          buttons: [
            { id: 'before', label: 'Before', tap: input('b') },
            {
              id: 'back',
              label: 'Back',
              tap: { type: 'back' as const, after: 'stay' as const }
            },
            { id: 'after', label: 'After', tap: input('a') }
          ]
        }
      ]
    } satisfies ActionMenu
    const rootMenu = {
      label: 'Home',
      groups: [
        {
          id: 'root-actions',
          buttons: [
            {
              id: 'open',
              label: 'Open',
              tap: { type: 'menu' as const, menu: childMenu, after: 'stay' as const }
            }
          ]
        }
      ]
    } satisfies ActionMenu
    const screen = render(<ActionPad {...actionPadProps({ rootMenu })} />)

    expect(screen.queryByTestId('action-pad-back')).toBeNull()
    fireEvent.press(screen.getByTestId('action-pad-open'))

    expect(
      within(screen.getByTestId('action-pad-child-actions-group'))
        .getAllByRole('button')
        .map((button) => button.props.testID)
    ).toEqual(['action-pad-before', 'action-pad-back', 'action-pad-after'])

    fireEvent.press(screen.getByTestId('action-pad-back'))
    expect(screen.getByTestId('action-pad-open')).toBeTruthy()
    expect(screen.queryByTestId('action-pad-back')).toBeNull()
  })

  it('lets tap and long press independently select any interaction and suppresses release after hold', () => {
    const onInput = jest.fn()
    const childMenu = {
      label: 'Tap Destination',
      groups: [
        {
          id: 'child',
          buttons: [
            {
              id: 'back',
              label: 'Back',
              tap: { type: 'back' as const, after: 'stay' as const }
            }
          ]
        }
      ]
    } satisfies ActionMenu
    const rootMenu = {
      label: 'Home',
      groups: [
        {
          id: 'gestures',
          buttons: [
            {
              id: 'gesture',
              label: 'Gesture',
              tap: { type: 'menu' as const, menu: childMenu, after: 'stay' as const },
              longPress: input('<C-x>')
            }
          ]
        }
      ]
    } satisfies ActionMenu
    const screen = render(<ActionPad {...actionPadProps({ onInput, rootMenu })} />)
    const gesture = screen.getByTestId('action-pad-gesture')

    fireEvent.press(gesture)
    expect(screen.getByLabelText('Current action path: Tap Destination')).toBeTruthy()
    expect(onInput).not.toHaveBeenCalled()

    fireEvent.press(screen.getByTestId('action-pad-back'))
    const rootGesture = screen.getByTestId('action-pad-gesture')
    expect(ACTION_PAD_LONG_PRESS_MS).toBe(450)
    fireEvent(rootGesture, 'pressIn')
    fireEvent(rootGesture, 'longPress')
    fireEvent.press(rootGesture)

    expect(onInput).toHaveBeenCalledTimes(1)
    expect(onInput).toHaveBeenCalledWith('<C-x>')
    expect(screen.queryByLabelText('Current action path: Tap Destination')).toBeNull()
  })

  it('supports a long-press-only button with a configuration-provided hint', () => {
    const onInput = jest.fn()
    const rootMenu = {
      label: 'Home',
      groups: [
        {
          id: 'actions',
          buttons: [
            {
              id: 'hold-only',
              label: 'Hold',
              accessibilityHint: 'Hold to send the mapping.',
              longPress: input('held')
            }
          ]
        }
      ]
    } satisfies ActionMenu
    const screen = render(<ActionPad {...actionPadProps({ onInput, rootMenu })} />)
    const button = screen.getByTestId('action-pad-hold-only')

    expect(button.props.onPress).toBeUndefined()
    expect(ACTION_PAD_LONG_PRESS_MS).toBe(450)
    expect(button.props.accessibilityHint).toBe('Hold to send the mapping.')
    fireEvent(button, 'longPress')

    expect(onInput).toHaveBeenCalledWith('held')
  })

  it('applies root or stay after each button interaction instead of inheriting it from a menu', () => {
    const onInput = jest.fn()
    const childMenu = {
      label: 'Child',
      groups: [
        {
          id: 'actions',
          buttons: [
            { id: 'stay', label: 'Stay', tap: input('s', 'stay') },
            { id: 'root', label: 'Root', tap: input('r', 'root') }
          ]
        }
      ]
    } satisfies ActionMenu
    const rootMenu = {
      label: 'Home',
      groups: [
        {
          id: 'root',
          buttons: [
            {
              id: 'open',
              label: 'Open',
              tap: { type: 'menu' as const, menu: childMenu, after: 'stay' as const }
            }
          ]
        }
      ]
    } satisfies ActionMenu
    const screen = render(<ActionPad {...actionPadProps({ onInput, rootMenu })} />)

    fireEvent.press(screen.getByTestId('action-pad-open'))
    fireEvent.press(screen.getByTestId('action-pad-stay'))
    expect(onInput).toHaveBeenLastCalledWith('s')
    expect(screen.getByLabelText('Current action path: Child')).toBeTruthy()

    fireEvent.press(screen.getByTestId('action-pad-root'))
    expect(onInput).toHaveBeenLastCalledWith('r')
    expect(screen.queryByLabelText('Current action path: Child')).toBeNull()
    expect(screen.getByTestId('action-pad-open')).toBeTruthy()
  })

  it('renders disabled actions without dispatching input', () => {
    const props = actionPadProps({ enabled: false })
    const screen = render(<ActionPad {...props} />)
    const escape = screen.getByTestId('action-pad-escape')

    expect(escape.props.accessibilityState).toMatchObject({ disabled: true })
    fireEvent.press(escape)

    expect(props.onInput).not.toHaveBeenCalled()
  })

  it('shows breadcrumbs and follows explicitly configured Back interactions', () => {
    const screen = render(<ActionPad {...actionPadProps()} />)

    fireEvent.press(screen.getByTestId('action-pad-leader'))
    expect(screen.getByLabelText('Current action path: Leader')).toBeTruthy()
    expect(screen.queryByTestId('action-pad-escape')).toBeNull()
    expect(screen.getByTestId('action-pad-back')).toBeTruthy()

    fireEvent.press(screen.getByTestId('action-pad-search'))
    expect(screen.getByLabelText('Current action path: Leader / Search')).toBeTruthy()
    expect(screen.getByTestId('action-pad-grep')).toBeTruthy()

    fireEvent.press(screen.getByTestId('action-pad-back'))
    expect(screen.getByLabelText('Current action path: Leader')).toBeTruthy()
    expect(screen.getByTestId('action-pad-search')).toBeTruthy()

    fireEvent.press(screen.getByTestId('action-pad-back'))
    expect(screen.queryByTestId('action-pad-back')).toBeNull()
    expect(screen.getByTestId('action-pad-escape')).toBeTruthy()
    expect(screen.getByText('100 × 20 · 1280 × 800dp')).toBeTruthy()
  })

  it('keeps navigation inputs open but returns command inputs to Home', () => {
    const onInput = jest.fn()
    const screen = render(<ActionPad {...actionPadProps({ onInput })} />)
    const up = screen.getByTestId('action-pad-up')

    fireEvent(up, 'pressIn')
    fireEvent(up, 'longPress')
    fireEvent.press(up)
    expect(screen.getByLabelText('Current action path: Up Arrow – Navigation')).toBeTruthy()

    fireEvent.press(screen.getByTestId('action-pad-top'))
    expect(onInput).toHaveBeenLastCalledWith('gg')
    expect(screen.getByLabelText('Current action path: Up Arrow – Navigation')).toBeTruthy()

    fireEvent.press(screen.getByTestId('action-pad-back'))
    fireEvent.press(screen.getByTestId('action-pad-leader'))
    fireEvent.press(screen.getByTestId('action-pad-search'))
    fireEvent.press(screen.getByTestId('action-pad-grep'))

    expect(onInput).toHaveBeenLastCalledWith('<Space>sg')
    expect(screen.queryByTestId('action-pad-back')).toBeNull()
    expect(screen.getByTestId('action-pad-escape')).toBeTruthy()
  })

  it('opens the software keyboard without dispatching Neovim input', () => {
    const props = actionPadProps()
    const screen = render(<ActionPad {...props} />)

    fireEvent.press(screen.getByTestId('action-pad-keyboard'))

    expect(props.onKeyboardPress).toHaveBeenCalledTimes(1)
    expect(props.onInput).not.toHaveBeenCalled()
  })

  it('sends a configured arrow tap as Neovim input', () => {
    const onInput = jest.fn()
    const screen = render(<ActionPad {...actionPadProps({ onInput })} />)

    fireEvent.press(screen.getByTestId('action-pad-up'))

    expect(onInput).toHaveBeenCalledTimes(1)
    expect(onInput).toHaveBeenCalledWith('<Up>')
    expect(screen.queryByTestId('action-pad-back')).toBeNull()
  })

  it('opens navigation on hold and suppresses the configured release tap', () => {
    const onInput = jest.fn()
    const screen = render(<ActionPad {...actionPadProps({ onInput })} />)
    const up = screen.getByTestId('action-pad-up')

    expect(ACTION_PAD_LONG_PRESS_MS).toBe(450)
    fireEvent(up, 'pressIn')
    fireEvent(up, 'longPress')
    fireEvent.press(up)

    expect(onInput).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Current action path: Up Arrow – Navigation')).toBeTruthy()
    expect(screen.getByTestId('action-pad-top')).toBeTruthy()
  })

  it('resets its branch when disabled or when the reset key changes', () => {
    const initialProps = actionPadProps({ resetKey: 'connected' })
    const screen = render(<ActionPad {...initialProps} />)

    fireEvent.press(screen.getByTestId('action-pad-leader'))
    expect(screen.getByTestId('action-pad-back')).toBeTruthy()

    screen.rerender(<ActionPad {...initialProps} enabled={false} />)
    expect(screen.queryByTestId('action-pad-back')).toBeNull()

    screen.rerender(<ActionPad {...initialProps} enabled />)
    fireEvent.press(screen.getByTestId('action-pad-leader'))
    screen.rerender(<ActionPad {...initialProps} resetKey="reconnected" />)
    expect(screen.queryByTestId('action-pad-back')).toBeNull()
  })

  it('does not rebuild its button tree when redraw-facing props are unchanged', () => {
    let groupReads = 0
    const rootMenu = {
      label: ACTION_PAD_MENU.label,
      get groups() {
        groupReads += 1
        return ACTION_PAD_MENU.groups
      }
    } satisfies ActionMenu
    const props = actionPadProps({ rootMenu })
    const screen = render(<ActionPad {...props} />)
    const readsAfterMount = groupReads

    screen.rerender(<ActionPad {...props} />)
    expect(groupReads).toBe(readsAfterMount)

    screen.rerender(<ActionPad {...props} mode="INSERT" />)
    expect(groupReads).toBeGreaterThan(readsAfterMount)
  })
})
