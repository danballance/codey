import { StyleSheet } from 'react-native'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react-native'

import {
  CODEY_NERD_FONT_FAMILIES,
  useCodeyNerdFontFaces
} from '../../fonts'
import {
  ACTION_PAD_LONG_PRESS_MS,
  ACTION_PAD_MENU,
  ActionPad,
  type ActionGroup,
  type ActionInteraction,
  type ActionMenu,
  type ActionPadProps
} from '..'

jest.mock('../../fonts', () => ({
  CODEY_NERD_FONT_FAMILIES: {
    regular: 'CodeyNerdFont-Regular',
    semiBold: 'CodeyNerdFont-SemiBold',
    bold: 'CodeyNerdFont-Bold',
    italic: 'CodeyNerdFont-Italic',
    boldItalic: 'CodeyNerdFont-BoldItalic'
  },
  useCodeyNerdFontFaces: jest.fn(() => [true, null])
}))

afterEach(cleanup)

beforeEach(() => {
  jest.mocked(useCodeyNerdFontFaces).mockReturnValue([true, null])
})

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

function group(
  menu: ActionMenu,
  target: ActionGroup,
  after: 'root' | 'stay' = 'stay'
): ActionInteraction {
  return { type: 'group', menu, group: target, after }
}

function runtimeFixture(): {
  readonly rootMenu: ActionMenu
  readonly alphaMenu: ActionMenu
  readonly betaMenu: ActionMenu
  readonly nestedMenu: ActionMenu
  readonly pageMenu: ActionMenu
} {
  const nestedMenu: ActionMenu = {
    id: 'nested-menu',
    label: 'Nested',
    groups: [{
      id: 'options',
      buttons: [{ id: 'same', label: 'Nested same', tap: input('nested') }]
    }]
  }
  const pageMenu: ActionMenu = {
    id: 'page',
    label: 'Page',
    groups: [
      {
        id: 'page-actions',
        buttons: [
          { id: 'page-input', label: 'Page input', tap: input('page', 'stay') },
          {
            id: 'open-page-cluster',
            label: 'Open page cluster',
            tap: group(nestedMenu, nestedMenu.groups[0]!)
          }
        ]
      },
      {
        id: 'navigation',
        buttons: [{ id: 'back', label: 'Back', tap: { type: 'back', after: 'stay' } }]
      }
    ]
  }
  const alphaMenu: ActionMenu = {
    id: 'alpha-menu',
    label: 'Alpha',
    groups: [{
      id: 'options',
      buttons: [
        { id: 'same', label: 'Alpha same', tap: input('alpha', 'stay') },
        { id: 'alpha-root', label: 'Alpha root', tap: input('alpha-root', 'root') },
        {
          id: 'nested',
          label: 'Nested',
          tap: group(nestedMenu, nestedMenu.groups[0]!)
        },
        {
          id: 'open-page-from-alpha',
          label: 'Open page',
          tap: { type: 'menu', menu: pageMenu, after: 'stay' }
        },
        { id: 'cluster-keyboard', label: 'Keyboard', tap: { type: 'keyboard', after: 'stay' } }
      ]
    }]
  }
  const betaMenu: ActionMenu = {
    id: 'beta-menu',
    label: 'Beta',
    groups: [{
      id: 'options',
      buttons: [{ id: 'same', label: 'Beta same', tap: input('beta', 'stay') }]
    }]
  }
  const rootMenu: ActionMenu = {
    id: 'home',
    label: 'Home',
    groups: [
      {
        id: 'first-host',
        buttons: [{
          id: 'open-alpha',
          label: 'Open Alpha',
          tap: group(alphaMenu, alphaMenu.groups[0]!)
        }]
      },
      {
        id: 'second-host',
        buttons: [
          {
            id: 'open-beta',
            label: 'Open Beta',
            tap: group(betaMenu, betaMenu.groups[0]!)
          },
          {
            id: 'open-page',
            label: 'Open Page',
            tap: { type: 'menu', menu: pageMenu, after: 'stay' }
          },
          { id: 'home-back', label: 'Home Back', tap: { type: 'back', after: 'stay' } }
        ]
      }
    ]
  }
  return { rootMenu, alphaMenu, betaMenu, nestedMenu, pageMenu }
}

function capacityFixture(): ActionMenu {
  const nestedMenu: ActionMenu = {
    id: 'capacity-nested',
    label: 'Capacity nested',
    groups: [{
      id: 'options',
      buttons: Array.from({ length: 5 }, (_, index) => ({
        id: `nested-${index + 1}`,
        label: `Nested ${index + 1}`,
        tap: input(`n${index + 1}`)
      }))
    }]
  }
  const firstMenu: ActionMenu = {
    id: 'capacity-first',
    label: 'Capacity first',
    groups: [{
      id: 'options',
      buttons: [
        {
          id: 'open-nested-capacity',
          label: 'Nested capacity',
          tap: group(nestedMenu, nestedMenu.groups[0]!)
        },
        { id: 'first-input', label: 'First input', tap: input('first') }
      ]
    }]
  }
  const rootOnlyMenu: ActionMenu = {
    id: 'root-only-capacity',
    label: 'Root only capacity',
    groups: [{
      id: 'options',
      buttons: Array.from({ length: 12 }, (_, index) => ({
        id: `root-only-${index + 1}`,
        label: `Root only ${index + 1}`,
        tap: input(`r${index + 1}`)
      }))
    }]
  }
  return {
    id: 'capacity-home',
    label: 'Capacity home',
    groups: [
      {
        id: 'capacity-host',
        buttons: [
          {
            id: 'open-capacity',
            label: 'Open capacity',
            tap: group(firstMenu, firstMenu.groups[0]!)
          },
          {
            id: 'root-only-link',
            label: 'Root only link',
            tap: group(rootOnlyMenu, rootOnlyMenu.groups[0]!, 'root')
          }
        ]
      },
      {
        id: 'capacity-sibling',
        buttons: [{ id: 'capacity-static', label: 'Static', tap: input('static') }]
      }
    ]
  }
}

function capturePress(screen: ReturnType<typeof render>, testId: string): () => void {
  let target = screen.getByTestId(testId)
  while (typeof target.props.onPress !== 'function' && target.parent !== null) {
    target = target.parent
  }
  expect(typeof target.props.onPress).toBe('function')
  return target.props.onPress
}

function expectHeaderContext(
  screen: ReturnType<typeof render>,
  page: string,
  cluster: string
): void {
  const header = screen.getByLabelText(
    `Current action page path: ${page}; active action cluster: ${cluster}`
  )
  expect(header.props.children).toEqual(['› ', `${page} · ${cluster}`])
}

describe('ActionPad', () => {
  it('uses bundled faces only after Expo reports them ready', () => {
    jest.mocked(useCodeyNerdFontFaces).mockReturnValue([false, null])
    const props = actionPadProps()
    const screen = render(<ActionPad {...props} />)

    expect(StyleSheet.flatten(screen.getByText('NORMAL').props.style)).toMatchObject({
      fontFamily: 'monospace',
      fontWeight: '700'
    })
    expect(StyleSheet.flatten(screen.getByText('Esc').props.style).fontFamily).toBeUndefined()

    jest.mocked(useCodeyNerdFontFaces).mockReturnValue([true, null])
    screen.rerender(<ActionPad {...props} mode="INSERT" />)

    expect(StyleSheet.flatten(screen.getByText('INSERT').props.style)).toMatchObject({
      fontFamily: CODEY_NERD_FONT_FAMILIES.bold,
      fontWeight: 'normal'
    })
    expect(StyleSheet.flatten(screen.getByText(props.dimensions).props.style)).toMatchObject({
      fontFamily: CODEY_NERD_FONT_FAMILIES.regular,
      fontWeight: 'normal'
    })
    expect(StyleSheet.flatten(screen.getByText('Esc').props.style)).toMatchObject({
      fontFamily: CODEY_NERD_FONT_FAMILIES.semiBold,
      fontWeight: 'normal'
    })

    jest.mocked(useCodeyNerdFontFaces).mockReturnValue([
      false,
      new Error('font unavailable')
    ])
    screen.rerender(<ActionPad {...props} mode="REPLACE" />)

    expect(StyleSheet.flatten(screen.getByText('REPLACE').props.style)).toMatchObject({
      fontFamily: 'monospace',
      fontWeight: '700'
    })
    expect(StyleSheet.flatten(screen.getByText('Esc').props.style).fontFamily).toBeUndefined()
  })

  it('defaults to the roomy below-terminal presentation', () => {
    const screen = render(<ActionPad {...actionPadProps()} />)

    const panelStyle = StyleSheet.flatten(
      screen.getByTestId('action-pad').props.style
    )
    expect(panelStyle.minHeight).toBe(213)
    expect(panelStyle.borderTopWidth).toBe(2)
    expect(panelStyle.width).toBeUndefined()
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-groups').props.style)).toMatchObject({
      minWidth: '100%',
      height: 110,
      flexDirection: 'row',
      gap: 6
    })
    expect(screen.getByTestId('action-pad-horizontal-scroll')).toBeTruthy()
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-core-row-1').props.style)).toMatchObject({
      height: 52,
      flexDirection: 'row',
      gap: 6
    })
    expect(screen.getByTestId('action-pad-core-group')).toBeTruthy()
    expect(screen.getByTestId('action-pad-navigation-group')).toBeTruthy()
  })

  it('keeps two 48dp touch rows in each group in its keyboard-compact layout', () => {
    const screen = render(<ActionPad {...actionPadProps({ compact: true })} />)

    expect(StyleSheet.flatten(screen.getByTestId('action-pad').props.style).minHeight).toBe(144)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-groups').props.style).height).toBe(102)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-core-row-1').props.style).height).toBe(48)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-core-row-2').props.style).height).toBe(48)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-navigation-row-1').props.style).height).toBe(48)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-navigation-row-2').props.style).height).toBe(48)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-escape').props.style)).toMatchObject({
      minWidth: 48,
      height: 48
    })
  })

  it('keeps configured group membership while changing the group grid by placement', () => {
    const portrait = render(<ActionPad {...actionPadProps()} />)

    expect(within(portrait.getByTestId('action-pad-core-row-1')).getByTestId(
      'action-pad-escape'
    )).toBeTruthy()
    expect(within(portrait.getByTestId('action-pad-pages-row-1')).getByTestId(
      'action-pad-command'
    )).toBeTruthy()
    expect(within(portrait.getByTestId('action-pad-navigation-row-1')).getByTestId(
      'action-pad-down'
    )).toBeTruthy()
    expect(within(portrait.getByTestId('action-pad-navigation-row-1')).getByTestId(
      'action-pad-left'
    )).toBeTruthy()
    portrait.unmount()

    const landscape = render(<ActionPad {...actionPadProps({ placement: 'right' })} />)
    expect(within(landscape.getByTestId('action-pad-core-group')).getByTestId(
      'action-pad-escape'
    )).toBeTruthy()
    expect(within(landscape.getByTestId('action-pad-operators-group')).getByTestId(
      'action-pad-motions'
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
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-core-group').props.style)).toMatchObject({
      width: '100%',
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'flex-start',
      alignContent: 'flex-start',
      columnGap: '4%',
      rowGap: 12
    })
    expect(screen.getByTestId('action-pad-navigation-group')).toBeTruthy()
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-escape').props.style)).toMatchObject({
      minWidth: 48,
      width: '48%',
      height: 52,
      flex: 0,
      borderRadius: 12
    })
    expect(screen.getAllByRole('button').map((button) => button.props.testID)).toEqual([
      'action-pad-escape',
      'action-pad-directory',
      'action-pad-command',
      'action-pad-leader',
      'action-pad-yank',
      'action-pad-delete',
      'action-pad-motions',
      'action-pad-text-objects',
      'action-pad-down',
      'action-pad-up',
      'action-pad-left',
      'action-pad-right',
      'action-pad-keyboard',
      'action-pad-enter'
    ])
  })

  it('keeps the right flow scrollable with 48dp controls when compact', () => {
    const screen = render(
      <ActionPad {...actionPadProps({ compact: true, placement: 'right' })} />
    )

    expect(screen.getByTestId('action-pad-flow-scroll')).toBeTruthy()
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-flow-scroll').props.contentContainerStyle).gap).toBe(6)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-core-group').props.style).rowGap).toBe(6)
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-escape').props.style)).toMatchObject({
      minWidth: 48,
      width: '48%',
      height: 48,
      flex: 0,
      borderRadius: 8
    })
  })

  it('applies configured quarter and half sizes only in the right rail', () => {
    const rootMenu = {
      id: 'home',
      label: 'Home',
      groups: [
        {
          id: 'sized',
          buttons: [
            { id: 'default-half', label: 'Default', tap: input('d') },
            {
              id: 'explicit-half',
              label: 'Half',
              styles: { size: '1/2' },
              tap: input('h')
            },
            {
              id: 'quarter',
              label: 'Quarter',
              styles: { size: '1/4' },
              tap: input('q')
            }
          ]
        }
      ]
    } satisfies ActionMenu

    const right = render(
      <ActionPad {...actionPadProps({ placement: 'right', rootMenu })} />
    )
    expect(StyleSheet.flatten(right.getByTestId('action-pad-sized-group').props.style)).toMatchObject({
      justifyContent: 'flex-start',
      columnGap: '4%'
    })
    expect(StyleSheet.flatten(right.getByTestId('action-pad-default-half').props.style)).toMatchObject({
      width: '48%',
      flex: 0
    })
    expect(StyleSheet.flatten(right.getByTestId('action-pad-explicit-half').props.style)).toMatchObject({
      width: '48%',
      flex: 0
    })
    expect(StyleSheet.flatten(right.getByTestId('action-pad-quarter').props.style)).toMatchObject({
      minWidth: 48,
      width: '22%',
      height: 52,
      flex: 0
    })
    expect(right.getAllByRole('button').map((button) => button.props.testID)).toEqual([
      'action-pad-default-half',
      'action-pad-explicit-half',
      'action-pad-quarter'
    ])
    right.unmount()

    const compact = render(
      <ActionPad {...actionPadProps({ compact: true, placement: 'right', rootMenu })} />
    )
    expect(StyleSheet.flatten(compact.getByTestId('action-pad-quarter').props.style)).toMatchObject({
      minWidth: 48,
      width: '22%',
      height: 48,
      flex: 0
    })
    compact.unmount()

    const below = render(<ActionPad {...actionPadProps({ rootMenu })} />)
    const belowQuarterStyle = StyleSheet.flatten(
      below.getByTestId('action-pad-quarter').props.style
    )
    expect(belowQuarterStyle.flex).toBe(1)
    expect(belowQuarterStyle.width).toBeUndefined()
  })

  it('packs four-quarter and mixed fractional rows in declaration order', () => {
    const quarter = (id: string) => ({
      id,
      label: id,
      styles: { size: '1/4' as const },
      tap: input(id)
    })
    const rootMenu = {
      id: 'home',
      label: 'Home',
      groups: [
        {
          id: 'quarters',
          buttons: [quarter('q1'), quarter('q2'), quarter('q3'), quarter('q4')]
        },
        {
          id: 'mixed',
          buttons: [
            { id: 'half', label: 'half', styles: { size: '1/2' }, tap: input('h') },
            quarter('q5'),
            quarter('q6')
          ]
        }
      ]
    } satisfies ActionMenu

    const screen = render(
      <ActionPad {...actionPadProps({ placement: 'right', rootMenu })} />
    )

    for (const id of ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']) {
      expect(StyleSheet.flatten(screen.getByTestId(`action-pad-${id}`).props.style).width)
        .toBe('22%')
    }
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-half').props.style).width)
      .toBe('48%')
    expect(screen.getAllByRole('button').map((button) => button.props.testID)).toEqual([
      'action-pad-q1',
      'action-pad-q2',
      'action-pad-q3',
      'action-pad-q4',
      'action-pad-half',
      'action-pad-q5',
      'action-pad-q6'
    ])
  })

  it.each([false, true])(
    'reserves a transitive fixed bottom envelope in %s compact mode',
    (compact) => {
      const rootMenu = capacityFixture()
      const screen = render(<ActionPad {...actionPadProps({ compact, rootMenu })} />)
      const scroll = screen.getByTestId('action-pad-horizontal-scroll')
      const host = screen.getByTestId('action-pad-capacity-host-group')
      const sibling = screen.getByTestId('action-pad-capacity-sibling-group')
      const envelope = StyleSheet.flatten(host.props.style)

      // Five reachable buttons require three columns. The twelve-button target
      // uses after: root, so it is not a visible variant of this slot.
      expect(envelope).toMatchObject({
        minWidth: 156,
        flexBasis: 156,
        flexGrow: 3,
        flexShrink: 0,
        gap: 6
      })
      expect(StyleSheet.flatten(screen.getByTestId('action-pad-groups').props.style)).toMatchObject({
        minWidth: '100%', gap: 6
      })

      fireEvent.press(screen.getByTestId('action-pad-open-capacity'))
      expect(screen.getByTestId('action-pad-horizontal-scroll')).toBe(scroll)
      expect(screen.getByTestId('action-pad-capacity-host-group')).toBe(host)
      expect(screen.getByTestId('action-pad-capacity-sibling-group')).toBe(sibling)
      expect(StyleSheet.flatten(host.props.style)).toMatchObject(envelope)

      fireEvent.press(screen.getByTestId('action-pad-open-nested-capacity'))
      expect(screen.getByTestId('action-pad-horizontal-scroll')).toBe(scroll)
      expect(screen.getByTestId('action-pad-capacity-host-group')).toBe(host)
      expect(screen.getAllByTestId(/^action-pad-nested-\d$/)).toHaveLength(5)
      expect(StyleSheet.flatten(host.props.style)).toMatchObject(envelope)
    }
  )

  it.each([
    { compact: false, expectedHeight: 180 },
    { compact: true, expectedHeight: 156 }
  ])(
    'reserves the exact packed right-rail row height in compact=$compact',
    ({ compact, expectedHeight }) => {
      const rootMenu = capacityFixture()
      const screen = render(
        <ActionPad {...actionPadProps({ compact, placement: 'right', rootMenu })} />
      )
      const scroll = screen.getByTestId('action-pad-flow-scroll')
      const host = screen.getByTestId('action-pad-capacity-host-group')
      const sibling = screen.getByTestId('action-pad-capacity-sibling-group')

      expect(StyleSheet.flatten(host.props.style).height).toBe(expectedHeight)
      fireEvent.press(screen.getByTestId('action-pad-open-capacity'))
      fireEvent.press(screen.getByTestId('action-pad-open-nested-capacity'))

      expect(screen.getByTestId('action-pad-flow-scroll')).toBe(scroll)
      expect(screen.getByTestId('action-pad-capacity-host-group')).toBe(host)
      expect(screen.getByTestId('action-pad-capacity-sibling-group')).toBe(sibling)
      expect(StyleSheet.flatten(host.props.style).height).toBe(expectedHeight)
    }
  )

  it('uses zero exact rail height for an empty group', () => {
    const rootMenu: ActionMenu = {
      id: 'empty-home', label: 'Empty', groups: [{ id: 'empty', buttons: [] }]
    }
    const screen = render(
      <ActionPad {...actionPadProps({ placement: 'right', rootMenu })} />
    )
    expect(StyleSheet.flatten(screen.getByTestId('action-pad-empty-group').props.style).height)
      .toBe(0)
  })

  it('renders any number of named groups in declaration order in both placements', () => {
    const rootMenu = {
      id: 'home',
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
      id: 'child',
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
      id: 'home',
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

  it.each(['below', 'right'] as const)(
    'substitutes only the invoking slot and moves a second cluster to its own host in %s placement',
    (placement) => {
      const { rootMenu } = runtimeFixture()
      const props = actionPadProps({ rootMenu, placement, onEditButton: jest.fn() })
      const screen = render(<ActionPad {...props} />)
      const scrollId = placement === 'right'
        ? 'action-pad-flow-scroll'
        : 'action-pad-horizontal-scroll'
      const scroll = screen.getByTestId(scrollId)
      const firstHost = screen.getByTestId('action-pad-first-host-group')
      const secondHost = screen.getByTestId('action-pad-second-host-group')
      const siblingButton = screen.getByTestId('action-pad-open-beta')

      fireEvent.press(screen.getByTestId('action-pad-open-alpha'))

      expect(screen.getByTestId(scrollId)).toBe(scroll)
      expect(screen.getByTestId('action-pad-first-host-group')).toBe(firstHost)
      expect(screen.getByTestId('action-pad-second-host-group')).toBe(secondHost)
      expect(screen.getByTestId('action-pad-open-beta')).toBe(siblingButton)
      expect(within(firstHost).getByTestId('action-pad-same')).toHaveTextContent('Alpha same')
      expect(within(secondHost).getByTestId('action-pad-open-beta')).toBeTruthy()
      expect(screen.queryByTestId('action-pad-open-alpha')).toBeNull()
      expectHeaderContext(screen, 'Home', 'Alpha')

      screen.rerender(<ActionPad {...props} interactionMode="selection" />)
      fireEvent.press(within(firstHost).getByTestId('action-pad-same'))
      expect(props.onEditButton).toHaveBeenCalledWith({
        menuId: 'alpha-menu', groupId: 'options', buttonId: 'same'
      })

      screen.rerender(<ActionPad {...props} />)
      fireEvent.press(screen.getByTestId('action-pad-open-beta'))

      expect(screen.getByTestId(scrollId)).toBe(scroll)
      expect(screen.getByTestId('action-pad-first-host-group')).toBe(firstHost)
      expect(screen.getByTestId('action-pad-second-host-group')).toBe(secondHost)
      expect(within(firstHost).getByTestId('action-pad-open-alpha')).toBeTruthy()
      expect(within(secondHost).getByTestId('action-pad-same')).toHaveTextContent('Beta same')
      expect(screen.queryByText('Alpha same')).toBeNull()
      expectHeaderContext(screen, 'Home', 'Beta')
    }
  )

  it('keeps nested group actions in the original host and lets Home Back clear only the cluster', () => {
    const { rootMenu } = runtimeFixture()
    const onInput = jest.fn()
    const screen = render(<ActionPad {...actionPadProps({ rootMenu, onInput })} />)
    const firstHost = screen.getByTestId('action-pad-first-host-group')
    const secondHost = screen.getByTestId('action-pad-second-host-group')

    fireEvent.press(screen.getByTestId('action-pad-open-alpha'))
    fireEvent.press(screen.getByTestId('action-pad-nested'))

    expect(screen.getByTestId('action-pad-first-host-group')).toBe(firstHost)
    expect(screen.getByTestId('action-pad-second-host-group')).toBe(secondHost)
    expect(within(firstHost).getByText('Nested same')).toBeTruthy()
    expect(within(secondHost).getByTestId('action-pad-open-beta')).toBeTruthy()
    expect(screen.queryByTestId('action-pad-options-group')).toBeNull()
    expectHeaderContext(screen, 'Home', 'Nested')

    fireEvent.press(within(firstHost).getByTestId('action-pad-same'))
    expect(onInput).toHaveBeenCalledWith('nested')
    expectHeaderContext(screen, 'Home', 'Nested')

    fireEvent.press(screen.getByTestId('action-pad-home-back'))
    expect(within(firstHost).getByTestId('action-pad-open-alpha')).toBeTruthy()
    expect(screen.queryByText('Nested same')).toBeNull()
    expect(screen.getByText('100 × 20 · 1280 × 800dp')).toBeTruthy()
  })

  it('does not rerender untouched sibling group contents during a cluster swap', () => {
    const fixture = runtimeFixture()
    const first = fixture.rootMenu.groups[0]!
    const originalSibling = fixture.rootMenu.groups[1]!
    let siblingButtonReads = 0
    const sibling: ActionGroup = {
      id: originalSibling.id,
      get buttons() {
        siblingButtonReads += 1
        return originalSibling.buttons
      }
    }
    const rootMenu: ActionMenu = {
      ...fixture.rootMenu,
      groups: [first, sibling]
    }
    const screen = render(<ActionPad {...actionPadProps({ rootMenu })} />)
    const readsAfterMount = siblingButtonReads
    const siblingView = screen.getByTestId('action-pad-second-host-group')

    fireEvent.press(screen.getByTestId('action-pad-open-alpha'))

    expect(screen.getByTestId('action-pad-second-host-group')).toBe(siblingView)
    expect(siblingButtonReads).toBe(readsAfterMount)
  })

  it('clears a cluster before page pushes and Back returns to a clean prior page', () => {
    const { rootMenu } = runtimeFixture()
    const screen = render(<ActionPad {...actionPadProps({ rootMenu })} />)

    fireEvent.press(screen.getByTestId('action-pad-open-alpha'))
    fireEvent.press(screen.getByTestId('action-pad-open-page-from-alpha'))
    expect(screen.getByLabelText('Current action path: Page')).toBeTruthy()
    expect(screen.queryByText('Alpha same')).toBeNull()

    fireEvent.press(screen.getByTestId('action-pad-back'))
    expect(screen.getByTestId('action-pad-open-alpha')).toBeTruthy()
    expect(screen.queryByText('Alpha same')).toBeNull()

    fireEvent.press(screen.getByTestId('action-pad-open-page'))
    fireEvent.press(screen.getByTestId('action-pad-open-page-cluster'))
    expectHeaderContext(screen, 'Page', 'Nested')

    fireEvent.press(screen.getByTestId('action-pad-back'))
    expect(screen.getByTestId('action-pad-open-alpha')).toBeTruthy()
    expect(screen.queryByText('Nested same')).toBeNull()
    expect(screen.queryByTestId('action-pad-back')).toBeNull()
  })

  it('preserves a cluster through layout and mode changes while using target selection identity', () => {
    const { rootMenu } = runtimeFixture()
    const props = actionPadProps({
      rootMenu,
      onEditButton: jest.fn(),
      onKeyboardPress: jest.fn()
    })
    const screen = render(<ActionPad {...props} />)
    fireEvent.press(screen.getByTestId('action-pad-open-alpha'))

    screen.rerender(
      <ActionPad {...props} compact placement="right" interactionMode="suspended" />
    )
    expect(screen.getByText('Alpha same')).toBeTruthy()
    expect(screen.getByTestId('action-pad-same').props.accessibilityState).toEqual({
      disabled: true
    })

    screen.rerender(
      <ActionPad {...props} compact placement="right" interactionMode="selection" />
    )
    fireEvent.press(screen.getByTestId('action-pad-same'))
    expect(props.onEditButton).toHaveBeenCalledWith({
      menuId: 'alpha-menu', groupId: 'options', buttonId: 'same'
    })

    screen.rerender(<ActionPad {...props} />)
    fireEvent.press(screen.getByTestId('action-pad-cluster-keyboard'))
    expect(props.onKeyboardPress).toHaveBeenCalledTimes(1)
    expectHeaderContext(screen, 'Home', 'Alpha')
  })

  it('rejects activations from restored and later reopened slot incarnations', () => {
    const { rootMenu } = runtimeFixture()
    const onInput = jest.fn()
    const screen = render(<ActionPad {...actionPadProps({ rootMenu, onInput })} />)
    const staleBasePress = capturePress(screen, 'action-pad-open-alpha')

    fireEvent.press(screen.getByTestId('action-pad-open-alpha'))
    const staleClusterPress = capturePress(screen, 'action-pad-same')
    fireEvent.press(screen.getByTestId('action-pad-home-back'))

    act(() => { staleBasePress() })
    expect(screen.queryByText('Alpha same')).toBeNull()

    fireEvent.press(screen.getByTestId('action-pad-open-alpha'))
    act(() => { staleClusterPress() })
    expect(onInput).not.toHaveBeenCalled()
    expect(screen.getByText('Alpha same')).toBeTruthy()

    fireEvent.press(screen.getByTestId('action-pad-same'))
    expect(onInput).toHaveBeenCalledTimes(1)
    expect(onInput).toHaveBeenCalledWith('alpha')
  })

  it('lets tap and long press independently select any interaction and suppresses release after hold', () => {
    const onInput = jest.fn()
    const childMenu = {
      id: 'child',
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
      id: 'home',
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
      id: 'home',
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
      id: 'child',
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
      id: 'home',
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

  it('selects every action type and hold-only buttons without executing their configured gestures', () => {
    const destination: ActionMenu = { id: 'destination', label: 'Destination', groups: [] }
    const actions: readonly ActionInteraction[] = [
      input('forbidden', 'root'),
      { type: 'menu', menu: destination, after: 'stay' },
      { type: 'back', after: 'stay' },
      { type: 'keyboard', after: 'root' }
    ]
    const childMenu: ActionMenu = {
      id: 'child', label: 'Child', groups: [{
        id: 'actions',
        buttons: [
          ...actions.map((action) => ({ id: action.type, label: action.type, tap: action, longPress: action })),
          { id: 'hold-only', label: 'Hold only', longPress: input('also forbidden', 'root') }
        ]
      }]
    }
    const rootMenu: ActionMenu = {
      id: 'home', label: 'Home', groups: [{
        id: 'actions', buttons: [{
          id: 'open', label: 'Open', tap: { type: 'menu', menu: childMenu, after: 'stay' }
        }]
      }]
    }
    const props = actionPadProps({ rootMenu, onEditButton: jest.fn() })
    const screen = render(<ActionPad {...props} />)
    fireEvent.press(screen.getByTestId('action-pad-open'))
    screen.rerender(<ActionPad {...props} interactionMode="selection" />)

    const ids = ['input', 'menu', 'back', 'keyboard', 'hold-only']
    for (const id of ids) {
      const button = screen.getByTestId(`action-pad-${id}`)
      fireEvent(button, 'pressIn')
      fireEvent.press(button)
      fireEvent(button, 'pressIn')
      fireEvent(button, 'longPress')
      fireEvent(button, 'longPress')
      fireEvent.press(button)
      expect(screen.getByLabelText('Current action path: Child')).toBeTruthy()
    }

    expect(jest.mocked(props.onEditButton!).mock.calls).toEqual(ids.flatMap((buttonId) => [
      [{ menuId: 'child', groupId: 'actions', buttonId }],
      [{ menuId: 'child', groupId: 'actions', buttonId }]
    ]))
    expect(props.onInput).not.toHaveBeenCalled()
    expect(props.onKeyboardPress).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Current action path: Child / Destination')).toBeNull()
  })

  it('allows offline selection without enabling normal actions', () => {
    const props = actionPadProps({ enabled: false, onEditButton: jest.fn() })
    const screen = render(<ActionPad {...props} interactionMode="selection" />)
    const escape = screen.getByRole('button', { name: 'Edit Esc' })
    expect(escape.props.accessibilityState).toEqual({ disabled: false })
    fireEvent.press(escape)
    expect(props.onEditButton).toHaveBeenCalledWith({ menuId: 'home', groupId: 'core', buttonId: 'escape' })
    expect(props.onInput).not.toHaveBeenCalled()

    screen.rerender(<ActionPad {...props} />)
    expect(screen.getByRole('button', { name: 'Esc' }).props.accessibilityState).toEqual({ disabled: true })
    fireEvent.press(screen.getByTestId('action-pad-escape'))
    expect(props.onInput).not.toHaveBeenCalled()
    expect(props.onEditButton).toHaveBeenCalledTimes(1)
  })

  it.each(['below', 'right'] as const)('identifies repeated button and group IDs within their menu in %s placement', (placement) => {
    const sharedButton = { id: 'shared', label: 'Shared', tap: input('shared') }
    const childMenu: ActionMenu = {
      id: 'child', label: 'Same label', groups: [{ id: 'first', buttons: [sharedButton] }]
    }
    const rootMenu: ActionMenu = {
      id: 'home', label: 'Same label', groups: [
        { id: 'first', buttons: [sharedButton] },
        { id: 'second', buttons: [sharedButton] },
        { id: 'navigation', buttons: [{ id: 'open', label: 'Open', tap: { type: 'menu', menu: childMenu, after: 'stay' } }] }
      ]
    }
    const props = actionPadProps({ rootMenu, placement, onEditButton: jest.fn() })
    const screen = render(<ActionPad {...props} interactionMode="selection" />)
    for (const group of ['first', 'second']) {
      fireEvent.press(within(screen.getByTestId(`action-pad-${group}-group`)).getByTestId('action-pad-shared'))
    }
    screen.rerender(<ActionPad {...props} />)
    fireEvent.press(screen.getByTestId('action-pad-open'))
    screen.rerender(<ActionPad {...props} interactionMode="selection" />)
    fireEvent.press(screen.getByTestId('action-pad-shared'))

    expect(jest.mocked(props.onEditButton!).mock.calls).toEqual([
      [{ menuId: 'home', groupId: 'first', buttonId: 'shared' }],
      [{ menuId: 'home', groupId: 'second', buttonId: 'shared' }],
      [{ menuId: 'child', groupId: 'first', buttonId: 'shared' }]
    ])
    expect(props.onInput).not.toHaveBeenCalled()
  })

  it('keeps the menu and scroll view mounted while suspended and restores normal navigation afterward', () => {
    const props = actionPadProps({ placement: 'right', onEditButton: jest.fn() })
    const screen = render(<ActionPad {...props} />)
    fireEvent.press(screen.getByTestId('action-pad-leader'))
    fireEvent.press(screen.getByTestId('action-pad-search'))
    const scroll = screen.getByTestId('action-pad-flow-scroll')
    const latePress = capturePress(screen, 'action-pad-grep')

    screen.rerender(<ActionPad {...props} interactionMode="suspended" />)
    expect(screen.getByLabelText('Current action path: Leader / Search')).toBeTruthy()
    expect(screen.getByTestId('action-pad-flow-scroll')).toBe(scroll)
    for (const button of screen.getAllByRole('button')) {
      expect(button.props.accessibilityState).toEqual({ disabled: true })
      fireEvent(button, 'pressIn')
      fireEvent(button, 'longPress')
      fireEvent.press(button)
    }
    act(() => { latePress() })
    expect(props.onInput).not.toHaveBeenCalled()
    expect(props.onKeyboardPress).not.toHaveBeenCalled()
    expect(props.onEditButton).not.toHaveBeenCalled()

    screen.rerender(<ActionPad {...props} interactionMode="selection" />)
    expect(screen.getByTestId('action-pad-flow-scroll')).toBe(scroll)
    fireEvent.press(screen.getByTestId('action-pad-back'))
    expect(props.onEditButton).toHaveBeenCalledWith({ menuId: 'search', groupId: 'navigation', buttonId: 'back' })
    expect(screen.getByLabelText('Current action path: Leader / Search')).toBeTruthy()

    screen.rerender(<ActionPad {...props} />)
    expect(screen.getByTestId('action-pad-flow-scroll')).toBe(scroll)
    fireEvent.press(screen.getByTestId('action-pad-grep'))
    expect(props.onInput).toHaveBeenCalledWith('<Space>sg')
    expect(screen.queryByLabelText('Current action path: Leader / Search')).toBeNull()
  })

  it('does not reinterpret an in-progress gesture when switching between selection and normal mode', () => {
    const props = actionPadProps({ onEditButton: jest.fn() })
    const screen = render(<ActionPad {...props} />)
    fireEvent(screen.getByTestId('action-pad-up'), 'pressIn')
    screen.rerender(<ActionPad {...props} interactionMode="selection" />)
    fireEvent(screen.getByTestId('action-pad-up'), 'longPress')
    fireEvent.press(screen.getByTestId('action-pad-up'))
    expect(props.onEditButton).not.toHaveBeenCalled()
    expect(props.onInput).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Current action path: Up Arrow – Navigation')).toBeNull()

    fireEvent(screen.getByTestId('action-pad-up'), 'pressIn')
    fireEvent(screen.getByTestId('action-pad-up'), 'longPress')
    screen.rerender(<ActionPad {...props} interactionMode="suspended" />)
    screen.rerender(<ActionPad {...props} />)
    fireEvent.press(screen.getByTestId('action-pad-up'))
    expect(props.onEditButton).toHaveBeenCalledTimes(1)
    expect(props.onInput).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Current action path: Up Arrow – Navigation')).toBeNull()

    fireEvent(screen.getByTestId('action-pad-up'), 'pressIn')
    fireEvent.press(screen.getByTestId('action-pad-up'))
    expect(props.onInput).toHaveBeenCalledWith('<Up>')
  })

  it('does not retarget a late native activation to a replacement document with reused IDs', () => {
    const rootMenu: ActionMenu = {
      id: 'home', label: 'Home', groups: [{
        id: 'actions', buttons: [{ id: 'same', label: 'Original button', tap: input('old') }]
      }]
    }
    const props = actionPadProps({ rootMenu, onEditButton: jest.fn() })
    const screen = render(<ActionPad {...props} interactionMode="selection" />)
    const latePress = capturePress(screen, 'action-pad-same')
    const replacement: ActionMenu = {
      ...rootMenu, groups: [{
        id: 'actions', buttons: [{ id: 'same', label: 'Replacement button', tap: input('new') }]
      }]
    }
    const onReplacementEdit = jest.fn()
    screen.rerender(<ActionPad {...props} rootMenu={replacement} onEditButton={onReplacementEdit} interactionMode="selection" />)

    act(() => { latePress() })
    expect(props.onEditButton).not.toHaveBeenCalled()
    expect(onReplacementEdit).not.toHaveBeenCalled()
    expect(props.onInput).not.toHaveBeenCalled()
    fireEvent.press(screen.getByRole('button', { name: 'Edit Replacement button' }))
    expect(onReplacementEdit).toHaveBeenCalledWith({ menuId: 'home', groupId: 'actions', buttonId: 'same' })
  })

  it.each(['below', 'right'] as const)('keeps readable labels and unchanged button dimensions for selection in %s placement', (placement) => {
    const rootMenu: ActionMenu = {
      id: 'home', label: 'Home', groups: [{
        id: 'actions', buttons: [
          {
            id: 'quarter', label: '↑', accessibilityLabel: 'Move up', accessibilityHint: 'Hold to navigate.',
            styles: { size: '1/4' }, longPress: input('<Up>')
          },
          { id: 'half', label: 'A longer label', styles: { size: '1/2' }, tap: input('x') }
        ]
      }]
    }
    for (const compact of [false, true]) {
      const props = actionPadProps({ rootMenu, placement, compact })
      const screen = render(<ActionPad {...props} />)
      const dimensions = ['quarter', 'half'].map((id) => StyleSheet.flatten(screen.getByTestId(`action-pad-${id}`).props.style))
      screen.rerender(<ActionPad {...props} interactionMode="selection" />)

      expect(screen.getAllByRole('button')).toHaveLength(2)
      const quarter = screen.getByRole('button', { name: 'Edit Move up' })
      expect(quarter.props.accessibilityHint).toBe('Open button settings.')
      expect(screen.getByRole('button', { name: 'Edit A longer label' })).toBeTruthy()
      for (const [index, id] of ['quarter', 'half'].entries()) {
        const style = StyleSheet.flatten(screen.getByTestId(`action-pad-${id}`).props.style)
        expect(style).toEqual(dimensions[index])
        expect(style).toMatchObject({ minWidth: 48, height: compact ? 48 : 52 })
        const pencil = screen.getByTestId(`action-pad-${id}-edit-indicator`, { includeHiddenElements: true })
        expect(pencil.props).toMatchObject({
          accessible: false, accessibilityElementsHidden: true,
          importantForAccessibility: 'no-hide-descendants', pointerEvents: 'none'
        })
        expect(pencil.props.onPress).toBeUndefined()
      }
      const label = screen.getByText('A longer label')
      expect(label.props.numberOfLines).toBe(2)
      expect(StyleSheet.flatten(label.props.style)).toMatchObject({
        fontSize: compact ? 13 : 15, lineHeight: compact ? 16 : 18
      })
      screen.unmount()
    }
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
    expect(screen.getByLabelText(
      'Current action page path: Home; active action cluster: Up Arrow – Navigation'
    )).toBeTruthy()

    fireEvent.press(screen.getByTestId('action-pad-top'))
    expect(onInput).toHaveBeenLastCalledWith('gg')
    expect(screen.getByLabelText(
      'Current action page path: Home; active action cluster: Up Arrow – Navigation'
    )).toBeTruthy()

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
    expect(screen.getByLabelText(
      'Current action page path: Home; active action cluster: Up Arrow – Navigation'
    )).toBeTruthy()
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

  it('clears cluster state for root actions, disable, reset, and configuration replacement', () => {
    const { rootMenu } = runtimeFixture()
    const onInput = jest.fn()
    const props = actionPadProps({ rootMenu, onInput, resetKey: 'initial' })
    const screen = render(<ActionPad {...props} />)

    fireEvent.press(screen.getByTestId('action-pad-open-alpha'))
    fireEvent.press(screen.getByTestId('action-pad-alpha-root'))
    expect(onInput).toHaveBeenCalledWith('alpha-root')
    expect(screen.getByTestId('action-pad-open-alpha')).toBeTruthy()

    fireEvent.press(screen.getByTestId('action-pad-open-alpha'))
    screen.rerender(<ActionPad {...props} resetKey="reset" />)
    expect(screen.getByTestId('action-pad-open-alpha')).toBeTruthy()
    expect(screen.queryByText('Alpha same')).toBeNull()

    fireEvent.press(screen.getByTestId('action-pad-open-alpha'))
    screen.rerender(<ActionPad {...props} resetKey="reset" enabled={false} />)
    expect(screen.queryByText('Alpha same')).toBeNull()

    screen.rerender(<ActionPad {...props} resetKey="reset" />)
    fireEvent.press(screen.getByTestId('action-pad-open-alpha'))
    const replacement: ActionMenu = {
      id: 'replacement',
      label: 'Replacement',
      groups: [{
        id: 'replacement-actions',
        buttons: [{ id: 'replacement-input', label: 'Replacement input', tap: input('new') }]
      }]
    }
    screen.rerender(<ActionPad {...props} resetKey="reset" rootMenu={replacement} />)
    expect(screen.getByTestId('action-pad-replacement-input')).toBeTruthy()
    expect(screen.queryByText('Alpha same')).toBeNull()
  })

  it('returns to the new root and replaces old actions when configuration changes', () => {
    const props = actionPadProps()
    const screen = render(<ActionPad {...props} />)
    fireEvent.press(screen.getByTestId('action-pad-leader'))

    const rootMenu: ActionMenu = {
      id: 'replacement',
      label: 'Replacement',
      groups: [{
        id: 'new-group',
        buttons: [{ id: 'new-action', label: 'New action', tap: input('fresh') }]
      }]
    }
    screen.rerender(<ActionPad {...props} rootMenu={rootMenu} />)

    expect(screen.queryByTestId('action-pad-back')).toBeNull()
    expect(screen.queryByTestId('action-pad-search')).toBeNull()
    fireEvent.press(screen.getByTestId('action-pad-new-action'))
    expect(props.onInput).toHaveBeenCalledWith('fresh')
  })

  it('does not rebuild its button tree when redraw-facing props are unchanged', () => {
    let groupReads = 0
    const rootMenu = {
      id: ACTION_PAD_MENU.id,
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
