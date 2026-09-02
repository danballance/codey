import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef
} from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import {
  CODEY_NERD_FONT_FAMILIES,
  useCodeyNerdFontFaces
} from '../fonts'
import { ActionButtonLabel } from './ActionButtonLabel'
import { plainActionButtonLabel } from './label'
import {
  ACTION_BUTTON_LAYOUT_UNITS,
  actionButtonSizeMetadata,
  resolveActionButtonStyles
} from './style'
import {
  ACTION_PAD_LONG_PRESS_MS,
  type ActionButton,
  type ActionGroup,
  type ActionInteraction,
  type ActionMenu,
  type ActionPadButtonTarget
} from './types'

interface PageFrame {
  readonly menu: ActionMenu
  readonly slotTokens: ReadonlyMap<string, object>
}

interface ActiveCluster {
  readonly menu: ActionMenu
  readonly group: ActionGroup
  readonly hostGroupId: string
}

interface NavigationState {
  readonly rootMenu: ActionMenu
  readonly documentToken: object
  readonly pages: readonly PageFrame[]
  readonly cluster: ActiveCluster | null
}

type NavigationAction =
  | { readonly type: 'reset'; readonly rootMenu: ActionMenu }
  | { readonly type: 'root' }
  | { readonly type: 'push'; readonly menu: ActionMenu }
  | { readonly type: 'back' }
  | {
      readonly type: 'group'
      readonly menu: ActionMenu
      readonly group: ActionGroup
      readonly hostGroupId: string
    }

interface ActivationContext {
  readonly page: ActionMenu
  readonly hostGroupId: string
  readonly definitionMenu: ActionMenu
  readonly definitionGroup: ActionGroup
  readonly slotToken: object
  readonly documentToken: object
  readonly modeToken: object
}

export interface ActionPadProps {
  readonly rootMenu: ActionMenu
  readonly enabled: boolean
  readonly interactionMode?: 'normal' | 'selection' | 'suspended'
  readonly onEditButton?: (target: ActionPadButtonTarget) => void
  readonly onNavigationContextChange?: (
    context: ActionPadNavigationContext
  ) => void
  readonly compact?: boolean
  readonly resetKey?: string | number
  readonly onInput: (input: string) => void
  readonly onKeyboardPress: () => void
}

export interface ActionPadNavigationContext {
  readonly text: string
  readonly accessibilityLabel?: string
}

export interface ActionPadStatusBarProps {
  readonly mode: string
  readonly context: ActionPadNavigationContext
  readonly compact?: boolean
}

export const ActionPadStatusBar = memo(function ActionPadStatusBar({
  mode,
  context,
  compact = false
}: ActionPadStatusBarProps) {
  const [nerdFontFacesLoaded] = useCodeyNerdFontFaces()

  return (
    <View
      style={[styles.statusBar, compact && styles.compactStatusBar]}
      testID="action-pad-status-bar"
    >
      <View style={[styles.modeBadge, compact && styles.compactModeBadge]}>
        <Text
          style={[
            styles.modeText,
            nerdFontFacesLoaded && styles.nerdFontBold,
            compact && styles.compactStatusText
          ]}
        >
          {mode}
        </Text>
      </View>
      {context.text.length > 0 ? (
        <Text
          accessibilityLabel={context.accessibilityLabel}
          accessibilityLiveRegion="polite"
          numberOfLines={1}
          style={[
            styles.breadcrumb,
            nerdFontFacesLoaded && styles.nerdFontSemiBold,
            compact && styles.compactStatusText
          ]}
        >
          › {context.text}
        </Text>
      ) : null}
    </View>
  )
})

export const ActionPad = memo(function ActionPad({
  rootMenu,
  enabled,
  interactionMode = 'normal',
  onEditButton,
  onNavigationContextChange,
  compact = false,
  resetKey,
  onInput,
  onKeyboardPress
}: ActionPadProps) {
  const [nerdFontFacesLoaded] = useCodeyNerdFontFaces()
  const [navigation, dispatchNavigation] = useReducer(
    navigationReducer,
    rootMenu,
    createNavigationState
  )
  const configuration = useRef({ resetKey, rootMenu })
  const enabledState = useRef(enabled)
  const modeToken = useMemo(() => ({}), [interactionMode])
  const getRailRows = useMemo(
    () => createRailRowsResolver(),
    [rootMenu]
  )

  useLayoutEffect(() => {
    const previous = configuration.current
    configuration.current = { resetKey, rootMenu }
    if (previous.rootMenu !== rootMenu || !Object.is(previous.resetKey, resetKey)) {
      dispatchNavigation({ type: 'reset', rootMenu })
    }
  }, [resetKey, rootMenu])

  useLayoutEffect(() => {
    const wasEnabled = enabledState.current
    enabledState.current = enabled
    if (wasEnabled && !enabled) dispatchNavigation({ type: 'root' })
  }, [enabled])

  const currentFrame = navigation.pages[navigation.pages.length - 1]
    ?? createPageFrame(rootMenu)
  const currentMenu = currentFrame.menu
  const breadcrumb = navigation.pages
    .slice(1)
    .map((frame) => frame.menu.label)
    .join(' / ')
  const activeClusterLabel = navigation.cluster?.menu.label
  const navigationContext = useMemo<ActionPadNavigationContext>(() => {
    if (activeClusterLabel !== undefined) {
      const page = breadcrumb || currentMenu.label
      return {
        text: `${page} · ${activeClusterLabel}`,
        accessibilityLabel: `Current action page path: ${page}; active action cluster: ${activeClusterLabel}`
      }
    }
    return breadcrumb.length === 0
      ? { text: '' }
      : {
          text: breadcrumb,
          accessibilityLabel: `Current action path: ${breadcrumb}`
        }
  }, [activeClusterLabel, breadcrumb, currentMenu.label])

  useLayoutEffect(() => {
    onNavigationContextChange?.(navigationContext)
  }, [navigationContext, onNavigationContextChange])

  const runtime = useRef({
    enabled,
    interactionMode,
    modeToken,
    navigation,
    onInput,
    onKeyboardPress
  })
  runtime.current = {
    enabled,
    interactionMode,
    modeToken,
    navigation,
    onInput,
    onKeyboardPress
  }

  const isCurrentActivation = useCallback((
    context: ActivationContext,
    button: ActionButton,
    editTarget: ActionPadButtonTarget,
    expectedMode: NonNullable<ActionPadProps['interactionMode']>
  ): boolean => {
    const current = runtime.current
    if (
      current.interactionMode !== expectedMode
      || current.modeToken !== context.modeToken
      || !matchesActivationContext(current.navigation, context)
    ) return false

    return context.definitionGroup.buttons.some((candidate) => candidate === button)
      && editTarget.menuId === context.definitionMenu.id
      && editTarget.groupId === context.definitionGroup.id
      && editTarget.buttonId === button.id
  }, [])

  const runInteraction = useCallback(
    (interaction: ActionInteraction, context: ActivationContext) => {
      const current = runtime.current
      if (
        !current.enabled
        || current.interactionMode !== 'normal'
        || current.modeToken !== context.modeToken
        || !matchesActivationContext(current.navigation, context)
      ) return

      switch (interaction.type) {
        case 'input':
          current.onInput(interaction.nvimInput)
          break
        case 'menu':
          if (interaction.after !== 'root') {
            dispatchNavigation({ type: 'push', menu: interaction.menu })
          }
          break
        case 'group':
          if (interaction.after !== 'root') {
            dispatchNavigation({
              type: 'group',
              menu: interaction.menu,
              group: interaction.group,
              hostGroupId: context.hostGroupId
            })
          }
          break
        case 'back':
          if (interaction.after !== 'root') dispatchNavigation({ type: 'back' })
          break
        case 'keyboard':
          current.onKeyboardPress()
      }

      if (interaction.after === 'root') dispatchNavigation({ type: 'root' })
    },
    []
  )

  const activationContexts = useRef(new Map<string, ActivationContext>())
  const renderedGroups = currentMenu.groups.map((hostGroup) => {
    const substituted = navigation.cluster?.hostGroupId === hostGroup.id
      ? navigation.cluster
      : null
    const definitionMenu = substituted?.menu ?? currentMenu
    const definitionGroup = substituted?.group ?? hostGroup
    const slotToken = currentFrame.slotTokens.get(hostGroup.id) ?? EMPTY_SLOT_TOKEN

    const contextKey = `${currentMenu.id}:${hostGroup.id}`
    const nextActivationContext = {
      page: currentMenu,
      hostGroupId: hostGroup.id,
      definitionMenu,
      definitionGroup,
      slotToken,
      documentToken: navigation.documentToken,
      modeToken
    } satisfies ActivationContext
    const previousActivationContext = activationContexts.current.get(contextKey)
    const activationContext = previousActivationContext !== undefined
      && sameActivationContext(previousActivationContext, nextActivationContext)
      ? previousActivationContext
      : nextActivationContext
    activationContexts.current.set(contextKey, activationContext)

    return {
      hostGroup,
      definitionMenu,
      definitionGroup,
      railRows: getRailRows(hostGroup),
      activationContext
    }
  })

  const groups = renderedGroups.map((rendered) => (
    <ActionGroupView
      key={`${currentMenu.id}:${rendered.hostGroup.id}`}
      activationContext={rendered.activationContext}
      compact={compact}
      enabled={enabled}
      railRows={rendered.railRows}
      fontFacesLoaded={nerdFontFacesLoaded}
      interactionMode={interactionMode}
      isCurrentActivation={isCurrentActivation}
      menuId={rendered.definitionMenu.id}
      name={rendered.hostGroup.id}
      onEditButton={onEditButton}
      onInteraction={runInteraction}
      targetGroupId={rendered.definitionGroup.id}
    />
  ))

  return (
    <View
      accessibilityLabel="Neovim action pad"
      style={[
        styles.panel,
        compact && styles.compactPanel
      ]}
      testID="action-pad"
    >
      <ScrollView
        contentContainerStyle={[
          styles.verticalGroups,
          compact && styles.compactVerticalGroups
        ]}
        showsVerticalScrollIndicator={false}
        style={styles.flowScroll}
        testID="action-pad-flow-scroll"
      >
        {groups}
      </ScrollView>
    </View>
  )
})

const ActionGroupView = memo(function ActionGroupView({
  activationContext,
  compact,
  enabled,
  railRows,
  fontFacesLoaded,
  interactionMode,
  isCurrentActivation,
  menuId,
  name,
  onEditButton,
  onInteraction,
  targetGroupId
}: {
  readonly activationContext: ActivationContext
  readonly compact: boolean
  readonly enabled: boolean
  readonly railRows: number
  readonly fontFacesLoaded: boolean
  readonly interactionMode: NonNullable<ActionPadProps['interactionMode']>
  readonly isCurrentActivation: (
    context: ActivationContext,
    button: ActionButton,
    editTarget: ActionPadButtonTarget,
    expectedMode: NonNullable<ActionPadProps['interactionMode']>
  ) => boolean
  readonly menuId: string
  readonly name: string
  readonly onEditButton: ActionPadProps['onEditButton']
  readonly onInteraction: (
    interaction: ActionInteraction,
    context: ActivationContext
  ) => void
  readonly targetGroupId: string
}) {
  const buttons = activationContext.definitionGroup.buttons
  const renderButton = (button: ActionButton) => (
    <ActionButtonView
      key={definitionKey(button)}
      activationContext={activationContext}
      button={button}
      compact={compact}
      enabled={enabled}
      fontFacesLoaded={fontFacesLoaded}
      interactionMode={interactionMode}
      isCurrentActivation={isCurrentActivation}
      editTarget={{ menuId, groupId: targetGroupId, buttonId: button.id }}
      onEditButton={onEditButton}
      onInteraction={onInteraction}
    />
  )

  return (
    <View
      style={[
        styles.railGroup,
        compact && styles.compactRailGroup,
        railEnvelopeStyle(railRows, compact)
      ]}
      testID={`action-pad-${name}-group`}
    >
      {buttons.map(renderButton)}
    </View>
  )
})

const ActionButtonView = memo(function ActionButtonView({
  activationContext,
  button,
  compact,
  enabled,
  fontFacesLoaded,
  interactionMode,
  isCurrentActivation,
  editTarget,
  onEditButton,
  onInteraction
}: {
  readonly activationContext: ActivationContext
  readonly button: ActionButton
  readonly compact: boolean
  readonly enabled: boolean
  readonly fontFacesLoaded: boolean
  readonly interactionMode: NonNullable<ActionPadProps['interactionMode']>
  readonly isCurrentActivation: (
    context: ActivationContext,
    button: ActionButton,
    editTarget: ActionPadButtonTarget,
    expectedMode: NonNullable<ActionPadProps['interactionMode']>
  ) => boolean
  readonly editTarget: ActionPadButtonTarget
  readonly onEditButton: ActionPadProps['onEditButton']
  readonly onInteraction: (
    interaction: ActionInteraction,
    context: ActivationContext
  ) => void
}) {
  const selecting = interactionMode === 'selection'
  const available = selecting || (interactionMode === 'normal' && enabled)
  const resolvedStyles = resolveActionButtonStyles(button.styles)
  const latest = useRef({
    activationContext,
    button,
    interactionMode,
    isCurrentActivation,
    editTarget,
    available,
    onEditButton,
    onInteraction
  })
  latest.current = {
    activationContext,
    button,
    interactionMode,
    isCurrentActivation,
    editTarget,
    available,
    onEditButton,
    onInteraction
  }
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
      current.interactionMode !== interactionMode
      || !sameButtonTarget(current.editTarget, editTarget)
      || !current.isCurrentActivation(
        activationContext,
        button,
        editTarget,
        interactionMode
      )
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
    if (interaction !== undefined) {
      current.onInteraction(interaction, current.activationContext)
    }
  }

  const accessibleLabel = button.accessibilityLabel?.trim()
    ? button.accessibilityLabel
    : plainActionButtonLabel(button.label)

  return (
    <Pressable
      accessibilityHint={selecting ? 'Open button settings.' : button.accessibilityHint}
      accessibilityLabel={`${selecting ? 'Edit ' : ''}${accessibleLabel}`}
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
        styles.railButton,
        {
          width: resolvedStyles.width,
          backgroundColor: resolvedStyles.backgroundColor,
          borderColor: resolvedStyles.outlineColor
        },
        !available && styles.disabled,
        pressed && available && styles.pressed
      ]}
      testID={`action-pad-${button.id}`}
    >
      <ActionButtonLabel
        compact={compact}
        fontFacesLoaded={fontFacesLoaded}
        label={button.label}
        testID={`action-pad-${button.id}-label`}
      />
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
})

function sameButtonTarget(first: ActionPadButtonTarget, second: ActionPadButtonTarget): boolean {
  return first.menuId === second.menuId && first.groupId === second.groupId && first.buttonId === second.buttonId
}

const EMPTY_SLOT_TOKEN = {}
const definitionKeys = new WeakMap<ActionButton, number>()
let nextDefinitionKey = 0

function definitionKey(button: ActionButton): string {
  let key = definitionKeys.get(button)
  if (key === undefined) {
    key = nextDefinitionKey
    nextDefinitionKey += 1
    definitionKeys.set(button, key)
  }
  return `${button.id}:${key}`
}

function createNavigationState(rootMenu: ActionMenu): NavigationState {
  return {
    rootMenu,
    documentToken: {},
    pages: [createPageFrame(rootMenu)],
    cluster: null
  }
}

function createPageFrame(menu: ActionMenu): PageFrame {
  return {
    menu,
    slotTokens: new Map(menu.groups.map((group) => [group.id, {}]))
  }
}

function navigationReducer(
  state: NavigationState,
  action: NavigationAction
): NavigationState {
  switch (action.type) {
    case 'reset':
      return createNavigationState(action.rootMenu)
    case 'root':
      return createNavigationState(state.rootMenu)
    case 'push': {
      const pages = [...state.pages]
      const currentIndex = pages.length - 1
      const current = pages[currentIndex]
      if (current !== undefined) pages[currentIndex] = refreshPageSlots(current)
      pages.push(createPageFrame(action.menu))
      return { ...state, pages, cluster: null }
    }
    case 'back': {
      if (state.pages.length > 1) {
        const pages = state.pages.slice(0, -1)
        const currentIndex = pages.length - 1
        const current = pages[currentIndex]
        if (current !== undefined) pages[currentIndex] = refreshPageSlots(current)
        return { ...state, pages, cluster: null }
      }
      if (state.cluster === null) return state
      const home = state.pages[0]
      return {
        ...state,
        pages: home === undefined
          ? state.pages
          : [refreshPageSlots(home, new Set([state.cluster.hostGroupId]))],
        cluster: null
      }
    }
    case 'group': {
      const currentIndex = state.pages.length - 1
      const current = state.pages[currentIndex]
      if (current === undefined) return state
      const changedSlots = new Set([action.hostGroupId])
      if (state.cluster !== null) changedSlots.add(state.cluster.hostGroupId)
      const pages = [...state.pages]
      pages[currentIndex] = refreshPageSlots(current, changedSlots)
      return {
        ...state,
        pages,
        cluster: {
          menu: action.menu,
          group: action.group,
          hostGroupId: action.hostGroupId
        }
      }
    }
  }
}

function refreshPageSlots(
  frame: PageFrame,
  groupIds?: ReadonlySet<string>
): PageFrame {
  const slotTokens = new Map(frame.slotTokens)
  for (const group of frame.menu.groups) {
    if (groupIds === undefined || groupIds.has(group.id)) slotTokens.set(group.id, {})
  }
  return { ...frame, slotTokens }
}

function matchesActivationContext(
  navigation: NavigationState,
  context: ActivationContext
): boolean {
  if (navigation.documentToken !== context.documentToken) return false
  const current = navigation.pages[navigation.pages.length - 1]
  if (
    current?.menu !== context.page
    || current.slotTokens.get(context.hostGroupId) !== context.slotToken
  ) return false

  const hostGroup = current.menu.groups.find((group) => group.id === context.hostGroupId)
  if (hostGroup === undefined) return false
  const cluster = navigation.cluster?.hostGroupId === context.hostGroupId
    ? navigation.cluster
    : null
  return (cluster?.menu ?? current.menu) === context.definitionMenu
    && (cluster?.group ?? hostGroup) === context.definitionGroup
}

function sameActivationContext(
  first: ActivationContext,
  second: ActivationContext
): boolean {
  return first.page === second.page
    && first.hostGroupId === second.hostGroupId
    && first.definitionMenu === second.definitionMenu
    && first.definitionGroup === second.definitionGroup
    && first.slotToken === second.slotToken
    && first.documentToken === second.documentToken
    && first.modeToken === second.modeToken
}

function createRailRowsResolver(): (group: ActionGroup) => number {
  const rowCounts = new WeakMap<ActionGroup, number>()
  const resolving = new WeakSet<ActionGroup>()

  function resolve(group: ActionGroup): number {
    const cached = rowCounts.get(group)
    if (cached !== undefined) return cached

    let rows = packedRailRows(group.buttons)
    if (resolving.has(group)) return rows
    resolving.add(group)

    for (const button of group.buttons) {
      const interactions = [button.tap, button.longPress] as readonly (
        | ActionInteraction
        | undefined
      )[]
      for (const interaction of interactions) {
        if (interaction?.type !== 'group' || interaction.after !== 'stay') continue
        rows = Math.max(rows, resolve(interaction.group))
      }
    }

    resolving.delete(group)
    rowCounts.set(group, rows)
    return rows
  }

  return resolve
}

function packedRailRows(buttons: readonly ActionButton[]): number {
  let rows = 0
  let usedUnits = 0
  for (const button of buttons) {
    const units = actionButtonSizeMetadata(button.styles.size).units
    if (usedUnits + units > ACTION_BUTTON_LAYOUT_UNITS) {
      rows += 1
      usedUnits = 0
    }
    usedUnits += units
    if (usedUnits === ACTION_BUTTON_LAYOUT_UNITS) {
      rows += 1
      usedUnits = 0
    }
  }
  return rows + (usedUnits > 0 ? 1 : 0)
}

function railEnvelopeStyle(rows: number, compact: boolean): { readonly height: number } {
  const buttonHeight = compact ? 48 : 52
  const gap = compact ? 6 : 12
  return { height: rows * buttonHeight + Math.max(0, rows - 1) * gap }
}

const styles = StyleSheet.create({
  panel: {
    flex: 1,
    minHeight: 0,
    padding: 24,
    borderLeftWidth: 2,
    borderColor: '#10121a',
    borderRadius: 12,
    backgroundColor: '#16161e'
  },
  compactPanel: {
    padding: 8,
    borderRadius: 8
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
  railGroup: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
    alignContent: 'flex-start',
    columnGap: '4%',
    rowGap: 12
  },
  compactRailGroup: {
    rowGap: 6
  },
  statusBar: {
    height: 25,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    backgroundColor: '#16161e'
  },
  compactStatusBar: {
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
  compactStatusText: {
    fontSize: 11
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
  railButton: {
    flex: 0
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
