import { Text, View } from 'react-native'

import type { CodeyActionButtonLabelProps } from '../CodeyActionButtonLabel'

/** Native layout is covered by Android tests, not reproduced in JavaScript. */
export function CodeyActionButtonLabel(props: CodeyActionButtonLabelProps) {
  return (
    <View
      {...props}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      <Text>{props.runs.map((run) => run.text).join('')}</Text>
    </View>
  )
}
