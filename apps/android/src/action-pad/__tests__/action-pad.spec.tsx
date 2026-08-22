import { StyleSheet } from 'react-native'
import { cleanup, fireEvent, render } from '@testing-library/react-native'

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
  it('keeps two 48dp touch rows in its keyboard-compact layout', () => {
    const screen = render(<ActionPad {...actionPadProps({ compact: true })} />)

    expect(StyleSheet.flatten(screen.getByTestId('action-pad').props.style).minHeight).toBe(144)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-row-1').props.style).height).toBe(48)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-row-2').props.style).height).toBe(48)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-escape').props.style).height).toBe(48)
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
    let rowReads = 0
    const rootMenu = {
      id: ACTION_PAD_MENU.id,
      label: ACTION_PAD_MENU.label,
      afterInput: ACTION_PAD_MENU.afterInput,
      get rows() {
        rowReads += 1
        return ACTION_PAD_MENU.rows
      }
    } satisfies ActionMenu
    const props = actionPadProps({ rootMenu })
    const screen = render(<ActionPad {...props} />)
    const readsAfterMount = rowReads

    screen.rerender(<ActionPad {...props} />)
    expect(rowReads).toBe(readsAfterMount)

    screen.rerender(<ActionPad {...props} mode="INSERT" />)
    expect(rowReads).toBeGreaterThan(readsAfterMount)
  })
})
