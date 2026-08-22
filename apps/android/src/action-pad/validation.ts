import { isNvimSpecialKeyName } from '../input'
import {
  ACTION_PAD_ROW_COUNT,
  MAX_ACTIONS_PER_ROW,
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
  if (!Array.isArray(menu.rows) || menu.rows.length !== ACTION_PAD_ROW_COUNT) {
    throw new Error(`${path}.rows must contain exactly ${ACTION_PAD_ROW_COUNT} rows`)
  }
  if (ancestors.has(value)) throw new Error(`${path} contains a cyclic menu reference`)

  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)
  const siblingIds = new Set<string>()

  menu.rows.forEach((rowValue, rowIndex) => {
    if (!Array.isArray(rowValue)) throw new Error(`${path}.rows[${rowIndex}] must be an array`)
    const rowLimit = nested && rowIndex === 1 ? MAX_ACTIONS_PER_ROW - 1 : MAX_ACTIONS_PER_ROW
    if (rowValue.length > rowLimit) {
      const reason = nested && rowIndex === 1 ? ' (one slot is reserved for Back)' : ''
      throw new Error(`${path}.rows[${rowIndex}] may contain at most ${rowLimit} actions${reason}`)
    }

    rowValue.forEach((buttonValue, buttonIndex) => {
      const buttonPath = `${path}.rows[${rowIndex}][${buttonIndex}]`
      const button = validateButton(buttonValue, buttonPath)
      if (siblingIds.has(button.id)) throw new Error(`${path} has duplicate action id "${button.id}"`)
      siblingIds.add(button.id)

      if (button.type === 'menu' || button.type === 'dual') {
        validateMenu(button.menu, true, nextAncestors, `${buttonPath}.menu`)
      }
    })
  })
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
