export const ACTION_PAD_LONG_PRESS_MS = 450

export type ActionAfter = 'root' | 'stay'

export type ActionInteraction =
  | {
      readonly type: 'input'
      readonly nvimInput: string
      readonly after: ActionAfter
    }
  | {
      readonly type: 'menu'
      readonly menu: ActionMenu
      readonly after: ActionAfter
    }
  | {
      readonly type: 'back'
      readonly after: ActionAfter
    }
  | {
      readonly type: 'keyboard'
      readonly after: ActionAfter
    }

interface ActionButtonBase {
  readonly id: string
  readonly label: string
  readonly accessibilityLabel?: string
  readonly accessibilityHint?: string
}

export type ActionButton = ActionButtonBase & (
  | {
      readonly tap: ActionInteraction
      readonly longPress?: ActionInteraction
    }
  | {
      readonly tap?: never
      readonly longPress: ActionInteraction
    }
)

export interface ActionGroup {
  readonly id: string
  readonly buttons: readonly ActionButton[]
}

export interface ActionMenu {
  readonly label: string
  readonly groups: readonly ActionGroup[]
}
