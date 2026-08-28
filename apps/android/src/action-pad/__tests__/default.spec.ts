import { DEFAULT_ACTION_PAD_CONFIG } from '../config'

const groupLayout = {
  home: ['core', 'pages', 'operators', 'navigation'],
  command: ['write', 'exit', 'history', 'navigation'],
  leader: ['discovery', 'workspace', 'code', 'help', 'navigation'],
  motions: ['options'],
  'text-objects': ['options'],
  'up-navigation': ['options'],
  'down-navigation': ['options'],
  search: ['sources', 'content', 'navigation'],
  window: ['focus', 'layout', 'window', 'navigation'],
  code: ['navigate', 'inspect', 'change', 'navigation'],
  yank: ['options'],
  delete: ['options']
} as const

const transientMenuIds = [
  'yank', 'delete', 'motions', 'text-objects', 'up-navigation', 'down-navigation'
] as const

function menu(menuId: string) {
  return DEFAULT_ACTION_PAD_CONFIG.menus.find((candidate) => candidate.id === menuId)!
}

function button(menuId: string, buttonId: string) {
  return menu(menuId).groups.flatMap((group) => group.buttons)
    .find((candidate) => candidate.id === buttonId)!
}

describe('bundled action pad', () => {
  it('keeps the reviewed 12-menu, 30-group, 86-button starter structure', () => {
    const groups = DEFAULT_ACTION_PAD_CONFIG.menus.flatMap((candidate) => candidate.groups)

    expect(DEFAULT_ACTION_PAD_CONFIG.menus.map((candidate) => candidate.id))
      .toEqual(Object.keys(groupLayout))
    expect(Object.fromEntries(DEFAULT_ACTION_PAD_CONFIG.menus.map((candidate) => [
      candidate.id, candidate.groups.map((group) => group.id)
    ]))).toEqual(groupLayout)
    expect(groups).toHaveLength(30)
    expect(groups.flatMap((group) => group.buttons)).toHaveLength(86)
  })

  it('uses group actions for the bundled transient clusters and menus for full pages', () => {
    expect([
      button('home', 'command').tap,
      button('home', 'leader').tap,
      button('leader', 'search').tap,
      button('leader', 'window').tap,
      button('leader', 'code').tap
    ]).toEqual([
      { type: 'menu', menuId: 'command', after: 'stay' },
      { type: 'menu', menuId: 'leader', after: 'stay' },
      { type: 'menu', menuId: 'search', after: 'stay' },
      { type: 'menu', menuId: 'window', after: 'stay' },
      { type: 'menu', menuId: 'code', after: 'stay' }
    ])

    expect(['yank', 'delete', 'motions', 'text-objects'].map((buttonId) => (
      button('home', buttonId).tap
    ))).toEqual(['yank', 'delete', 'motions', 'text-objects'].map((menuId) => ({
      type: 'group', menuId, groupId: 'options', after: 'stay'
    })))
    expect(button('home', 'down')).toMatchObject({
      tap: { type: 'input', nvimInput: '<Down>', after: 'root' },
      longPress: { type: 'group', menuId: 'down-navigation', groupId: 'options', after: 'stay' }
    })
    expect(button('home', 'up')).toMatchObject({
      tap: { type: 'input', nvimInput: '<Up>', after: 'root' },
      longPress: { type: 'group', menuId: 'up-navigation', groupId: 'options', after: 'stay' }
    })
  })

  it('keeps bundled transient destinations consolidated and Back-free', () => {
    for (const menuId of transientMenuIds) {
      expect(menu(menuId).groups.map((group) => group.id)).toEqual(['options'])
      expect(menu(menuId).groups[0]?.buttons.some((candidate) => (
        candidate.id === 'back' || candidate.tap?.type === 'back' || candidate.longPress?.type === 'back'
      ))).toBe(false)
    }

    expect(['delete-num-2', 'delete-num-3', 'delete-num-4', 'delete-num-5'].map((buttonId) => (
      button('delete', buttonId).styles?.size
    ))).toEqual(['1/4', '1/4', '1/4', '1/4'])
    expect(['five-lines-up', 'ten-lines-up'].map((buttonId) => (
      button('up-navigation', buttonId).styles?.size
    ))).toEqual(['1/4', '1/4'])
    expect(['five-lines-down', 'ten-lines-down'].map((buttonId) => (
      button('down-navigation', buttonId).styles?.size
    ))).toEqual(['1/4', '1/4'])
  })
})
