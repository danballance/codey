import { isNvimSpecialKeyName } from '../input'
import {
  MAX_ACTIONS_PER_GROUP,
  MAX_NVIM_INPUT_LENGTH,
  type ActionButton,
  type ActionMenu
} from './types'

export function validateActionMenu(value: unknown): asserts value is ActionMenu {
  validateMenu(value, false, new Set<unknown>(), 'root')
}

function validateMenu(
  value: unknown,
  nested: boolean,
  ancestors: Set<unknown>,
  path: string
): void {
  const menu = requireRecord(value, `${path} menu`)
  requireNonEmptyString(menu.id, `${path}.id`)
  requireNonEmptyString(menu.label, `${path}.label`)
  if (menu.afterInput !== 'root' && menu.afterInput !== 'stay') {
    throw new Error(`${path}.afterInput must be "root" or "stay"`)
  }
  const groups = requireRecord(menu.groups, `${path}.groups`)
  const groupNames = Object.keys(groups)
  if (
    groupNames.length !== 2 ||
    !groupNames.includes('leading') ||
    !groupNames.includes('trailing')
  ) {
    throw new Error(`${path}.groups must contain exactly "leading" and "trailing"`)
  }
  if (ancestors.has(value)) throw new Error(`${path} contains a cyclic menu reference`)

  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)
  const siblingIds = new Set<string>()

  for (const groupName of ['leading', 'trailing'] as const) {
    const groupValue = groups[groupName]
    if (!Array.isArray(groupValue)) {
      throw new Error(`${path}.groups.${groupName} must be an array`)
    }
    const groupLimit = nested && groupName === 'trailing'
      ? MAX_ACTIONS_PER_GROUP - 1
      : MAX_ACTIONS_PER_GROUP
    if (groupValue.length > groupLimit) {
      const reason = nested && groupName === 'trailing' ? ' (one slot is reserved for Back)' : ''
      throw new Error(
        `${path}.groups.${groupName} may contain at most ${groupLimit} actions${reason}`
      )
    }

    groupValue.forEach((buttonValue, buttonIndex) => {
      const buttonPath = `${path}.groups.${groupName}[${buttonIndex}]`
      const button = validateButton(buttonValue, buttonPath)
      if (siblingIds.has(button.id)) throw new Error(`${path} has duplicate action id "${button.id}"`)
      siblingIds.add(button.id)

      if (button.type === 'menu' || button.type === 'dual') {
        validateMenu(button.menu, true, nextAncestors, `${buttonPath}.menu`)
      }
    })
  }
}

function validateButton(value: unknown, path: string): ActionButton {
  const button = requireRecord(value, `${path} action`)
  requireNonEmptyString(button.id, `${path}.id`)
  requireNonEmptyString(button.label, `${path}.label`)
  if (button.accessibilityLabel !== undefined) {
    requireNonEmptyString(button.accessibilityLabel, `${path}.accessibilityLabel`)
  }

  switch (button.type) {
    case 'modifier':
      if (button.modifier !== 'ctrl') throw new Error(`${path}.modifier must be "ctrl"`)
      return button as unknown as ActionButton
    case 'key':
      requireNativeKey(button.key, `${path}.key`)
      return button as unknown as ActionButton
    case 'input':
      requireInput(button.nvimInput, `${path}.nvimInput`)
      return button as unknown as ActionButton
    case 'menu':
      requireRecord(button.menu, `${path}.menu`)
      return button as unknown as ActionButton
    case 'dual':
      requireNativeKey(button.key, `${path}.key`)
      requireRecord(button.menu, `${path}.menu`)
      return button as unknown as ActionButton
    case 'keyboard':
      return button as unknown as ActionButton
    default:
      throw new Error(`${path}.type is not a supported action type`)
  }
}

function requireNativeKey(value: unknown, path: string): asserts value is string {
  requireNonEmptyString(value, path)
  if (!isNvimSpecialKeyName(value)) {
    throw new Error(`${path} must be a supported native key name`)
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`)
  }
}

function requireInput(value: unknown, path: string): asserts value is string {
  requireNonEmptyString(value, path)
  if (value.length > MAX_NVIM_INPUT_LENGTH) {
    throw new Error(`${path} must not exceed ${MAX_NVIM_INPUT_LENGTH} characters`)
  }
}
