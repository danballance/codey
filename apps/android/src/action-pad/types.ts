import type { NvimSpecialKeyName } from '../input'

export const MAX_ACTIONS_PER_GROUP = 6
export const MAX_NVIM_INPUT_LENGTH = 16_384
export const ACTION_PAD_LONG_PRESS_MS = 450

export type ActionAfterInput = 'root' | 'stay'

interface ActionButtonBase {
  readonly id: string
  readonly label: string
  readonly accessibilityLabel?: string
}

export interface ModifierActionButton extends ActionButtonBase {
  readonly type: 'modifier'
  readonly modifier: 'ctrl'
}

export interface NativeKeyActionButton extends ActionButtonBase {
  readonly type: 'key'
  readonly key: NvimSpecialKeyName
}

export interface NvimInputActionButton extends ActionButtonBase {
  readonly type: 'input'
  readonly nvimInput: string
}

export interface MenuActionButton extends ActionButtonBase {
  readonly type: 'menu'
  readonly menu: ActionMenu
}

export interface DualActionButton extends ActionButtonBase {
  readonly type: 'dual'
  readonly key: NvimSpecialKeyName
  readonly menu: ActionMenu
}

export type ActionButton =
  | ModifierActionButton
  | NativeKeyActionButton
  | NvimInputActionButton
  | MenuActionButton
  | DualActionButton

export interface ActionGroups {
  readonly leading: readonly ActionButton[]
  readonly trailing: readonly ActionButton[]
}

export interface ActionMenu {
  readonly id: string
  readonly label: string
  readonly afterInput: ActionAfterInput
  readonly groups: ActionGroups
}
