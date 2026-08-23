import {
  ACTION_PAD_MENU,
  MAX_NVIM_INPUT_LENGTH,
  validateActionMenu,
  type ActionMenu
} from '..'

function validMenu(): ActionMenu {
  return {
    id: 'root',
    label: 'Home',
    afterInput: 'root',
    groups: {
      leading: [{ id: 'escape', label: 'Esc', type: 'key', key: 'Escape' }],
      trailing: [{ id: 'save', label: 'Save', type: 'input', nvimInput: ':w<CR>' }]
    }
  }
}

function menuActions(menu: ActionMenu) {
  return [...menu.groups.leading, ...menu.groups.trailing]
}

describe('validateActionMenu', () => {
  it('accepts a valid typed leading/trailing tree', () => {
    expect(() => validateActionMenu(validMenu())).not.toThrow()
  })

  it.each([
    ['menu id', { ...validMenu(), id: ' ' }, /root\.id must be a non-empty string/],
    ['menu label', { ...validMenu(), label: '' }, /root\.label must be a non-empty string/],
    [
      'action id',
      { ...validMenu(), groups: { leading: [{ id: '', label: 'Esc', type: 'key', key: 'Escape' }], trailing: [] } },
      /\.id must be a non-empty string/
    ],
    [
      'action label',
      { ...validMenu(), groups: { leading: [{ id: 'escape', label: ' ', type: 'key', key: 'Escape' }], trailing: [] } },
      /\.label must be a non-empty string/
    ],
    [
      'native key input',
      { ...validMenu(), groups: { leading: [{ id: 'escape', label: 'Esc', type: 'key', key: '' }], trailing: [] } },
      /\.key must be a non-empty string/
    ],
    [
      'unsupported native key name',
      { ...validMenu(), groups: { leading: [{ id: 'escape', label: 'Esc', type: 'key', key: 'Esc' }], trailing: [] } },
      /\.key must be a supported native key name/
    ],
    [
      'raw Neovim input',
      { ...validMenu(), groups: { leading: [{ id: 'save', label: 'Save', type: 'input', nvimInput: '' }], trailing: [] } },
      /\.nvimInput must be a non-empty string/
    ],
    [
      'action type',
      { ...validMenu(), groups: { leading: [{ id: 'bad', label: 'Bad', type: 'unknown' }], trailing: [] } },
      /type is not a supported action type/
    ]
  ])('rejects an invalid %s', (_name, menu, message) => {
    expect(() => validateActionMenu(menu)).toThrow(message as RegExp)
  })

  it('uses the active built-in Neovim mappings for code actions', () => {
    const leader = menuActions(ACTION_PAD_MENU).find((action) => action.id === 'leader')
    if (leader?.type !== 'menu') throw new Error('Leader menu is missing')
    const code = menuActions(leader.menu).find((action) => action.id === 'code')
    if (code?.type !== 'menu') throw new Error('Code menu is missing')

    const inputs = Object.fromEntries(
      menuActions(code.menu)
        .filter((action) => action.type === 'input')
        .map((action) => [action.id, action.nvimInput])
    )
    expect(inputs).toMatchObject({
      'code-action': 'gra',
      rename: 'grn',
      diagnostic: '<C-w>d'
    })
  })

  it('requires leading and trailing arrays with at most six configured actions each', () => {
    expect(() => validateActionMenu({ ...validMenu(), groups: { leading: [] } })).toThrow(
      /groups must contain exactly "leading" and "trailing"/
    )

    expect(() => validateActionMenu({
      ...validMenu(),
      groups: { ...validMenu().groups, extra: [] }
    })).toThrow(/groups must contain exactly "leading" and "trailing"/)

    const sevenActions = Array.from({ length: 7 }, (_, index) => ({
      id: `action-${index}`,
      label: `Action ${index}`,
      type: 'input',
      nvimInput: 'x'
    }))
    expect(() => validateActionMenu({ ...validMenu(), groups: { leading: sevenActions, trailing: [] } })).toThrow(
      /at most 6 actions/
    )
  })

  it('reserves the sixth trailing slot in a nested menu for generated Back', () => {
    const child = {
      id: 'child',
      label: 'Child',
      afterInput: 'stay',
      groups: {
        leading: [],
        trailing: Array.from({ length: 6 }, (_, index) => ({
          id: `child-${index}`,
          label: `Child ${index}`,
          type: 'input',
          nvimInput: 'x'
        }))
      }
    }
    const root = {
      ...validMenu(),
      groups: {
        leading: [{ id: 'open-child', label: 'Child', type: 'menu', menu: child }],
        trailing: []
      }
    }

    expect(() => validateActionMenu(root)).toThrow(/at most 5 actions \(one slot is reserved for Back\)/)
  })

  it('rejects duplicate sibling IDs even when they are in different groups', () => {
    const duplicate = {
      ...validMenu(),
      groups: {
        leading: [{ id: 'same', label: 'First', type: 'input', nvimInput: 'a' }],
        trailing: [{ id: 'same', label: 'Second', type: 'input', nvimInput: 'b' }]
      }
    }

    expect(() => validateActionMenu(duplicate)).toThrow(/duplicate action id "same"/)
  })

  it('enforces the 16,384-character Neovim input limit', () => {
    const atLimit = {
      ...validMenu(),
      groups: { leading: [{ id: 'input', label: 'Input', type: 'input', nvimInput: 'x'.repeat(MAX_NVIM_INPUT_LENGTH) }], trailing: [] }
    }
    const overLimit = {
      ...validMenu(),
      groups: { leading: [{ id: 'input', label: 'Input', type: 'input', nvimInput: 'x'.repeat(MAX_NVIM_INPUT_LENGTH + 1) }], trailing: [] }
    }

    expect(() => validateActionMenu(atLimit)).not.toThrow()
    expect(() => validateActionMenu(overLimit)).toThrow(/must not exceed 16384 characters/)
  })
})
