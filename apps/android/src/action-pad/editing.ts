import { validateActionPadConfig, type ActionPadConfig } from './document'
import { mergeActionButtonStyles } from './style'
import type { ActionButtonLabel, ActionButtonStyles } from './types'

export type EditableMenu = ActionPadConfig['menus'][number]
export type EditableGroup = EditableMenu['groups'][number]
export type EditableButton = EditableGroup['buttons'][number]
export type EditableInteraction = NonNullable<EditableButton['tap']>

export interface GroupLocation {
  readonly menuIndex: number
  readonly groupIndex: number
}

export interface ButtonLocation extends GroupLocation {
  readonly buttonIndex: number
}

export interface MenuReference {
  readonly location: ButtonLocation
  readonly gesture: 'tap' | 'longPress'
  readonly interactionType: 'menu' | 'group'
}

export interface MenuAnalysis {
  readonly menuIndex: number
  readonly reachable: boolean
  readonly incoming: readonly MenuReference[]
}

export type EditableButtonPatch = Omit<Partial<EditableButton>, 'styles'> & {
  readonly styles?: Partial<ActionButtonStyles>
}

export type ActionPadEdit =
  | { readonly type: 'add-menu' }
  | { readonly type: 'update-menu'; readonly menuIndex: number; readonly patch: Partial<Pick<EditableMenu, 'id' | 'label'>> }
  | { readonly type: 'delete-menu'; readonly menuIndex: number }
  | { readonly type: 'delete-unused-menus' }
  | { readonly type: 'reorder-menu'; readonly menuIndex: number; readonly direction: -1 | 1 }
  | { readonly type: 'set-root-menu'; readonly menuIndex: number }
  | { readonly type: 'add-group'; readonly menuIndex: number }
  | { readonly type: 'update-group'; readonly location: GroupLocation; readonly id: string }
  | { readonly type: 'delete-group'; readonly location: GroupLocation }
  | { readonly type: 'reorder-group'; readonly location: GroupLocation; readonly direction: -1 | 1 }
  | { readonly type: 'add-button'; readonly location: GroupLocation }
  | { readonly type: 'duplicate-button'; readonly location: ButtonLocation }
  | { readonly type: 'update-button'; readonly location: ButtonLocation; readonly patch: EditableButtonPatch }
  | { readonly type: 'delete-button'; readonly location: ButtonLocation }
  | { readonly type: 'reorder-button'; readonly location: ButtonLocation; readonly direction: -1 | 1 }
  | { readonly type: 'move-button'; readonly location: ButtonLocation; readonly destination: GroupLocation }

export class ActionPadEditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActionPadEditError'
  }
}

/** IDs are generated once when an item is created, never derived from its label. */
export function createActionPadId(prefix: string, existingIds: readonly string[]): string {
  const ids = new Set(existingIds)
  if (!ids.has(prefix)) return prefix
  let suffix = 2
  while (ids.has(`${prefix}-${suffix}`)) suffix += 1
  return `${prefix}-${suffix}`
}

export function analyzeActionPadMenus(config: ActionPadConfig): readonly MenuAnalysis[] {
  const indexesById = new Map<string, number[]>()
  config.menus.forEach((menu, menuIndex) => {
    const indexes = indexesById.get(menu.id) ?? []
    indexes.push(menuIndex)
    indexesById.set(menu.id, indexes)
  })

  const incoming = config.menus.map(() => [] as MenuReference[])
  config.menus.forEach((menu, menuIndex) => {
    menu.groups.forEach((group, groupIndex) => {
      group.buttons.forEach((button, buttonIndex) => {
        for (const gesture of ['tap', 'longPress'] as const) {
          const interaction = button[gesture]
          if (interaction?.type !== 'menu' && interaction?.type !== 'group') continue
          for (const targetIndex of indexesById.get(interaction.menuId) ?? []) {
            if (targetIndex === menuIndex) continue
            incoming[targetIndex]!.push({
              location: { menuIndex, groupIndex, buttonIndex },
              gesture,
              interactionType: interaction.type
            })
          }
        }
      })
    })
  })

  const reachable = new Set<number>()
  const pending = [...(indexesById.get(config.rootMenuId) ?? [])]
  while (pending.length > 0) {
    const menuIndex = pending.pop()!
    if (reachable.has(menuIndex)) continue
    reachable.add(menuIndex)
    const menu = config.menus[menuIndex]
    if (!menu) continue
    for (const group of menu.groups) {
      for (const button of group.buttons) {
        for (const gesture of ['tap', 'longPress'] as const) {
          const interaction = button[gesture]
          if (interaction?.type !== 'menu' && interaction?.type !== 'group') continue
          pending.push(...(indexesById.get(interaction.menuId) ?? []))
        }
      }
    }
  }

  return config.menus.map((_, menuIndex) => ({
    menuIndex,
    reachable: reachable.has(menuIndex),
    incoming: incoming[menuIndex]!
  }))
}

export function menuDeletionReason(config: ActionPadConfig, menuIndex: number): string | undefined {
  const menu = requireMenu(config, menuIndex)
  if (config.rootMenuId === menu.id) return 'Choose another root menu before deleting this menu.'
  const incoming = analyzeActionPadMenus(config)[menuIndex]!.incoming
  if (incoming.length > 0) {
    const sourceMenuIndexes = [...new Set(incoming.map((reference) => reference.location.menuIndex))]
    return `Remove menu links from ${sourceMenuIndexes.map((index) => {
      const reference = config.menus[index]!
      return reference.label || reference.id
    }).join(', ')} before deleting this menu.`
  }
  return undefined
}

export function groupDeletionReason(config: ActionPadConfig, location: GroupLocation): string | undefined {
  const menu = requireMenu(config, location.menuIndex)
  const group = requireGroup(config, location)
  const references = config.menus.filter((candidate) =>
    candidate.groups.some((candidateGroup) => candidateGroup.buttons.some((button) =>
      [button.tap, button.longPress].some((action) =>
        action?.type === 'group' && action.menuId === menu.id && action.groupId === group.id
      )
    ))
  )
  if (references.length > 0) {
    return `Remove group links from ${references.map((reference) => reference.label || reference.id).join(', ')} before deleting this group.`
  }
  return undefined
}

/** Incomplete drafts are allowed; referentially ambiguous edits are not. */
export function editActionPad(config: ActionPadConfig, edit: ActionPadEdit): ActionPadConfig {
  switch (edit.type) {
    case 'add-menu':
      return {
        ...config,
        menus: [...config.menus, {
          id: createActionPadId('menu', config.menus.map((menu) => menu.id)),
          label: 'New menu',
          groups: []
        }]
      }
    case 'update-menu': {
      const menu = requireMenu(config, edit.menuIndex)
      const newId = edit.patch.id ?? menu.id
      const sourceIdIsUnique = config.menus.filter((candidate) => candidate.id === menu.id).length === 1
      if (newId !== menu.id && config.menus.some((candidate, index) => index !== edit.menuIndex && candidate.id === newId)) {
        throw new ActionPadEditError(`A menu with ID “${newId}” already exists. Choose a unique ID.`)
      }
      const renamed = replaceMenu(config, edit.menuIndex, { ...menu, ...edit.patch })
      // Recovery drafts may contain duplicate IDs. In that case links cannot
      // identify which definition they meant, so leave them on the remaining
      // old ID while the user repairs the selected definition.
      if (newId === menu.id || !sourceIdIsUnique) return renamed
      return {
        ...renamed,
        rootMenuId: renamed.rootMenuId === menu.id ? newId : renamed.rootMenuId,
        menus: renamed.menus.map((candidate) => ({
          ...candidate,
          groups: candidate.groups.map((group) => ({
            ...group,
            buttons: group.buttons.map((button) => {
              const updated = { ...button }
              if ((button.tap?.type === 'menu' || button.tap?.type === 'group') && button.tap.menuId === menu.id) {
                updated.tap = { ...button.tap, menuId: newId }
              }
              if ((button.longPress?.type === 'menu' || button.longPress?.type === 'group') && button.longPress.menuId === menu.id) {
                updated.longPress = { ...button.longPress, menuId: newId }
              }
              return updated
            })
          }))
        }))
      }
    }
    case 'delete-menu': {
      const reason = menuDeletionReason(config, edit.menuIndex)
      if (reason) throw new ActionPadEditError(reason)
      return { ...config, menus: config.menus.filter((_, index) => index !== edit.menuIndex) }
    }
    case 'delete-unused-menus': {
      if (validateActionPadConfig(config).length > 0) {
        throw new ActionPadEditError('Resolve all configuration issues before removing unused menus.')
      }
      const analyses = analyzeActionPadMenus(config)
      if (analyses.every((analysis) => analysis.reachable)) return config
      return {
        ...config,
        menus: config.menus.filter((_, menuIndex) => analyses[menuIndex]!.reachable)
      }
    }
    case 'reorder-menu':
      requireMenu(config, edit.menuIndex)
      return { ...config, menus: reorder(config.menus, edit.menuIndex, edit.direction) }
    case 'set-root-menu':
      return { ...config, rootMenuId: requireMenu(config, edit.menuIndex).id }
    case 'add-group': {
      const menu = requireMenu(config, edit.menuIndex)
      return replaceMenu(config, edit.menuIndex, {
        ...menu,
        groups: [...menu.groups, { id: createActionPadId('group', menu.groups.map((group) => group.id)), buttons: [] }]
      })
    }
    case 'update-group': {
      const menu = requireMenu(config, edit.location.menuIndex)
      const group = requireGroup(config, edit.location)
      const sourceIdIsUnique = menu.groups.filter((candidate) => candidate.id === group.id).length === 1
      if (menu.groups.some((candidate, index) => index !== edit.location.groupIndex && candidate.id === edit.id)) {
        throw new ActionPadEditError(`A group with ID “${edit.id}” already exists in this menu.`)
      }
      const renamed = replaceGroup(config, edit.location, { ...group, id: edit.id })
      if (edit.id === group.id || !sourceIdIsUnique) return renamed
      return {
        ...renamed,
        menus: renamed.menus.map((candidate) => ({
          ...candidate,
          groups: candidate.groups.map((candidateGroup) => ({
            ...candidateGroup,
            buttons: candidateGroup.buttons.map((button) => {
              const updated = { ...button }
              if (button.tap?.type === 'group' && button.tap.menuId === menu.id && button.tap.groupId === group.id) {
                updated.tap = { ...button.tap, groupId: edit.id }
              }
              if (button.longPress?.type === 'group' && button.longPress.menuId === menu.id && button.longPress.groupId === group.id) {
                updated.longPress = { ...button.longPress, groupId: edit.id }
              }
              return updated
            })
          }))
        }))
      }
    }
    case 'delete-group': {
      const menu = requireMenu(config, edit.location.menuIndex)
      requireGroup(config, edit.location)
      const reason = groupDeletionReason(config, edit.location)
      if (reason) throw new ActionPadEditError(reason)
      return replaceMenu(config, edit.location.menuIndex, {
        ...menu,
        groups: menu.groups.filter((_, index) => index !== edit.location.groupIndex)
      })
    }
    case 'reorder-group': {
      const menu = requireMenu(config, edit.location.menuIndex)
      requireGroup(config, edit.location)
      return replaceMenu(config, edit.location.menuIndex, {
        ...menu,
        groups: reorder(menu.groups, edit.location.groupIndex, edit.direction)
      })
    }
    case 'add-button': {
      const menu = requireMenu(config, edit.location.menuIndex)
      const group = requireGroup(config, edit.location)
      return replaceGroup(config, edit.location, {
        ...group,
        buttons: [...group.buttons, {
          id: createActionPadId('button', menu.groups.flatMap((candidate) => candidate.buttons.map((button) => button.id))),
          label: 'New button',
          styles: { size: '1/2' },
          tap: { type: 'input', nvimInput: '', after: 'stay' }
        }]
      })
    }
    case 'duplicate-button': {
      const menu = requireMenu(config, edit.location.menuIndex)
      const group = requireGroup(config, edit.location)
      const button = requireButton(config, edit.location)
      const duplicate: EditableButton = {
        ...button,
        id: createActionPadId(button.id, menu.groups.flatMap((candidate) => candidate.buttons.map(({ id }) => id))),
        label: duplicateButtonLabel(button.label),
        styles: { ...button.styles },
        ...(button.tap === undefined ? {} : { tap: { ...button.tap } }),
        ...(button.longPress === undefined ? {} : { longPress: { ...button.longPress } })
      }
      return replaceGroup(config, edit.location, {
        ...group,
        buttons: [
          ...group.buttons.slice(0, edit.location.buttonIndex + 1),
          duplicate,
          ...group.buttons.slice(edit.location.buttonIndex + 1)
        ]
      })
    }
    case 'update-button': {
      const group = requireGroup(config, edit.location)
      const button = requireButton(config, edit.location)
      if (edit.patch.id !== undefined && group.buttons.some((candidate, index) => index !== edit.location.buttonIndex && candidate.id === edit.patch.id)) {
        throw new ActionPadEditError(`A button with ID “${edit.patch.id}” already exists in this group.`)
      }
      const updated = {
        ...button,
        ...edit.patch,
        styles: edit.patch.styles === undefined
          ? button.styles
          : mergeActionButtonStyles(button.styles, edit.patch.styles)
      }
      for (const optional of ['tap', 'longPress', 'accessibilityLabel', 'accessibilityHint'] as const) {
        if (updated[optional] === undefined) delete updated[optional]
      }
      return replaceGroup(config, edit.location, {
        ...group,
        buttons: group.buttons.map((candidate, index) => index === edit.location.buttonIndex ? updated : candidate)
      })
    }
    case 'delete-button': {
      const group = requireGroup(config, edit.location)
      requireButton(config, edit.location)
      return replaceGroup(config, edit.location, {
        ...group,
        buttons: group.buttons.filter((_, index) => index !== edit.location.buttonIndex)
      })
    }
    case 'reorder-button': {
      const group = requireGroup(config, edit.location)
      requireButton(config, edit.location)
      return replaceGroup(config, edit.location, {
        ...group,
        buttons: reorder(group.buttons, edit.location.buttonIndex, edit.direction)
      })
    }
    case 'move-button': {
      const source = requireGroup(config, edit.location)
      const destination = requireGroup(config, edit.destination)
      const button = requireButton(config, edit.location)
      if (edit.location.menuIndex === edit.destination.menuIndex && edit.location.groupIndex === edit.destination.groupIndex) return config
      if (destination.buttons.some((candidate) => candidate.id === button.id)) {
        throw new ActionPadEditError(`The destination already has a button with ID “${button.id}”. Rename this button before moving it.`)
      }
      const removed = replaceGroup(config, edit.location, {
        ...source,
        buttons: source.buttons.filter((_, index) => index !== edit.location.buttonIndex)
      })
      return replaceGroup(removed, edit.destination, { ...destination, buttons: [...destination.buttons, button] })
    }
  }
}

function duplicateButtonLabel(label: ActionButtonLabel): ActionButtonLabel {
  if (typeof label === 'string') return `${label} copy`

  const runs = label.map((run) => ({ ...run }))
  const lastIndex = runs.length - 1
  const last = runs[lastIndex]
  if (last !== undefined && last.fontSize === 15 && !last.bold && last.color === undefined) {
    runs[lastIndex] = { ...last, text: `${last.text} copy` }
  } else {
    if (runs.length >= 64) {
      throw new ActionPadEditError('This label already has 64 runs. Remove a run or end it with a regular size-15 run before duplicating the button.')
    }
    runs.push({ text: ' copy', fontSize: 15, bold: false })
  }
  return runs
}

function requireMenu(config: ActionPadConfig, index: number): EditableMenu {
  const menu = config.menus[index]
  if (!menu) throw new ActionPadEditError('This menu no longer exists. Select another menu.')
  return menu
}

function requireGroup(config: ActionPadConfig, location: GroupLocation): EditableGroup {
  const group = requireMenu(config, location.menuIndex).groups[location.groupIndex]
  if (!group) throw new ActionPadEditError('This group no longer exists. Select another group.')
  return group
}

function requireButton(config: ActionPadConfig, location: ButtonLocation): EditableButton {
  const button = requireGroup(config, location).buttons[location.buttonIndex]
  if (!button) throw new ActionPadEditError('This button no longer exists. Select another button.')
  return button
}

function replaceMenu(config: ActionPadConfig, index: number, menu: EditableMenu): ActionPadConfig {
  return { ...config, menus: config.menus.map((candidate, candidateIndex) => candidateIndex === index ? menu : candidate) }
}

function replaceGroup(config: ActionPadConfig, location: GroupLocation, group: EditableGroup): ActionPadConfig {
  const menu = requireMenu(config, location.menuIndex)
  return replaceMenu(config, location.menuIndex, {
    ...menu,
    groups: menu.groups.map((candidate, index) => index === location.groupIndex ? group : candidate)
  })
}

function reorder<T>(items: readonly T[], index: number, direction: -1 | 1): readonly T[] {
  const targetIndex = index + direction
  if (targetIndex < 0 || targetIndex >= items.length) return items
  const reordered = [...items]
  const [item] = reordered.splice(index, 1)
  if (item === undefined) return items
  reordered.splice(targetIndex, 0, item)
  return reordered
}
