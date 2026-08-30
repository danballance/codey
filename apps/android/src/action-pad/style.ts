import type {
  ActionButtonAppearance,
  ActionButtonSize,
  ActionButtonStyles
} from './types'

export const ACTION_BUTTON_LAYOUT_UNITS = 60

export const ACTION_BUTTON_SIZE_OPTIONS = [
  { value: '1/1', label: 'Whole', units: 60, width: '100%' },
  { value: '1/2', label: 'Half', units: 30, width: '48%' },
  { value: '1/3', label: 'Third', units: 20, width: '30.6667%' },
  { value: '1/4', label: 'Quarter', units: 15, width: '22%' },
  { value: '1/5', label: 'Fifth', units: 12, width: '16.8%' }
] as const satisfies readonly {
  readonly value: ActionButtonSize
  readonly label: string
  readonly units: number
  readonly width: `${number}%`
}[]

export type ActionButtonSizeMetadata = (typeof ACTION_BUTTON_SIZE_OPTIONS)[number]

export const ACTION_BUTTON_SIZE_METADATA: Readonly<Record<ActionButtonSize, ActionButtonSizeMetadata>> =
  Object.freeze(Object.fromEntries(
    ACTION_BUTTON_SIZE_OPTIONS.map((option) => [option.value, option])
  )) as Readonly<Record<ActionButtonSize, ActionButtonSizeMetadata>>

export const DEFAULT_ACTION_BUTTON_APPEARANCE: ActionButtonAppearance = 'filled'
export const DEFAULT_ACTION_BUTTON_BACKGROUND_COLOR = '#24283b'
export const DEFAULT_ACTION_BUTTON_OUTLINE_COLOR = 'transparent'
export const OUTLINE_ACTION_BUTTON_BACKGROUND_COLOR = 'transparent'
export const OUTLINE_ACTION_BUTTON_OUTLINE_COLOR = '#353b52'
export const DEFAULT_ACTION_BUTTON_LABEL_COLOR = '#c0caf5'

export interface ResolvedActionButtonStyles {
  readonly size: ActionButtonSize
  readonly units: number
  readonly width: ActionButtonSizeMetadata['width']
  readonly appearance: ActionButtonAppearance
  readonly backgroundColor: string
  readonly outlineColor: string
}

export function actionButtonSizeMetadata(size: ActionButtonSize): ActionButtonSizeMetadata {
  return ACTION_BUTTON_SIZE_METADATA[size]
}

export function isActionButtonSize(value: unknown): value is ActionButtonSize {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ACTION_BUTTON_SIZE_METADATA, value)
}

export function isActionButtonAppearance(value: unknown): value is ActionButtonAppearance {
  return value === 'filled' || value === 'outline'
}

/** Strict stored colour syntax shared by button and label validation. */
export function isActionButtonHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value)
}

/** Button fills and outlines additionally support an explicitly transparent colour. */
export function isActionButtonStyleColor(value: string): boolean {
  return value === 'transparent' || isActionButtonHexColor(value)
}

export function isActionButtonLabelColor(value: string): boolean {
  return isActionButtonHexColor(value)
}

/** Invalid recovery-draft values never reach native or React Native colour parsing. */
export function resolveActionButtonStyleColor(value: string | undefined, fallback: string): string {
  return value !== undefined && isActionButtonStyleColor(value) ? value : fallback
}

/** Invalid recovery-draft values render like an uncoloured run until repaired. */
export function resolveActionButtonLabelColor(value: string | undefined): string {
  return value !== undefined && isActionButtonLabelColor(value) ? value : DEFAULT_ACTION_BUTTON_LABEL_COLOR
}

export function resolveActionButtonStyles(styles: ActionButtonStyles): ResolvedActionButtonStyles {
  const metadata = actionButtonSizeMetadata(styles.size)
  const appearance = styles.appearance ?? DEFAULT_ACTION_BUTTON_APPEARANCE
  const defaultBackground = appearance === 'outline'
    ? OUTLINE_ACTION_BUTTON_BACKGROUND_COLOR
    : DEFAULT_ACTION_BUTTON_BACKGROUND_COLOR
  const defaultOutline = appearance === 'outline'
    ? OUTLINE_ACTION_BUTTON_OUTLINE_COLOR
    : DEFAULT_ACTION_BUTTON_OUTLINE_COLOR
  return {
    size: styles.size,
    units: metadata.units,
    width: metadata.width,
    appearance,
    backgroundColor: resolveActionButtonStyleColor(styles.backgroundColor, defaultBackground),
    outlineColor: resolveActionButtonStyleColor(styles.outlineColor, defaultOutline)
  }
}

/** Merges one control's edit without discarding sibling style fields. */
export function mergeActionButtonStyles(
  current: ActionButtonStyles,
  patch: Partial<ActionButtonStyles>
): ActionButtonStyles {
  const merged: {
    size: ActionButtonSize
    appearance?: ActionButtonAppearance
    backgroundColor?: string
    outlineColor?: string
  } = {
    ...current,
    ...patch,
    size: patch.size ?? current.size
  }
  if (merged.appearance === undefined) delete merged.appearance
  if (merged.backgroundColor === undefined) delete merged.backgroundColor
  if (merged.outlineColor === undefined) delete merged.outlineColor
  return merged
}
