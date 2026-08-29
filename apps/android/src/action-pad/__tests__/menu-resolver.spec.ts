import type { ActionMenu } from '../types'
import {
  resolveActionPadConfig,
  type ActionPadConfig,
  type ActionMenuDefinition,
  type ActionMenuDefinitionInteraction
} from '../document'

function definition(
  id: string,
  label: string,
  interactions: readonly ActionMenuDefinitionInteraction[]
): ActionMenuDefinition {
  return {
    id,
    label,
    groups: [
      {
        id: 'actions',
        buttons: interactions.map((tap, index) => ({
          id: `action-${index}`,
          label: `Action ${index}`,
          styles: { size: '1/2' },
          tap
        }))
      }
    ]
  }
}

function nestedMenu(menu: ActionMenu, buttonIndex = 0): ActionMenu {
  const interaction = menu.groups[0]?.buttons[buttonIndex]?.tap
  if (interaction?.type !== 'menu') {
    throw new Error(`Expected button ${buttonIndex} to open a menu`)
  }

  return interaction.menu
}

function config(menus: readonly ActionMenuDefinition[]): ActionPadConfig {
  return { version: 1, rootMenuId: 'home', menus }
}

describe('resolveActionPadConfig', () => {
  it('retains stable identifiers while resolving nested menu objects', () => {
    const definitions = config([
      definition('home', 'Home', [
        { type: 'menu', menuId: 'leader', after: 'stay' }
      ]),
      definition('leader', 'Leader', [
        { type: 'menu', menuId: 'search', after: 'stay' }
      ]),
      definition('search', 'Search', [
        { type: 'input', nvimInput: '<Space>sg', after: 'root' }
      ])
    ])

    const home = resolveActionPadConfig(definitions)
    const leader = nestedMenu(home)
    const search = nestedMenu(leader)

    expect([home.id, leader.id, search.id]).toEqual(['home', 'leader', 'search'])
    expect(leader.label).toBe('Leader')
    expect(search.label).toBe('Search')
    expect(search.groups[0]?.buttons[0]?.tap).toEqual({
      type: 'input',
      nvimInput: '<Space>sg',
      after: 'root'
    })
  })

  it('reuses one resolved object when a menu is referenced more than once', () => {
    const definitions = config([
      definition('home', 'Home', [
        { type: 'menu', menuId: 'search', after: 'stay' },
        { type: 'menu', menuId: 'search', after: 'stay' }
      ]),
      definition('search', 'Search', [
        { type: 'back', after: 'stay' }
      ])
    ])

    const home = resolveActionPadConfig(definitions)

    expect(nestedMenu(home, 0)).toBe(nestedMenu(home, 1))
  })

  it('resolves group interactions to their destination menu and identical group object', () => {
    const definitions = config([
      definition('home', 'Home', [
        { type: 'group', menuId: 'delete', groupId: 'actions', after: 'stay' },
        { type: 'group', menuId: 'delete', groupId: 'actions', after: 'root' }
      ]),
      definition('delete', 'Delete', [
        { type: 'input', nvimInput: 'd', after: 'root' }
      ])
    ])

    const home = resolveActionPadConfig(definitions)
    const first = home.groups[0]?.buttons[0]?.tap
    const second = home.groups[0]?.buttons[1]?.tap
    if (first?.type !== 'group' || second?.type !== 'group') throw new Error('Expected group interactions')

    expect(first.menu).toBe(second.menu)
    expect(first.group).toBe(first.menu.groups[0])
    expect(second.group).toBe(first.group)
    expect(first).toMatchObject({ type: 'group', after: 'stay', menu: { id: 'delete' }, group: { id: 'actions' } })
    expect(second.after).toBe('root')
  })

  it('rejects a reference without a registered definition', () => {
    const definitions = config([
      definition('home', 'Home', [
        { type: 'menu', menuId: 'search', after: 'stay' }
      ])
    ])

    expect(() => resolveActionPadConfig(definitions)).toThrow(
      'Missing action menu definition: search'
    )
  })

  it('rejects logical cycles with the reference path', () => {
    const definitions = config([
      definition('home', 'Home', [
        { type: 'menu', menuId: 'leader', after: 'stay' }
      ]),
      definition('leader', 'Leader', [
        { type: 'menu', menuId: 'home', after: 'stay' }
      ])
    ])

    expect(() => resolveActionPadConfig(definitions)).toThrow(
      'Cyclic action menu reference: home -> leader -> home'
    )
  })

  it('resolves hold-only references and retains presentation and return settings', () => {
    const root: ActionMenuDefinition = {
      id: 'home',
      label: 'Home',
      groups: [{
        id: 'arbitrary-group',
        buttons: [{
          id: 'hold',
          label: '⬆',
          accessibilityLabel: 'Up',
          accessibilityHint: 'Hold for choices',
          styles: { size: '1/4' },
          longPress: { type: 'menu', menuId: 'custom-menu', after: 'stay' }
        }]
      }]
    }
    const menu = resolveActionPadConfig(config([
      root,
      definition('custom-menu', 'Custom', [{ type: 'keyboard', after: 'root' }])
    ]))
    const button = menu.groups[0]?.buttons[0]

    expect(button).toMatchObject({
      id: 'hold',
      label: '⬆',
      accessibilityLabel: 'Up',
      accessibilityHint: 'Hold for choices',
      styles: { size: '1/4' },
      longPress: { type: 'menu', after: 'stay', menu: { id: 'custom-menu', label: 'Custom' } }
    })
    expect(button?.tap).toBeUndefined()
    if (button?.longPress?.type !== 'menu') throw new Error('Expected a menu')
    expect(button.longPress.menu.groups[0]?.buttons[0]?.tap).toEqual({
      type: 'keyboard', after: 'root'
    })
  })
})
