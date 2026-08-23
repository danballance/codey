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
  readonly onKeyboardPress: () => void
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
  onToggleControl,
  onKeyboardPress
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
          return
        case 'keyboard':
          onKeyboardPress()
      }
    },
    [
      applyAfterInput,
      enabled,
      onKeyboardPress,
      onKeyPress,
      onRawInput,
      onToggleControl,
      openMenu
    ]
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
          contentContainerStyle={[
            styles.verticalGroups,
            compact && styles.compactVerticalGroups
          ]}
          showsVerticalScrollIndicator={false}
          style={styles.flowScroll}
          testID="action-pad-flow-scroll"
        >
          <ActionGroupView
            actions={currentMenu.groups.leading}
            compact={compact}
            controlActive={controlActive}
            enabled={enabled}
            name="leading"
            onBack={goBack}
            onOpenMenu={openMenu}
            onPress={pressAction}
            placedRight
            showBack={false}
          />
          <ActionGroupView
            actions={currentMenu.groups.trailing}
            compact={compact}
            controlActive={controlActive}
            enabled={enabled}
            name="trailing"
            onBack={goBack}
            onOpenMenu={openMenu}
            onPress={pressAction}
            placedRight
            showBack={menuStack.length > 1}
          />
        </ScrollView>
      ) : (
        <View
          style={[styles.horizontalGroups, compact && styles.compactHorizontalGroups]}
          testID="action-pad-groups"
        >
          <ActionGroupView
            actions={currentMenu.groups.leading}
            compact={compact}
            controlActive={controlActive}
            enabled={enabled}
            name="leading"
            onBack={goBack}
            onOpenMenu={openMenu}
            onPress={pressAction}
            placedRight={false}
            showBack={false}
          />
          <ActionGroupView
            actions={currentMenu.groups.trailing}
            compact={compact}
            controlActive={controlActive}
            enabled={enabled}
            name="trailing"
            onBack={goBack}
            onOpenMenu={openMenu}
            onPress={pressAction}
            placedRight={false}
            showBack={menuStack.length > 1}
          />
        </View>
      )}
    </View>
  )
})

type ActionGroupName = keyof ActionMenu['groups']

type ActionGroupItem =
  | { readonly kind: 'action'; readonly action: ActionButton }
  | { readonly kind: 'back' }

function ActionGroupView({
  actions,
  compact,
  controlActive,
  enabled,
  name,
  onBack,
  onOpenMenu,
  onPress,
  placedRight,
  showBack
}: {
  readonly actions: readonly ActionButton[]
  readonly compact: boolean
  readonly controlActive: boolean
  readonly enabled: boolean
  readonly name: ActionGroupName
  readonly onBack: () => void
  readonly onOpenMenu: (menu: ActionMenu) => void
  readonly onPress: (action: ActionButton) => void
  readonly placedRight: boolean
  readonly showBack: boolean
}) {
  const items: readonly ActionGroupItem[] = showBack
    ? [...actions.map((action) => ({ kind: 'action' as const, action })), { kind: 'back' }]
    : actions.map((action) => ({ kind: 'action' as const, action }))

  const renderItem = (item: ActionGroupItem) => item.kind === 'action' ? (
    <ActionButtonView
      key={item.action.id}
      action={item.action}
      column={placedRight}
      compact={compact}
      controlActive={controlActive}
      enabled={enabled}
      onOpenMenu={onOpenMenu}
      onPress={onPress}
    />
  ) : (
    <BackButtonView
      key="back"
      column={placedRight}
      compact={compact}
      enabled={enabled}
      onPress={onBack}
    />
  )

  if (placedRight) {
    return (
      <View
        style={[styles.columnGroup, compact && styles.compactColumnGroup]}
        testID={`action-pad-${name}-group`}
      >
        {items.map(renderItem)}
      </View>
    )
  }

  const columnCount = Math.max(1, Math.ceil(items.length / 2))
  const rows = [items.slice(0, columnCount), items.slice(columnCount)]

  return (
    <View
      style={[styles.rowGroup, compact && styles.compactRowGroup]}
      testID={`action-pad-${name}-group`}
    >
      {rows.map((row, rowIndex) => (
        <View
          key={`${name}-row-${rowIndex}`}
          style={[styles.groupRow, compact && styles.compactGroupRow]}
          testID={`action-pad-${name}-row-${rowIndex + 1}`}
        >
          {row.map(renderItem)}
          {Array.from({ length: columnCount - row.length }, (_, spacerIndex) => (
            <View
              key={`${name}-row-${rowIndex}-spacer-${spacerIndex}`}
              style={styles.buttonSpacer}
            />
          ))}
        </View>
      ))}
    </View>
  )
}

function ActionButtonView({
  action,
  column,
  compact,
  controlActive,
  enabled,
  onOpenMenu,
  onPress
}: {
  readonly action: ActionButton
  readonly column: boolean
  readonly compact: boolean
  readonly controlActive: boolean
  readonly enabled: boolean
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
        column && styles.columnButton,
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
  column,
  compact,
  enabled,
  onPress
}: {
  readonly column: boolean
  readonly compact: boolean
  readonly enabled: boolean
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
        column && styles.columnButton,
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
  verticalGroups: {
    flexGrow: 1,
    width: '100%',
    justifyContent: 'space-between',
    gap: 12
  },
  compactVerticalGroups: {
    gap: 6
  },
  columnGroup: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignContent: 'flex-start',
    rowGap: 12
  },
  compactColumnGroup: {
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
  horizontalGroups: {
    height: 116,
    flexDirection: 'row',
    gap: 12
  },
  compactHorizontalGroups: {
    height: 102,
    gap: 6
  },
  rowGroup: {
    minWidth: 0,
    flex: 1,
    gap: 12
  },
  compactRowGroup: {
    gap: 6
  },
  groupRow: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 12
  },
  compactGroupRow: {
    height: 48,
    gap: 6
  },
  buttonSpacer: {
    minWidth: 48,
    flex: 1
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
  columnButton: {
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
