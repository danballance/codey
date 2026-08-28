import type { ActionMenu } from '../types'
import { MENU_IDS } from '../menus/ids'
import { resolveActionMenu } from '../menus/resolve'
import type {
  ActionMenuDefinition,
  ActionMenuDefinitionInteraction
} from '../menus/types'

function definition(
  label: string,
  interactions: readonly ActionMenuDefinitionInteraction[]
): ActionMenuDefinition {
  return {
    label,
    groups: [
      {
        id: 'actions',
        buttons: interactions.map((tap, index) => ({
          id: `action-${index}`,
          label: `Action ${index}`,
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

describe('resolveActionMenu', () => {
  it('resolves nested menu identifiers into the existing menu object shape', () => {
    const definitions = {
      [MENU_IDS.HOME]: definition('Home', [
        { type: 'menu', menuId: MENU_IDS.LEADER, after: 'stay' }
      ]),
      [MENU_IDS.LEADER]: definition('Leader', [
        { type: 'menu', menuId: MENU_IDS.SEARCH, after: 'stay' }
      ]),
      [MENU_IDS.SEARCH]: definition('Search', [
        { type: 'input', nvimInput: '<Space>sg', after: 'root' }
      ])
    }

    const home = resolveActionMenu(MENU_IDS.HOME, definitions)
    const leader = nestedMenu(home)
    const search = nestedMenu(leader)

    expect(leader.label).toBe('Leader')
    expect(search.label).toBe('Search')
    expect(search.groups[0]?.buttons[0]?.tap).toEqual({
      type: 'input',
      nvimInput: '<Space>sg',
      after: 'root'
    })
  })

  it('reuses one resolved object when a menu is referenced more than once', () => {
    const definitions = {
      [MENU_IDS.HOME]: definition('Home', [
        { type: 'menu', menuId: MENU_IDS.SEARCH, after: 'stay' },
        { type: 'menu', menuId: MENU_IDS.SEARCH, after: 'stay' }
      ]),
      [MENU_IDS.SEARCH]: definition('Search', [
        { type: 'back', after: 'stay' }
      ])
    }

    const home = resolveActionMenu(MENU_IDS.HOME, definitions)

    expect(nestedMenu(home, 0)).toBe(nestedMenu(home, 1))
  })

  it('rejects a reference without a registered definition', () => {
    const definitions = {
      [MENU_IDS.HOME]: definition('Home', [
        { type: 'menu', menuId: MENU_IDS.SEARCH, after: 'stay' }
      ])
    }

    expect(() => resolveActionMenu(MENU_IDS.HOME, definitions)).toThrow(
      'Missing action menu definition: search'
    )
  })

  it('rejects logical cycles with the reference path', () => {
    const definitions = {
      [MENU_IDS.HOME]: definition('Home', [
        { type: 'menu', menuId: MENU_IDS.LEADER, after: 'stay' }
      ]),
      [MENU_IDS.LEADER]: definition('Leader', [
        { type: 'menu', menuId: MENU_IDS.HOME, after: 'stay' }
      ])
    }

    expect(() => resolveActionMenu(MENU_IDS.HOME, definitions)).toThrow(
      'Cyclic action menu reference: home -> leader -> home'
    )
  })
})
