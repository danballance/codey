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
    rows: [
      [{ id: 'escape', label: 'Esc', type: 'key', key: 'Escape' }],
      [{ id: 'save', label: 'Save', type: 'input', nvimInput: ':w<CR>' }]
    ]
  }
}

describe('validateActionMenu', () => {
  it('accepts a valid typed two-row tree', () => {
    expect(() => validateActionMenu(validMenu())).not.toThrow()
  })

  it.each([
    ['menu id', { ...validMenu(), id: ' ' }, /root\.id must be a non-empty string/],
    ['menu label', { ...validMenu(), label: '' }, /root\.label must be a non-empty string/],
    [
      'action id',
      { ...validMenu(), rows: [[{ id: '', label: 'Esc', type: 'key', key: 'Escape' }], []] },
      /\.id must be a non-empty string/
    ],
    [
      'action label',
      { ...validMenu(), rows: [[{ id: 'escape', label: ' ', type: 'key', key: 'Escape' }], []] },
      /\.label must be a non-empty string/
    ],
    [
      'native key input',
      { ...validMenu(), rows: [[{ id: 'escape', label: 'Esc', type: 'key', key: '' }], []] },
      /\.key must be a non-empty string/
    ],
    [
      'unsupported native key name',
      { ...validMenu(), rows: [[{ id: 'escape', label: 'Esc', type: 'key', key: 'Esc' }], []] },
      /\.key must be a supported native key name/
    ],
    [
      'raw Neovim input',
      { ...validMenu(), rows: [[{ id: 'save', label: 'Save', type: 'input', nvimInput: '' }], []] },
      /\.nvimInput must be a non-empty string/
    ],
    [
      'action type',
      { ...validMenu(), rows: [[{ id: 'bad', label: 'Bad', type: 'unknown' }], []] },
      /type is not a supported action type/
    ]
  ])('rejects an invalid %s', (_name, menu, message) => {
    expect(() => validateActionMenu(menu)).toThrow(message as RegExp)
  })

  it('uses the active built-in Neovim mappings for code actions', () => {
    const leader = ACTION_PAD_MENU.rows.flat().find((action) => action.id === 'leader')
    if (leader?.type !== 'menu') throw new Error('Leader menu is missing')
    const code = leader.menu.rows.flat().find((action) => action.id === 'code')
    if (code?.type !== 'menu') throw new Error('Code menu is missing')

    const inputs = Object.fromEntries(
      code.menu.rows
        .flat()
        .filter((action) => action.type === 'input')
        .map((action) => [action.id, action.nvimInput])
    )
    expect(inputs).toMatchObject({
      'code-action': 'gra',
      rename: 'grn',
      diagnostic: '<C-w>d'
    })
  })

  it('requires exactly two rows and at most six configured actions in each root row', () => {
    expect(() => validateActionMenu({ ...validMenu(), rows: [[]] })).toThrow(
      /must contain exactly 2 rows/
    )

    const sevenActions = Array.from({ length: 7 }, (_, index) => ({
      id: `action-${index}`,
      label: `Action ${index}`,
      type: 'input',
      nvimInput: 'x'
    }))
    expect(() => validateActionMenu({ ...validMenu(), rows: [sevenActions, []] })).toThrow(
      /at most 6 actions/
    )
  })

  it('reserves the sixth slot in a nested second row for generated Back', () => {
    const child = {
      id: 'child',
      label: 'Child',
      afterInput: 'stay',
      rows: [
        [],
        Array.from({ length: 6 }, (_, index) => ({
          id: `child-${index}`,
          label: `Child ${index}`,
          type: 'input',
          nvimInput: 'x'
        }))
      ]
    }
    const root = {
      ...validMenu(),
      rows: [[{ id: 'open-child', label: 'Child', type: 'menu', menu: child }], []]
    }

    expect(() => validateActionMenu(root)).toThrow(/at most 5 actions \(one slot is reserved for Back\)/)
  })

  it('rejects duplicate sibling IDs even when they are in different rows', () => {
    const duplicate = {
      ...validMenu(),
      rows: [
        [{ id: 'same', label: 'First', type: 'input', nvimInput: 'a' }],
        [{ id: 'same', label: 'Second', type: 'input', nvimInput: 'b' }]
      ]
    }

    expect(() => validateActionMenu(duplicate)).toThrow(/duplicate action id "same"/)
  })

  it('enforces the 16,384-character Neovim input limit', () => {
    const atLimit = {
      ...validMenu(),
      rows: [[{ id: 'input', label: 'Input', type: 'input', nvimInput: 'x'.repeat(MAX_NVIM_INPUT_LENGTH) }], []]
    }
    const overLimit = {
      ...validMenu(),
      rows: [[{ id: 'input', label: 'Input', type: 'input', nvimInput: 'x'.repeat(MAX_NVIM_INPUT_LENGTH + 1) }], []]
    }

    expect(() => validateActionMenu(atLimit)).not.toThrow()
    expect(() => validateActionMenu(overLimit)).toThrow(/must not exceed 16384 characters/)
  })
})
