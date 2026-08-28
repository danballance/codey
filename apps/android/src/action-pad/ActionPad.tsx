import { memo, useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import {
  CODEY_NERD_FONT_FAMILIES,
  useCodeyNerdFontFaces
} from '../fonts'
import { ACTION_PAD_MENU } from './config'
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

interface CapacityEnvelope {
  readonly bottomColumns: number
  readonly rightRows: number
}

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
  const [navigation, dispatchNavigation] = useReducer(
    navigationReducer,
    rootMenu,
    createNavigationState
  )
  const configuration = useRef({ resetKey, rootMenu })
  const enabledState = useRef(enabled)
  const modeToken = useMemo(() => ({}), [interactionMode])
  const getCapacityEnvelope = useMemo(
    () => createCapacityEnvelopeResolver(),
    [rootMenu]
  )

  useEffect(() => {
    const previous = configuration.current
    configuration.current = { resetKey, rootMenu }
    if (previous.rootMenu !== rootMenu || !Object.is(previous.resetKey, resetKey)) {
      dispatchNavigation({ type: 'reset', rootMenu })
    }
  }, [resetKey, rootMenu])

  useEffect(() => {
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
  const navigationContext = activeClusterLabel === undefined
    ? breadcrumb
    : `${breadcrumb || currentMenu.label} · ${activeClusterLabel}`

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
      envelope: getCapacityEnvelope(hostGroup),
      activationContext
    }
  })

  const groups = renderedGroups.map((rendered) => (
    <ActionGroupView
      key={`${currentMenu.id}:${rendered.hostGroup.id}`}
      activationContext={rendered.activationContext}
      compact={compact}
      enabled={enabled}
      envelope={rendered.envelope}
      fontFacesLoaded={nerdFontFacesLoaded}
      interactionMode={interactionMode}
      isCurrentActivation={isCurrentActivation}
      menuId={rendered.definitionMenu.id}
      name={rendered.hostGroup.id}
      onEditButton={onEditButton}
      onInteraction={runInteraction}
      placedRight={placedRight}
      targetGroupId={rendered.definitionGroup.id}
    />
  ))

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
        {navigationContext.length > 0 ? (
          <Text
            accessibilityLabel={activeClusterLabel === undefined
              ? `Current action path: ${breadcrumb}`
              : `Current action page path: ${breadcrumb || currentMenu.label}; active action cluster: ${activeClusterLabel}`}
            accessibilityLiveRegion="polite"
            numberOfLines={1}
            style={[
              styles.breadcrumb,
              nerdFontFacesLoaded && styles.nerdFontSemiBold,
              compact && styles.compactHeaderText
            ]}
          >
            › {navigationContext}
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
          {groups}
        </ScrollView>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[
            styles.horizontalFlowScroll,
            compact && styles.compactHorizontalFlowScroll
          ]}
          testID="action-pad-horizontal-scroll"
        >
          <View
            style={[styles.horizontalGroups, compact && styles.compactHorizontalGroups]}
            testID="action-pad-groups"
          >
            {groups}
          </View>
        </ScrollView>
      )}
    </View>
  )
})

const ActionGroupView = memo(function ActionGroupView({
  activationContext,
  compact,
  enabled,
  envelope,
  fontFacesLoaded,
  interactionMode,
  isCurrentActivation,
  menuId,
  name,
  onEditButton,
  onInteraction,
  placedRight,
  targetGroupId
}: {
  readonly activationContext: ActivationContext
  readonly compact: boolean
  readonly enabled: boolean
  readonly envelope: CapacityEnvelope
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
  readonly placedRight: boolean
  readonly targetGroupId: string
}) {
  const buttons = activationContext.definitionGroup.buttons
  const renderButton = (button: ActionButton) => (
    <ActionButtonView
      key={definitionKey(button)}
      activationContext={activationContext}
      button={button}
      column={placedRight}
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

  if (placedRight) {
    return (
      <View
        style={[
          styles.columnGroup,
          compact && styles.compactColumnGroup,
          rightEnvelopeStyle(envelope.rightRows, compact)
        ]}
        testID={`action-pad-${name}-group`}
      >
        {buttons.map(renderButton)}
      </View>
    )
  }

  const columnCount = envelope.bottomColumns
  const rows = [buttons.slice(0, columnCount), buttons.slice(columnCount)]
  const minimumBasis = columnCount * 48 + (columnCount - 1) * 6

  return (
    <View
      style={[
        styles.rowGroup,
        {
          minWidth: minimumBasis,
          flexBasis: minimumBasis,
          flexGrow: columnCount,
          flexShrink: 0
        }
      ]}
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
})

const ActionButtonView = memo(function ActionButtonView({
  activationContext,
  button,
  column,
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
  readonly column: boolean
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

function createCapacityEnvelopeResolver(): (group: ActionGroup) => CapacityEnvelope {
  const envelopes = new WeakMap<ActionGroup, CapacityEnvelope>()
  const resolving = new WeakSet<ActionGroup>()

  function resolve(group: ActionGroup): CapacityEnvelope {
    const cached = envelopes.get(group)
    if (cached !== undefined) return cached

    let envelope = ownCapacity(group)
    if (resolving.has(group)) return envelope
    resolving.add(group)

    for (const button of group.buttons) {
      const interactions = [button.tap, button.longPress] as readonly (
        | ActionInteraction
        | undefined
      )[]
      for (const interaction of interactions) {
        if (interaction?.type !== 'group' || interaction.after !== 'stay') continue
        const target = resolve(interaction.group)
        envelope = {
          bottomColumns: Math.max(envelope.bottomColumns, target.bottomColumns),
          rightRows: Math.max(envelope.rightRows, target.rightRows)
        }
      }
    }

    resolving.delete(group)
    envelopes.set(group, envelope)
    return envelope
  }

  return resolve
}

function ownCapacity(group: ActionGroup): CapacityEnvelope {
  return {
    bottomColumns: Math.max(1, Math.ceil(group.buttons.length / 2)),
    rightRows: packedRightRows(group.buttons)
  }
}

function packedRightRows(buttons: readonly ActionButton[]): number {
  let rows = 0
  let usedUnits = 0
  for (const button of buttons) {
    const units = button.styles?.size === '1/4' ? 1 : 2
    if (usedUnits + units > 4) {
      rows += 1
      usedUnits = 0
    }
    usedUnits += units
    if (usedUnits === 4) {
      rows += 1
      usedUnits = 0
    }
  }
  return rows + (usedUnits > 0 ? 1 : 0)
}

function rightEnvelopeStyle(rows: number, compact: boolean): { readonly height: number } {
  const buttonHeight = compact ? 48 : 52
  const gap = compact ? 6 : 12
  return { height: rows * buttonHeight + Math.max(0, rows - 1) * gap }
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
  horizontalFlowScroll: {
    height: 110,
    flexGrow: 0,
    flexShrink: 0
  },
  compactHorizontalFlowScroll: {
    height: 102
  },
  horizontalGroups: {
    minWidth: '100%',
    height: 110,
    flexDirection: 'row',
    gap: 6
  },
  compactHorizontalGroups: {
    height: 102
  },
  rowGroup: {
    gap: 6
  },
  groupRow: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 6
  },
  compactGroupRow: {
    height: 48
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
