import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import { ACTION_PAD_MENU } from './config'
import {
  ACTION_PAD_LONG_PRESS_MS,
  type ActionButton,
  type ActionMenu
} from './types'
import { validateActionMenu } from './validation'

export type ActionPadPlacement = 'below' | 'right'

export interface ActionPadProps {
  readonly rootMenu?: ActionMenu
  readonly enabled: boolean
  readonly compact?: boolean
  readonly placement?: ActionPadPlacement
  readonly resetKey?: string | number
  readonly mode: string
  readonly dimensions: string
  readonly controlActive: boolean
  readonly onKeyPress: (key: string) => void
  readonly onRawInput: (input: string) => void
  readonly onToggleControl: () => void
}

export const ActionPad = memo(function ActionPad({
  rootMenu = ACTION_PAD_MENU,
  enabled,
  compact = false,
  placement = 'below',
  resetKey,
  mode,
  dimensions,
  controlActive,
  onKeyPress,
  onRawInput,
  onToggleControl
}: ActionPadProps) {
  const placedRight = placement === 'right'
  const validatedRoot = useMemo(() => {
    validateActionMenu(rootMenu)
    return rootMenu
  }, [rootMenu])
  const [menuStack, setMenuStack] = useState<readonly ActionMenu[]>([validatedRoot])

  useEffect(() => {
    setMenuStack([validatedRoot])
  }, [resetKey, validatedRoot])

  useEffect(() => {
    if (!enabled) setMenuStack([validatedRoot])
  }, [enabled, validatedRoot])

  const currentMenu = menuStack[menuStack.length - 1] ?? validatedRoot
  const breadcrumb = menuStack
    .slice(1)
    .map((menu) => menu.label)
    .join(' / ')

  const openMenu = useCallback((menu: ActionMenu) => {
    setMenuStack((previous) => [...previous, menu])
  }, [])

  const applyAfterInput = useCallback(() => {
    if (currentMenu.afterInput === 'root') setMenuStack([validatedRoot])
  }, [currentMenu.afterInput, validatedRoot])

  const pressAction = useCallback(
    (action: ActionButton) => {
      if (!enabled) return

      switch (action.type) {
        case 'modifier':
          onToggleControl()
          return
        case 'key':
          onKeyPress(action.key)
          applyAfterInput()
          return
        case 'input':
          onRawInput(action.nvimInput)
          applyAfterInput()
          return
        case 'menu':
          openMenu(action.menu)
          return
        case 'dual':
          onKeyPress(action.key)
          applyAfterInput()
      }
    },
    [applyAfterInput, enabled, onKeyPress, onRawInput, onToggleControl, openMenu]
  )

  const goBack = useCallback(() => {
    setMenuStack((previous) =>
      previous.length > 1 ? previous.slice(0, previous.length - 1) : previous
    )
  }, [])

  return (
    <View
      accessibilityLabel="Neovim action pad"
      style={[
        styles.panel,
        compact && styles.compactPanel,
        placedRight && styles.rightPanel
      ]}
      testID="action-pad"
    >
      <View style={[styles.header, compact && styles.compactHeader]}>
        <View style={[styles.modeBadge, compact && styles.compactModeBadge]}>
          <Text style={[styles.modeText, compact && styles.compactHeaderText]}>{mode}</Text>
        </View>
        {breadcrumb.length > 0 ? (
          <Text
            accessibilityLabel={`Current action path: ${breadcrumb}`}
            numberOfLines={1}
            style={[styles.breadcrumb, compact && styles.compactHeaderText]}
          >
            › {breadcrumb}
          </Text>
        ) : (
          <Text numberOfLines={1} style={[styles.dimensions, compact && styles.compactHeaderText]}>
            {dimensions}
          </Text>
        )}
      </View>

      {placedRight ? (
        <ScrollView
          showsVerticalScrollIndicator={false}
          style={styles.flowScroll}
          testID="action-pad-flow-scroll"
        >
          <View
            style={[styles.flow, compact && styles.compactFlow]}
            testID="action-pad-flow"
          >
            {currentMenu.rows.flat().map((action) => (
              <ActionButtonView
                key={action.id}
                action={action}
                compact={compact}
                controlActive={controlActive}
                enabled={enabled}
                flow
                onOpenMenu={openMenu}
                onPress={pressAction}
              />
            ))}
            {menuStack.length > 1 ? (
              <BackButtonView
                compact={compact}
                enabled={enabled}
                flow
                onPress={goBack}
              />
            ) : null}
          </View>
        </ScrollView>
      ) : (
        <View style={[styles.rows, compact && styles.compactRows]}>
          {currentMenu.rows.map((row, rowIndex) => (
            <View
              key={`${currentMenu.id}-row-${rowIndex}`}
              style={[styles.row, compact && styles.compactRow]}
              testID={`action-pad-row-${rowIndex + 1}`}
            >
              {row.map((action) => (
                <ActionButtonView
                  key={action.id}
                  action={action}
                  compact={compact}
                  controlActive={controlActive}
                  enabled={enabled}
                  flow={false}
                  onOpenMenu={openMenu}
                  onPress={pressAction}
                />
              ))}
              {rowIndex === 1 && menuStack.length > 1 ? (
                <BackButtonView
                  compact={compact}
                  enabled={enabled}
                  flow={false}
                  onPress={goBack}
                />
              ) : null}
            </View>
          ))}
        </View>
      )}
    </View>
  )
})

function ActionButtonView({
  action,
  compact,
  controlActive,
  enabled,
  flow,
  onOpenMenu,
  onPress
}: {
  readonly action: ActionButton
  readonly compact: boolean
  readonly controlActive: boolean
  readonly enabled: boolean
  readonly flow: boolean
  readonly onOpenMenu: (menu: ActionMenu) => void
  readonly onPress: (action: ActionButton) => void
}) {
  const longPressTriggered = useRef(false)
  const modifierActive = action.type === 'modifier' && controlActive
  const dual = action.type === 'dual'

  return (
    <Pressable
      accessibilityHint={dual ? 'Tap for one key press. Hold for navigation options.' : undefined}
      accessibilityLabel={action.accessibilityLabel ?? action.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: !enabled, selected: modifierActive }}
      delayLongPress={dual ? ACTION_PAD_LONG_PRESS_MS : undefined}
      disabled={!enabled}
      onLongPress={
        dual
          ? () => {
              longPressTriggered.current = true
              onOpenMenu(action.menu)
            }
          : undefined
      }
      onPress={() => {
        if (longPressTriggered.current) {
          longPressTriggered.current = false
          return
        }
        onPress(action)
      }}
      onPressIn={() => {
        longPressTriggered.current = false
      }}
      style={({ pressed }) => [
        styles.button,
        compact && styles.compactButton,
        flow && styles.flowButton,
        modifierActive && styles.activeButton,
        !enabled && styles.disabled,
        pressed && enabled && styles.pressed
      ]}
      testID={`action-pad-${action.id}`}
    >
      <Text
        numberOfLines={2}
        style={[
          styles.buttonText,
          compact && styles.compactButtonText,
          modifierActive && styles.activeButtonText
        ]}
      >
        {action.label}
      </Text>
    </Pressable>
  )
}

function BackButtonView({
  compact,
  enabled,
  flow,
  onPress
}: {
  readonly compact: boolean
  readonly enabled: boolean
  readonly flow: boolean
  readonly onPress: () => void
}) {
  return (
    <Pressable
      accessibilityLabel="Back"
      accessibilityRole="button"
      disabled={!enabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact && styles.compactButton,
        flow && styles.flowButton,
        styles.backButton,
        !enabled && styles.disabled,
        pressed && enabled && styles.pressed
      ]}
      testID="action-pad-back"
    >
      <Text
        style={[
          styles.buttonText,
          compact && styles.compactButtonText,
          styles.backButtonText
        ]}
      >
        Back
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  panel: {
    minHeight: 213,
    padding: 24,
    gap: 18,
    borderTopWidth: 2,
    borderColor: '#10121a',
    borderRadius: 12,
    backgroundColor: '#16161e'
  },
  compactPanel: {
    minHeight: 144,
    padding: 8,
    gap: 6,
    borderRadius: 8
  },
  rightPanel: {
    flex: 1,
    minHeight: 0,
    borderTopWidth: 0,
    borderLeftWidth: 2
  },
  flowScroll: {
    flex: 1,
    minHeight: 0
  },
  flow: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignContent: 'flex-start',
    rowGap: 12
  },
  compactFlow: {
    rowGap: 6
  },
  header: {
    height: 25,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12
  },
  compactHeader: {
    height: 20,
    gap: 6
  },
  modeBadge: {
    height: 25,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#9ece6a',
    borderRadius: 4,
    backgroundColor: 'rgba(158, 206, 106, 0.12)'
  },
  compactModeBadge: {
    height: 20,
    paddingHorizontal: 6
  },
  compactHeaderText: {
    fontSize: 11
  },
  modeText: {
    color: '#9ece6a',
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '700'
  },
  breadcrumb: {
    minWidth: 0,
    flexShrink: 1,
    color: '#73daca',
    fontSize: 13,
    fontWeight: '600'
  },
  dimensions: {
    minWidth: 0,
    flexShrink: 1,
    color: '#7c8997',
    fontFamily: 'monospace',
    fontSize: 12
  },
  rows: {
    gap: 12
  },
  compactRows: {
    gap: 6
  },
  row: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 12
  },
  compactRow: {
    height: 48,
    gap: 6
  },
  button: {
    minWidth: 48,
    height: 52,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: 'transparent',
    borderRadius: 12,
    backgroundColor: '#24283b'
  },
  compactButton: {
    height: 48,
    paddingHorizontal: 4,
    borderRadius: 8
  },
  flowButton: {
    width: '48%',
    flex: 0
  },
  buttonText: {
    color: '#c0caf5',
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center'
  },
  compactButtonText: {
    fontSize: 13
  },
  activeButton: {
    borderColor: '#9ece6a',
    backgroundColor: 'rgba(158, 206, 106, 0.12)'
  },
  activeButtonText: {
    color: '#9ece6a'
  },
  backButton: {
    borderWidth: 1.5,
    borderColor: '#bb9af3',
    backgroundColor: '#1f2335'
  },
  backButtonText: {
    color: '#bb9af3'
  },
  disabled: {
    opacity: 0.45
  },
  pressed: {
    opacity: 0.72
  }
})
