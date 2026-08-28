import { validateActionPadConfig, type ActionPadConfig } from '../document'
import {
  ActionPadEditError,
  analyzeActionPadMenus,
  createActionPadId,
  editActionPad,
  groupDeletionReason,
  menuDeletionReason
} from '../editing'

function config(): ActionPadConfig {
  return {
    version: 1,
    rootMenuId: 'home',
    menus: [
      {
        id: 'home', label: 'Home', groups: [
          {
            id: 'actions', buttons: [
              { id: 'input', label: 'Input', tap: { type: 'input', nvimInput: 'x', after: 'stay' } },
              {
                id: 'open', label: 'Open',
                tap: { type: 'menu', menuId: 'child', after: 'stay' },
                longPress: { type: 'menu', menuId: 'child', after: 'root' }
              }
            ]
          },
          { id: 'other', buttons: [{ id: 'input', label: 'Other', tap: { type: 'keyboard', after: 'stay' } }] }
        ]
      },
      {
        id: 'child', label: 'Child', groups: [
          { id: 'actions', buttons: [{ id: 'back', label: 'Back', tap: { type: 'back', after: 'stay' } }] }
        ]
      },
      { id: 'unused', label: 'Unused', groups: [] }
    ]
  }
}

function configWithGroupLink(): ActionPadConfig {
  const value = config()
  return {
    ...value,
    menus: value.menus.map((menu, menuIndex) => menuIndex !== 0 ? menu : ({
      ...menu,
      groups: menu.groups.map((group, groupIndex) => groupIndex !== 0 ? group : ({
        ...group,
        buttons: group.buttons.map((button, buttonIndex) => buttonIndex !== 1 ? button : ({
          ...button,
          tap: { type: 'group', menuId: 'child', groupId: 'actions', after: 'stay' },
          longPress: { type: 'group', menuId: 'child', groupId: 'actions', after: 'root' }
        }))
      }))
    }))
  }
}

describe('Action Pad edits', () => {
  it('generates unused IDs once and leaves IDs unchanged when labels change', () => {
    expect(createActionPadId('menu', ['menu', 'menu-2', 'menu-4'])).toBe('menu-3')
    let next = editActionPad(config(), { type: 'add-menu' })
    next = editActionPad(next, { type: 'update-menu', menuIndex: 3, patch: { label: 'Custom label' } })
    expect(next.menus[3]).toEqual({ id: 'menu', label: 'Custom label', groups: [] })
    next = editActionPad(next, { type: 'add-menu' })
    expect(next.menus[4]?.id).toBe('menu-2')
  })

  it('creates ordered groups and an incomplete button that must be configured before saving', () => {
    let next = editActionPad(config(), { type: 'add-group', menuIndex: 2 })
    next = editActionPad(next, { type: 'add-group', menuIndex: 2 })
    expect(next.menus[2]?.groups.map((group) => group.id)).toEqual(['group', 'group-2'])
    next = editActionPad(next, { type: 'add-button', location: { menuIndex: 2, groupIndex: 0 } })
    expect(validateActionPadConfig(next)).toContainEqual({
      path: 'menus[2].groups[0].buttons[0].tap.nvimInput', message: 'Must not be empty.'
    })
    next = editActionPad(next, {
      type: 'update-button', location: { menuIndex: 2, groupIndex: 0, buttonIndex: 0 },
      patch: { tap: { type: 'input', nvimInput: '<Esc>', after: 'stay' } }
    })
    expect(validateActionPadConfig(next)).toEqual([])
  })

  it('renames root IDs and both tap and hold references without changing the original config', () => {
    const original = config()
    const before = JSON.stringify(original)
    let renamed = editActionPad(original, { type: 'update-menu', menuIndex: 1, patch: { id: 'tools' } })
    const button = renamed.menus[0]?.groups[0]?.buttons[1]
    expect(button?.tap).toEqual({ type: 'menu', menuId: 'tools', after: 'stay' })
    expect(button?.longPress).toEqual({ type: 'menu', menuId: 'tools', after: 'root' })
    renamed = editActionPad(renamed, { type: 'update-menu', menuIndex: 0, patch: { id: 'start' } })
    expect(renamed.rootMenuId).toBe('start')
    expect(validateActionPadConfig(renamed)).toEqual([])
    expect(JSON.stringify(original)).toBe(before)
  })

  it('renames destination menus and groups in both group-action gesture slots', () => {
    const original = configWithGroupLink()
    const before = JSON.stringify(original)

    let next = editActionPad(original, { type: 'update-menu', menuIndex: 1, patch: { id: 'tools' } })
    expect(next.menus[0]?.groups[0]?.buttons[1]).toMatchObject({
      tap: { type: 'group', menuId: 'tools', groupId: 'actions', after: 'stay' },
      longPress: { type: 'group', menuId: 'tools', groupId: 'actions', after: 'root' }
    })
    next = editActionPad(next, {
      type: 'update-group',
      location: { menuIndex: 1, groupIndex: 0 },
      id: 'options'
    })
    expect(next.menus[0]?.groups[0]?.buttons[1]).toMatchObject({
      tap: { type: 'group', menuId: 'tools', groupId: 'options', after: 'stay' },
      longPress: { type: 'group', menuId: 'tools', groupId: 'options', after: 'root' }
    })
    expect(validateActionPadConfig(next)).toEqual([])
    expect(JSON.stringify(original)).toBe(before)
  })

  it('repairs duplicate recovery IDs without guessing which ambiguous links to retarget', () => {
    const menuDraft = config()
    const duplicateMenu: ActionPadConfig = {
      ...menuDraft,
      menus: [
        ...menuDraft.menus,
        { id: 'child', label: 'Duplicate child', groups: [] }
      ]
    }
    const renamedMenu = editActionPad(duplicateMenu, {
      type: 'update-menu', menuIndex: 1, patch: { id: 'tools' }
    })
    expect(renamedMenu.menus[0]?.groups[0]?.buttons[1]).toMatchObject({
      tap: { type: 'menu', menuId: 'child' },
      longPress: { type: 'menu', menuId: 'child' }
    })
    expect(validateActionPadConfig(renamedMenu)).toEqual([])

    const groupDraft = configWithGroupLink()
    const child = groupDraft.menus[1]!
    const duplicateGroup: ActionPadConfig = {
      ...groupDraft,
      menus: groupDraft.menus.map((menu, index) => index !== 1 ? menu : ({
        ...child,
        groups: [...child.groups, { id: 'actions', buttons: [] }]
      }))
    }
    const renamedGroup = editActionPad(duplicateGroup, {
      type: 'update-group', location: { menuIndex: 1, groupIndex: 0 }, id: 'options'
    })
    expect(renamedGroup.menus[0]?.groups[0]?.buttons[1]).toMatchObject({
      tap: { type: 'group', menuId: 'child', groupId: 'actions' },
      longPress: { type: 'group', menuId: 'child', groupId: 'actions' }
    })
    expect(validateActionPadConfig(renamedGroup)).toEqual([])
  })

  it('blocks an ambiguous menu rename before any links change', () => {
    const original = config()
    expect(() => editActionPad(original, { type: 'update-menu', menuIndex: 0, patch: { id: 'child' } })).toThrow(ActionPadEditError)
    expect(original.rootMenuId).toBe('home')
    expect(original.menus[0]?.groups[0]?.buttons[1]?.tap).toEqual({ type: 'menu', menuId: 'child', after: 'stay' })
  })

  it('keeps references intact through temporarily blank IDs', () => {
    let next = editActionPad(config(), { type: 'update-menu', menuIndex: 1, patch: { id: '' } })
    expect(validateActionPadConfig(next).length).toBeGreaterThan(0)
    next = editActionPad(next, { type: 'update-menu', menuIndex: 1, patch: { id: 'renamed' } })
    expect(next.menus[0]?.groups[0]?.buttons[1]?.longPress).toMatchObject({ menuId: 'renamed' })
    expect(validateActionPadConfig(next)).toEqual([])
  })

  it('protects root and referenced menus until their dependencies are resolved', () => {
    const original = config()
    expect(menuDeletionReason(original, 0)).toMatch(/another root/)
    expect(menuDeletionReason(original, 1)).toMatch(/Home/)
    expect(() => editActionPad(original, { type: 'delete-menu', menuIndex: 0 })).toThrow(/root/)
    expect(() => editActionPad(original, { type: 'delete-menu', menuIndex: 1 })).toThrow(/links/)
    let next = editActionPad(original, { type: 'set-root-menu', menuIndex: 2 })
    next = editActionPad(next, { type: 'delete-menu', menuIndex: 0 })
    expect(next.rootMenuId).toBe('unused')
    expect(next.menus.map((menu) => menu.id)).toEqual(['child', 'unused'])
    next = editActionPad(next, { type: 'delete-menu', menuIndex: 0 })
    expect(next.menus.map((menu) => menu.id)).toEqual(['unused'])
  })

  it('protects menus and groups referenced by group interactions', () => {
    const original = configWithGroupLink()
    const childGroup = { menuIndex: 1, groupIndex: 0 }

    expect(menuDeletionReason(original, 1)).toBe('Remove menu links from Home before deleting this menu.')
    expect(groupDeletionReason(original, childGroup)).toBe('Remove group links from Home before deleting this group.')
    expect(() => editActionPad(original, { type: 'delete-menu', menuIndex: 1 })).toThrow(/menu links/)
    expect(() => editActionPad(original, { type: 'delete-group', location: childGroup })).toThrow(/group links/)

    const unlinked = editActionPad(original, {
      type: 'update-button',
      location: { menuIndex: 0, groupIndex: 0, buttonIndex: 1 },
      patch: {
        tap: { type: 'input', nvimInput: 'x', after: 'stay' },
        longPress: undefined
      }
    })
    expect(groupDeletionReason(unlinked, childGroup)).toBeUndefined()
    expect(editActionPad(unlinked, { type: 'delete-group', location: childGroup }).menus[1]?.groups).toEqual([])
  })

  it('analyzes exact incoming menu references and root reachability through both gestures and target types', () => {
    const value = configWithGroupLink()
    const child = value.menus[1]!
    const withLeaf: ActionPadConfig = {
      ...value,
      menus: [
        value.menus[0]!,
        {
          ...child,
          groups: child.groups.map((group) => ({
            ...group,
            buttons: group.buttons.map((button) => ({
              ...button,
              longPress: { type: 'menu', menuId: 'leaf', after: 'stay' }
            }))
          }))
        },
        value.menus[2]!,
        { id: 'leaf', label: 'Leaf', groups: [] }
      ]
    }

    expect(analyzeActionPadMenus(withLeaf)).toEqual([
      { menuIndex: 0, reachable: true, incoming: [] },
      {
        menuIndex: 1,
        reachable: true,
        incoming: [
          {
            location: { menuIndex: 0, groupIndex: 0, buttonIndex: 1 },
            gesture: 'tap', interactionType: 'group'
          },
          {
            location: { menuIndex: 0, groupIndex: 0, buttonIndex: 1 },
            gesture: 'longPress', interactionType: 'group'
          }
        ]
      },
      { menuIndex: 2, reachable: false, incoming: [] },
      {
        menuIndex: 3,
        reachable: true,
        incoming: [{
          location: { menuIndex: 1, groupIndex: 0, buttonIndex: 0 },
          gesture: 'longPress', interactionType: 'menu'
        }]
      }
    ])
  })

  it('excludes references originating inside the target menu from incoming references', () => {
    const value = config()
    const child = value.menus[1]!
    const selfLinked: ActionPadConfig = {
      ...value,
      menus: value.menus.map((menu, menuIndex) => menuIndex !== 1 ? menu : ({
        ...child,
        groups: child.groups.map((group) => ({
          ...group,
          buttons: group.buttons.map((button) => ({
            ...button,
            longPress: { type: 'menu', menuId: 'child', after: 'stay' }
          }))
        }))
      }))
    }

    expect(analyzeActionPadMenus(selfLinked)[1]?.incoming).toEqual([
      {
        location: { menuIndex: 0, groupIndex: 0, buttonIndex: 1 },
        gesture: 'tap', interactionType: 'menu'
      },
      {
        location: { menuIndex: 0, groupIndex: 0, buttonIndex: 1 },
        gesture: 'longPress', interactionType: 'menu'
      }
    ])
  })

  it('atomically deletes every unreachable menu, including a subtree with internal links', () => {
    const value = config()
    const original: ActionPadConfig = {
      ...value,
      menus: [
        ...value.menus,
        {
          id: 'orphan-parent', label: 'Orphan parent', groups: [{
            id: 'actions', buttons: [{
              id: 'open-child', label: 'Open child',
              tap: { type: 'menu', menuId: 'orphan-child', after: 'stay' }
            }]
          }]
        },
        { id: 'orphan-child', label: 'Orphan child', groups: [] }
      ]
    }
    const before = JSON.stringify(original)

    expect(menuDeletionReason(original, 4)).toMatch(/Orphan parent/)
    const next = editActionPad(original, { type: 'delete-unused-menus' })

    expect(next.menus.map((menu) => menu.id)).toEqual(['home', 'child'])
    expect(next.rootMenuId).toBe('home')
    expect(validateActionPadConfig(next)).toEqual([])
    expect(JSON.stringify(original)).toBe(before)
  })

  it('preserves menus reachable only through hold and group interactions when deleting unused menus', () => {
    const value = configWithGroupLink()
    const home = value.menus[0]!
    const holdOnly: ActionPadConfig = {
      ...value,
      menus: value.menus.map((menu, menuIndex) => menuIndex !== 0 ? menu : ({
        ...home,
        groups: home.groups.map((group, groupIndex) => groupIndex !== 0 ? group : ({
          ...group,
          buttons: group.buttons.map((button, buttonIndex) => buttonIndex !== 1 ? button : ({
            ...button,
            tap: { type: 'input', nvimInput: 'x', after: 'stay' }
          }))
        }))
      }))
    }

    const next = editActionPad(holdOnly, { type: 'delete-unused-menus' })
    expect(next.menus.map((menu) => menu.id)).toEqual(['home', 'child'])
  })

  it('returns the original config when every menu is reachable', () => {
    const value = config()
    const withoutUnused: ActionPadConfig = { ...value, menus: value.menus.slice(0, 2) }
    expect(editActionPad(withoutUnused, { type: 'delete-unused-menus' })).toBe(withoutUnused)
  })

  it('rejects unused-menu deletion for semantically invalid drafts', () => {
    const value = config()
    const invalid: ActionPadConfig = { ...value, rootMenuId: 'missing' }
    const before = JSON.stringify(invalid)

    expect(() => editActionPad(invalid, { type: 'delete-unused-menus' })).toThrow(
      'Resolve all configuration issues before removing unused menus.'
    )
    expect(JSON.stringify(invalid)).toBe(before)
  })

  it('reorders menus, groups and buttons without changing their contents or root', () => {
    const original = config()
    let next = editActionPad(original, { type: 'reorder-menu', menuIndex: 0, direction: 1 })
    expect(next.menus.map((menu) => menu.id)).toEqual(['child', 'home', 'unused'])
    expect(next.rootMenuId).toBe('home')
    next = editActionPad(next, { type: 'reorder-group', location: { menuIndex: 1, groupIndex: 0 }, direction: 1 })
    expect(next.menus[1]?.groups.map((group) => group.id)).toEqual(['other', 'actions'])
    next = editActionPad(next, { type: 'reorder-button', location: { menuIndex: 1, groupIndex: 1, buttonIndex: 0 }, direction: 1 })
    expect(next.menus[1]?.groups[1]?.buttons).toEqual([...original.menus[0]!.groups[0]!.buttons].reverse())
    expect(editActionPad(next, { type: 'reorder-menu', menuIndex: 0, direction: -1 }).menus).toBe(next.menus)
    expect(editActionPad(next, { type: 'reorder-button', location: { menuIndex: 1, groupIndex: 1, buttonIndex: 1 }, direction: 1 }).menus[1]?.groups[1]?.buttons).toBe(next.menus[1]?.groups[1]?.buttons)
  })

  it('renames and deletes groups, rejecting IDs already used in the same menu', () => {
    const location = { menuIndex: 0, groupIndex: 0 }
    expect(() => editActionPad(config(), { type: 'update-group', location, id: 'other' })).toThrow(/already exists/)
    let next = editActionPad(config(), { type: 'update-group', location, id: 'renamed' })
    expect(next.menus[0]?.groups[0]?.id).toBe('renamed')
    next = editActionPad(next, { type: 'delete-group', location })
    expect(next.menus[0]?.groups.map((group) => group.id)).toEqual(['other'])
  })

  it('retains exact input and all button fields while allowing independent gesture removal', () => {
    const location = { menuIndex: 0, groupIndex: 0, buttonIndex: 0 }
    const input = '  <C-\\><C-n>\n0\t\uf07c🙂  '
    let next = editActionPad(config(), {
      type: 'update-button', location,
      patch: {
        label: '001', accessibilityLabel: 'Run command', accessibilityHint: 'Hold for more',
        styles: { size: '1/4' }, tap: { type: 'input', nvimInput: input, after: 'root' },
        longPress: { type: 'keyboard', after: 'stay' }
      }
    })
    expect(next.menus[0]?.groups[0]?.buttons[0]).toMatchObject({
      id: 'input', label: '001', styles: { size: '1/4' },
      tap: { type: 'input', nvimInput: input, after: 'root' }, longPress: { type: 'keyboard', after: 'stay' }
    })
    next = editActionPad(next, { type: 'update-button', location, patch: { tap: undefined, styles: undefined, accessibilityLabel: undefined, accessibilityHint: undefined } })
    expect(next.menus[0]?.groups[0]?.buttons[0]).toEqual({ id: 'input', label: '001', longPress: { type: 'keyboard', after: 'stay' } })
    expect(validateActionPadConfig(next)).toEqual([])
    next = editActionPad(next, { type: 'update-button', location, patch: { longPress: undefined } })
    expect(validateActionPadConfig(next)).toContainEqual({ path: 'menus[0].groups[0].buttons[0].tap', message: 'A button must define tap or longPress.' })
  })

  it('duplicates every button field independently immediately after the source', () => {
    const location = { menuIndex: 0, groupIndex: 0, buttonIndex: 0 }
    const original = editActionPad(config(), {
      type: 'update-button', location,
      patch: {
        accessibilityLabel: 'Run input', accessibilityHint: 'Hold to open the child menu',
        styles: { size: '1/4' }, longPress: { type: 'menu', menuId: 'child', after: 'root' }
      }
    })
    const source = original.menus[0]!.groups[0]!.buttons[0]!
    const before = JSON.stringify(original)

    const next = editActionPad(original, { type: 'duplicate-button', location })
    const buttons = next.menus[0]!.groups[0]!.buttons
    const duplicate = buttons[1]!

    expect(buttons.map((button) => button.id)).toEqual(['input', 'input-2', 'open'])
    expect(duplicate).toEqual({ ...source, id: 'input-2', label: 'Input copy' })
    expect(buttons[0]).toBe(source)
    expect(duplicate).not.toBe(source)
    expect(duplicate.tap).not.toBe(source.tap)
    expect(duplicate.longPress).not.toBe(source.longPress)
    expect(duplicate.styles).not.toBe(source.styles)
    expect(JSON.stringify(original)).toBe(before)
  })

  it('generates duplicate IDs across the selected menu and through repeated duplication', () => {
    const location = { menuIndex: 0, groupIndex: 0, buttonIndex: 0 }
    let next = editActionPad(config(), {
      type: 'update-button', location: { menuIndex: 0, groupIndex: 1, buttonIndex: 0 }, patch: { id: 'input-2' }
    })

    next = editActionPad(next, { type: 'duplicate-button', location })
    expect(next.menus[0]?.groups[0]?.buttons.map((button) => button.id)).toEqual(['input', 'input-3', 'open'])
    next = editActionPad(next, { type: 'duplicate-button', location })
    expect(next.menus[0]?.groups[0]?.buttons.map((button) => button.id)).toEqual(['input', 'input-4', 'input-3', 'open'])
  })

  it('moves within a menu and across menus without cloning or changing the moved button', () => {
    const original = editActionPad(config(), { type: 'add-group', menuIndex: 2 })
    const moved = original.menus[0]!.groups[0]!.buttons[0]
    let next = editActionPad(original, {
      type: 'move-button', location: { menuIndex: 0, groupIndex: 0, buttonIndex: 0 },
      destination: { menuIndex: 2, groupIndex: 0 }
    })
    expect(next.menus[0]?.groups[0]?.buttons.map((button) => button.id)).toEqual(['open'])
    expect(next.menus[2]?.groups[0]?.buttons[0]).toBe(moved)
    next = editActionPad(next, {
      type: 'move-button', location: { menuIndex: 0, groupIndex: 0, buttonIndex: 0 },
      destination: { menuIndex: 0, groupIndex: 1 }
    })
    expect(next.menus[0]?.groups[0]?.buttons).toEqual([])
    expect(next.menus[0]?.groups[1]?.buttons.map((button) => button.id)).toEqual(['input', 'open'])
    expect(original.menus[0]?.groups[0]?.buttons).toHaveLength(2)
  })

  it('blocks destination collisions but permits the same ID in different groups', () => {
    const original = config()
    expect(validateActionPadConfig(original)).toEqual([])
    expect(() => editActionPad(original, {
      type: 'move-button', location: { menuIndex: 0, groupIndex: 0, buttonIndex: 0 },
      destination: { menuIndex: 0, groupIndex: 1 }
    })).toThrow(/Rename this button/)
    expect(() => editActionPad(original, {
      type: 'update-button', location: { menuIndex: 0, groupIndex: 0, buttonIndex: 0 }, patch: { id: 'open' }
    })).toThrow(/already exists/)
  })

  it('deletes a button and rejects stale locations without changing other items', () => {
    const original = config()
    const next = editActionPad(original, { type: 'delete-button', location: { menuIndex: 0, groupIndex: 0, buttonIndex: 0 } })
    expect(next.menus[0]?.groups[0]?.buttons.map((button) => button.id)).toEqual(['open'])
    expect(original.menus[0]?.groups[0]?.buttons).toHaveLength(2)
    expect(() => editActionPad(next, { type: 'delete-button', location: { menuIndex: 0, groupIndex: 0, buttonIndex: 8 } })).toThrow(/no longer exists/)
    expect(() => editActionPad(next, { type: 'delete-menu', menuIndex: 9 })).toThrow(/no longer exists/)
  })

  it('rejects a stale duplicate location without changing the config', () => {
    const original = config()
    const before = JSON.stringify(original)
    expect(() => editActionPad(original, {
      type: 'duplicate-button', location: { menuIndex: 0, groupIndex: 0, buttonIndex: 8 }
    })).toThrow(/This button no longer exists/)
    expect(JSON.stringify(original)).toBe(before)
  })
})
