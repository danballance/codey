export const ACTION_PAD_LONG_PRESS_MS = 450

export type ActionAfter = 'root' | 'stay'

export type ActionButtonSize = '1/1' | '1/2' | '1/3' | '1/4' | '1/5'

export type ActionButtonAppearance = 'filled' | 'outline'

export const ACTION_BUTTON_FONT_SIZES = [10, 12, 15, 18, 22] as const

export type ActionButtonFontSize = (typeof ACTION_BUTTON_FONT_SIZES)[number]

export interface ActionButtonLabelRun {
  readonly text: string
  readonly fontSize: ActionButtonFontSize
  readonly bold: boolean
  readonly color?: string
}

export type ActionButtonLabel = string | readonly ActionButtonLabelRun[]

export interface ActionButtonStyles {
  readonly size: ActionButtonSize
  readonly appearance?: ActionButtonAppearance
  readonly backgroundColor?: string
  readonly outlineColor?: string
}

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
      readonly type: 'group'
      readonly menu: ActionMenu
      readonly group: ActionGroup
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
  readonly label: ActionButtonLabel
  readonly accessibilityLabel?: string
  readonly accessibilityHint?: string
  readonly styles: ActionButtonStyles
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
  readonly id: string
  readonly label: string
  readonly groups: readonly ActionGroup[]
}

export interface ActionPadButtonTarget {
  readonly menuId: string
  readonly groupId: string
  readonly buttonId: string
}
