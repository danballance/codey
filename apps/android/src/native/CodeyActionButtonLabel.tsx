import { requireNativeView } from 'expo'
import type { StyleProp, ViewProps, ViewStyle } from 'react-native'

/** Private rendering inputs after document values have been resolved for native drawing. */
export interface CodeyActionButtonLabelRun {
  readonly text: string
  readonly color: string
  readonly fontSize: number
  readonly fontFamily?: string | null
  readonly fontWeight: 400 | 700
}

export interface CodeyActionButtonLabelProps {
  readonly runs: readonly CodeyActionButtonLabelRun[]
  readonly defaultFontSize: number
  readonly defaultFontFamily?: string | null
  readonly color: string
  readonly style?: StyleProp<ViewStyle>
  readonly testID?: string
}

type NativeCodeyActionButtonLabelProps = CodeyActionButtonLabelProps & Pick<
  ViewProps,
  'accessible' | 'accessibilityElementsHidden' | 'importantForAccessibility' | 'pointerEvents'
>

const NativeCodeyActionButtonLabel = requireNativeView<NativeCodeyActionButtonLabelProps>(
  'CodeyActionButtonLabel'
)

/**
 * Android owns inline shaping, centring and height-aware truncation. The parent
 * button alone owns accessibility and gestures; this view is visual only.
 */
export function CodeyActionButtonLabel(props: CodeyActionButtonLabelProps) {
  return (
    <NativeCodeyActionButtonLabel
      {...props}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    />
  )
}
