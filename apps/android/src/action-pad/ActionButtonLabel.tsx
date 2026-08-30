import { memo } from 'react'
import { StyleSheet, Text } from 'react-native'

import { CODEY_NERD_FONT_FAMILIES } from '../fonts'
import { CodeyActionButtonLabel } from '../native/CodeyActionButtonLabel'
import {
  compactActionButtonFontSize
} from './label'
import {
  type ActionButtonLabel as ActionButtonLabelValue
} from './types'

export interface ActionButtonLabelProps {
  readonly compact?: boolean
  readonly fontFacesLoaded: boolean
  readonly label: ActionButtonLabelValue
  readonly testID?: string
}

/**
 * The shared two-line label used by production buttons and editor previews.
 * Selection mode intentionally does not alter these metrics; its pencil is an
 * overlay owned by the surrounding button.
 */
export const ActionButtonLabel = memo(function ActionButtonLabel({
  compact = false,
  fontFacesLoaded,
  label,
  testID
}: ActionButtonLabelProps) {
  if (typeof label !== 'string') {
    return (
      <CodeyActionButtonLabel
        color="#c0caf5"
        defaultFontFamily={fontFacesLoaded ? CODEY_NERD_FONT_FAMILIES.regular : undefined}
        defaultFontSize={compact ? 13 : 15}
        runs={label.map((run) => ({
          text: run.text,
          fontSize: compact ? compactActionButtonFontSize(run.fontSize) : run.fontSize,
          fontFamily: fontFacesLoaded
            ? run.bold ? CODEY_NERD_FONT_FAMILIES.bold : CODEY_NERD_FONT_FAMILIES.regular
            : undefined,
          fontWeight: run.bold ? 700 : 400
        }))}
        style={styles.nativeLabel}
        testID={testID}
      />
    )
  }

  return (
    <Text
      numberOfLines={2}
      style={[
        styles.buttonText,
        fontFacesLoaded && styles.nerdFontRegular,
        compact && styles.compactButtonText
      ]}
      testID={testID}
    >
      {label}
    </Text>
  )
})

const styles = StyleSheet.create({
  nativeLabel: {
    alignSelf: 'stretch',
    flex: 1
  },
  buttonText: {
    color: '#c0caf5',
    fontSize: 15,
    fontWeight: '400',
    textAlign: 'center'
  },
  compactButtonText: {
    fontSize: 13
  },
  nerdFontRegular: {
    fontFamily: CODEY_NERD_FONT_FAMILIES.regular,
    fontWeight: 'normal'
  }
})
