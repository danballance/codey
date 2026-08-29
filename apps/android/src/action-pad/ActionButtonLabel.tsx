import { memo } from 'react'
import { StyleSheet, Text } from 'react-native'

import { CODEY_NERD_FONT_FAMILIES } from '../fonts'
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
  const content = typeof label === 'string'
    ? label
    : label.map((run, index) => (
        <Text
          key={index}
          style={[
            { fontSize: compact ? compactActionButtonFontSize(run.fontSize) : run.fontSize },
            fontFacesLoaded
              ? run.bold ? styles.nerdFontBold : styles.nerdFontRegular
              : run.bold ? styles.systemBold : styles.systemRegular
          ]}
        >
          {run.text}
        </Text>
      ))

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
      {content}
    </Text>
  )
})

const styles = StyleSheet.create({
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
  },
  nerdFontBold: {
    fontFamily: CODEY_NERD_FONT_FAMILIES.bold,
    fontWeight: 'normal'
  },
  systemRegular: {
    fontWeight: '400'
  },
  systemBold: {
    fontWeight: '700'
  }
})
