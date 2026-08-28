import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import {
  CODEY_NERD_FONT_FAMILIES,
  useCodeyNerdFontFaces
} from '../fonts'
import { ACTION_PAD_MENU } from './config'
import {
  ACTION_PAD_LONG_PRESS_MS,
  type ActionButton,
  type ActionInteraction,
  type ActionMenu,
  type ActionPadButtonTarget
} from './types'

export type ActionPadPlacement = 'below' | 'right'

export interface ActionPadProps {
  readonly rootMenu?: ActionMenu
  readonly enabled: boolean
  readonly interactionMode?: 'normal' | 'selection' | 'suspended'
  readonly onEditButton?: (target: ActionPadButtonTarget) => void
  readonly compact?: boolean
  readonly placement?: ActionPadPlacement
  readonly resetKey?: string | number
  readonly mode: string
  readonly dimensions: string
  readonly onInput: (input: string) => void
  readonly onKeyboardPress: () => void
}

export const ActionPad = memo(function ActionPad({
  rootMenu = ACTION_PAD_MENU,
  enabled,
  interactionMode = 'normal',
  onEditButton,
  compact = false,
  placement = 'below',
  resetKey,
  mode,
  dimensions,
  onInput,
  onKeyboardPress
}: ActionPadProps) {
  const placedRight = placement === 'right'
  const [nerdFontFacesLoaded] = useCodeyNerdFontFaces()
  const [menuStack, setMenuStack] = useState<readonly ActionMenu[]>([rootMenu])

  useEffect(() => {
    setMenuStack([rootMenu])
  }, [resetKey, rootMenu])

  useEffect(() => {
    if (!enabled) setMenuStack([rootMenu])
  }, [enabled, rootMenu])

  const currentMenu = menuStack[menuStack.length - 1] ?? rootMenu
  const breadcrumb = menuStack
    .slice(1)
    .map((menu) => menu.label)
    .join(' / ')

  const runInteraction = useCallback(
    (interaction: ActionInteraction) => {
      if (!enabled || interactionMode !== 'normal') return

      switch (interaction.type) {
        case 'input':
          onInput(interaction.nvimInput)
          break
        case 'menu':
          setMenuStack((previous) => [...previous, interaction.menu])
          break
        case 'back':
          setMenuStack((previous) =>
            previous.length > 1 ? previous.slice(0, previous.length - 1) : previous
          )
          break
        case 'keyboard':
          onKeyboardPress()
      }

      if (interaction.after === 'root') setMenuStack([rootMenu])
    },
    [enabled, interactionMode, onInput, onKeyboardPress, rootMenu]
  )

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
          <Text
            style={[
              styles.modeText,
              nerdFontFacesLoaded && styles.nerdFontBold,
              compact && styles.compactHeaderText
            ]}
          >
            {mode}
          </Text>
        </View>
        {breadcrumb.length > 0 ? (
          <Text
            accessibilityLabel={`Current action path: ${breadcrumb}`}
            numberOfLines={1}
            style={[
              styles.breadcrumb,
              nerdFontFacesLoaded && styles.nerdFontSemiBold,
              compact && styles.compactHeaderText
            ]}
          >
            › {breadcrumb}
          </Text>
        ) : (
          <Text
            numberOfLines={1}
            style={[
              styles.dimensions,
              nerdFontFacesLoaded && styles.nerdFontRegular,
              compact && styles.compactHeaderText
            ]}
          >
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
          {currentMenu.groups.map((group) => (
            <ActionGroupView
              key={group.id}
              buttons={group.buttons}
              compact={compact}
              enabled={enabled}
              fontFacesLoaded={nerdFontFacesLoaded}
              interactionMode={interactionMode}
              menuId={currentMenu.id}
              name={group.id}
              onEditButton={onEditButton}
              onInteraction={runInteraction}
              placedRight
            />
          ))}
        </ScrollView>
      ) : (
        <View
          style={[styles.horizontalGroups, compact && styles.compactHorizontalGroups]}
          testID="action-pad-groups"
        >
          {currentMenu.groups.map((group) => (
            <ActionGroupView
              key={group.id}
              buttons={group.buttons}
              compact={compact}
              enabled={enabled}
              fontFacesLoaded={nerdFontFacesLoaded}
              interactionMode={interactionMode}
              menuId={currentMenu.id}
              name={group.id}
              onEditButton={onEditButton}
              onInteraction={runInteraction}
              placedRight={false}
            />
          ))}
        </View>
      )}
    </View>
  )
})

function ActionGroupView({
  buttons,
  compact,
  enabled,
  fontFacesLoaded,
  interactionMode,
  menuId,
  name,
  onEditButton,
  onInteraction,
  placedRight
}: {
  readonly buttons: readonly ActionButton[]
  readonly compact: boolean
  readonly enabled: boolean
  readonly fontFacesLoaded: boolean
  readonly interactionMode: NonNullable<ActionPadProps['interactionMode']>
  readonly menuId: string
  readonly name: string
  readonly onEditButton: ActionPadProps['onEditButton']
  readonly onInteraction: (interaction: ActionInteraction) => void
  readonly placedRight: boolean
}) {
  const renderButton = (button: ActionButton) => (
    <ActionButtonView
      key={button.id}
      button={button}
      column={placedRight}
      compact={compact}
      enabled={enabled}
      fontFacesLoaded={fontFacesLoaded}
      interactionMode={interactionMode}
      editTarget={{ menuId, groupId: name, buttonId: button.id }}
      onEditButton={onEditButton}
      onInteraction={onInteraction}
    />
  )

  if (placedRight) {
    return (
      <View
        style={[styles.columnGroup, compact && styles.compactColumnGroup]}
        testID={`action-pad-${name}-group`}
      >
        {buttons.map(renderButton)}
      </View>
    )
  }

  const columnCount = Math.max(1, Math.ceil(buttons.length / 2))
  const rows = [buttons.slice(0, columnCount), buttons.slice(columnCount)]

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
          {row.map(renderButton)}
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
  button,
  column,
  compact,
  enabled,
  fontFacesLoaded,
  interactionMode,
  editTarget,
  onEditButton,
  onInteraction
}: {
  readonly button: ActionButton
  readonly column: boolean
  readonly compact: boolean
  readonly enabled: boolean
  readonly fontFacesLoaded: boolean
  readonly interactionMode: NonNullable<ActionPadProps['interactionMode']>
  readonly editTarget: ActionPadButtonTarget
  readonly onEditButton: ActionPadProps['onEditButton']
  readonly onInteraction: (interaction: ActionInteraction) => void
}) {
  const selecting = interactionMode === 'selection'
  const available = selecting || (interactionMode === 'normal' && enabled)
  const latest = useRef({ button, interactionMode, editTarget, available, onEditButton, onInteraction })
  latest.current = { button, interactionMode, editTarget, available, onEditButton, onInteraction }
  const gesture = useRef<{
    readonly button: ActionButton
    readonly interactionMode: NonNullable<ActionPadProps['interactionMode']>
    readonly editTarget: ActionPadButtonTarget
    readonly held: boolean
  } | null>(null)

  function activate(held: boolean) {
    const current = latest.current
    // Accessibility activation can arrive without pressIn. Keep even those
    // callbacks bound to the document and mode that rendered the target.
    if (
      current.button !== button ||
      current.interactionMode !== interactionMode || !sameButtonTarget(current.editTarget, editTarget)
    ) return
    const started = gesture.current
    if (!held) gesture.current = null
    if (!current.available || started?.held) return
    // A mode or document change during a native gesture must not turn its
    // release into an action in the newly visible pad.
    if (started !== null && (
      started.button !== current.button || started.interactionMode !== current.interactionMode ||
      !sameButtonTarget(started.editTarget, current.editTarget)
    )) return
    if (held) gesture.current = { ...current, held: true }
    if (current.interactionMode === 'selection') {
      current.onEditButton?.(current.editTarget)
      return
    }
    const interaction = held ? current.button.longPress : current.button.tap
    if (interaction !== undefined) current.onInteraction(interaction)
  }

  return (
    <Pressable
      accessibilityHint={selecting ? 'Open button settings.' : button.accessibilityHint}
      accessibilityLabel={`${selecting ? 'Edit ' : ''}${button.accessibilityLabel ?? button.label}`}
      accessibilityRole="button"
      accessibilityState={{ disabled: !available }}
      delayLongPress={selecting || button.longPress !== undefined ? ACTION_PAD_LONG_PRESS_MS : undefined}
      disabled={!available}
      onLongPress={selecting || button.longPress !== undefined ? () => activate(true) : undefined}
      onPress={selecting || button.tap !== undefined ? () => activate(false) : undefined}
      onPressIn={() => {
        gesture.current = { ...latest.current, held: false }
      }}
      style={({ pressed }) => [
        styles.button,
        compact && styles.compactButton,
        column && styles.columnButton,
        column && button.styles?.size === '1/4' && styles.quarterColumnButton,
        !available && styles.disabled,
        pressed && available && styles.pressed
      ]}
      testID={`action-pad-${button.id}`}
    >
      <Text
        numberOfLines={2}
        style={[
          styles.buttonText,
          fontFacesLoaded && styles.nerdFontSemiBold,
          compact && styles.compactButtonText,
          selecting && styles.selectionButtonText,
          selecting && compact && styles.compactSelectionButtonText
        ]}
      >
        {button.label}
      </Text>
      {selecting ? (
        <View
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={styles.editIndicator}
          testID={`action-pad-${button.id}-edit-indicator`}
        >
          <Text style={styles.editIndicatorText}>✎</Text>
        </View>
      ) : null}
    </Pressable>
  )
}

function sameButtonTarget(first: ActionPadButtonTarget, second: ActionPadButtonTarget): boolean {
  return first.menuId === second.menuId && first.groupId === second.groupId && first.buttonId === second.buttonId
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
    justifyContent: 'flex-start',
    alignContent: 'flex-start',
    columnGap: '4%',
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
  nerdFontRegular: {
    fontFamily: CODEY_NERD_FONT_FAMILIES.regular,
    fontWeight: 'normal'
  },
  nerdFontSemiBold: {
    fontFamily: CODEY_NERD_FONT_FAMILIES.semiBold,
    fontWeight: 'normal'
  },
  nerdFontBold: {
    fontFamily: CODEY_NERD_FONT_FAMILIES.bold,
    fontWeight: 'normal'
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
  quarterColumnButton: {
    width: '22%'
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
  selectionButtonText: {
    marginTop: 10,
    lineHeight: 18,
    includeFontPadding: false
  },
  compactSelectionButtonText: {
    lineHeight: 16
  },
  editIndicator: {
    position: 'absolute',
    top: 2,
    right: 4
  },
  editIndicatorText: {
    color: '#73daca',
    fontSize: 11,
    lineHeight: 11,
    includeFontPadding: false
  },
  disabled: {
    opacity: 0.45
  },
  pressed: {
    opacity: 0.72
  }
})
