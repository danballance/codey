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
    controlActive: false,
    onKeyPress: jest.fn(),
    onRawInput: jest.fn(),
    onToggleControl: jest.fn(),
    ...overrides
  }
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
      'action-pad-ctrl'
    )).toBeTruthy()
    expect(within(portrait.getByTestId('action-pad-leading-row-2')).getByTestId(
      'action-pad-left'
    )).toBeTruthy()
    expect(within(portrait.getByTestId('action-pad-trailing-row-1')).getByTestId(
      'action-pad-down'
    )).toBeTruthy()
    expect(within(portrait.getByTestId('action-pad-trailing-row-2')).getByTestId(
      'action-pad-command'
    )).toBeTruthy()
    portrait.unmount()

    const landscape = render(<ActionPad {...actionPadProps({ placement: 'right' })} />)
    expect(within(landscape.getByTestId('action-pad-leading-group')).getByTestId(
      'action-pad-ctrl'
    )).toBeTruthy()
    expect(within(landscape.getByTestId('action-pad-trailing-group')).getByTestId(
      'action-pad-command'
    )).toBeTruthy()
  })

  it('uses scrollable top/bottom groups with two columns for right placement', () => {
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
      'action-pad-ctrl',
      'action-pad-escape',
      'action-pad-tab',
      'action-pad-enter',
      'action-pad-backspace',
      'action-pad-left',
      'action-pad-down',
      'action-pad-up',
      'action-pad-right',
      'action-pad-leader',
      'action-pad-command'
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

  it('places generated Back after the final trailing submenu action', () => {
    const screen = render(
      <ActionPad {...actionPadProps({ placement: 'right' })} />
    )

    fireEvent.press(screen.getByTestId('action-pad-leader'))
    const buttons = screen.getAllByRole('button')
    expect(buttons[buttons.length - 1]?.props.testID).toBe('action-pad-back')
  })

  it('renders disabled actions without dispatching input', () => {
    const props = actionPadProps({ enabled: false })
    const screen = render(<ActionPad {...props} />)
    const escape = screen.getByTestId('action-pad-escape')

    expect(escape.props.accessibilityState).toEqual({ disabled: true, selected: false })
    fireEvent.press(escape)

    expect(props.onKeyPress).not.toHaveBeenCalled()
    expect(props.onRawInput).not.toHaveBeenCalled()
    expect(props.onToggleControl).not.toHaveBeenCalled()
  })

  it('shows the branch breadcrumb and generated Back while replacing sibling actions', () => {
    const screen = render(<ActionPad {...actionPadProps()} />)

    fireEvent.press(screen.getByTestId('action-pad-leader'))
    expect(screen.getByLabelText('Current action path: Leader')).toBeTruthy()
    expect(screen.queryByTestId('action-pad-ctrl')).toBeNull()
    expect(screen.getByTestId('action-pad-back')).toBeTruthy()
    expect(within(screen.getByTestId('action-pad-trailing-row-2')).getByTestId(
      'action-pad-back'
    )).toBeTruthy()

    fireEvent.press(screen.getByTestId('action-pad-search'))
    expect(screen.getByLabelText('Current action path: Leader / Search')).toBeTruthy()
    expect(screen.getByTestId('action-pad-grep')).toBeTruthy()

    fireEvent.press(screen.getByTestId('action-pad-back'))
    expect(screen.getByLabelText('Current action path: Leader')).toBeTruthy()
    expect(screen.getByTestId('action-pad-search')).toBeTruthy()

    fireEvent.press(screen.getByTestId('action-pad-back'))
    expect(screen.queryByTestId('action-pad-back')).toBeNull()
    expect(screen.getByTestId('action-pad-ctrl')).toBeTruthy()
    expect(screen.getByText('100 × 20 · 1280 × 800dp')).toBeTruthy()
  })

  it('returns root-input menus to Home but keeps navigation menus open', () => {
    const onRawInput = jest.fn()
    const screen = render(<ActionPad {...actionPadProps({ onRawInput })} />)

    const up = screen.getByTestId('action-pad-up')
    fireEvent(up, 'pressIn')
    fireEvent(up, 'longPress')
    fireEvent.press(up)
    expect(screen.getByLabelText('Current action path: Up Arrow – Navigation')).toBeTruthy()

    fireEvent.press(screen.getByTestId('action-pad-top'))
    expect(onRawInput).toHaveBeenLastCalledWith('gg')
    expect(screen.getByLabelText('Current action path: Up Arrow – Navigation')).toBeTruthy()

    fireEvent.press(screen.getByTestId('action-pad-back'))
    fireEvent.press(screen.getByTestId('action-pad-leader'))
    fireEvent.press(screen.getByTestId('action-pad-search'))
    fireEvent.press(screen.getByTestId('action-pad-grep'))

    expect(onRawInput).toHaveBeenLastCalledWith('<Space>sg')
    expect(screen.queryByTestId('action-pad-back')).toBeNull()
    expect(screen.getByTestId('action-pad-ctrl')).toBeTruthy()
  })

  it('toggles Ctrl and exposes its selected state', () => {
    const onToggleControl = jest.fn()
    const initialProps = actionPadProps({ onToggleControl })
    const screen = render(<ActionPad {...initialProps} />)

    fireEvent.press(screen.getByTestId('action-pad-ctrl'))
    expect(onToggleControl).toHaveBeenCalledTimes(1)

    screen.rerender(<ActionPad {...initialProps} controlActive />)
    expect(screen.getByTestId('action-pad-ctrl').props.accessibilityState).toEqual({
      disabled: false,
      selected: true
    })
  })

  it('sends a dual button tap as one native key press', () => {
    const onKeyPress = jest.fn()
    const screen = render(<ActionPad {...actionPadProps({ onKeyPress })} />)

    fireEvent.press(screen.getByTestId('action-pad-up'))

    expect(onKeyPress).toHaveBeenCalledTimes(1)
    expect(onKeyPress).toHaveBeenCalledWith('ArrowUp')
    expect(screen.queryByTestId('action-pad-back')).toBeNull()
  })

  it('opens a dual navigation menu after 450ms and suppresses the release tap', () => {
    const onKeyPress = jest.fn()
    const screen = render(<ActionPad {...actionPadProps({ onKeyPress })} />)
    const up = screen.getByTestId('action-pad-up')

    expect(ACTION_PAD_LONG_PRESS_MS).toBe(450)
    fireEvent(up, 'pressIn')
    fireEvent(up, 'longPress')
    fireEvent.press(up)

    expect(onKeyPress).not.toHaveBeenCalled()
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
      id: ACTION_PAD_MENU.id,
      label: ACTION_PAD_MENU.label,
      afterInput: ACTION_PAD_MENU.afterInput,
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
