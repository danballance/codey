import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions
} from 'react-native'

import { CODEY_NERD_FONT_FAMILIES, useCodeyNerdFontFaces } from '../fonts'
import { type NerdFontIcon } from '../fonts/nerd-font-icons'
import { ActionButtonLabel } from './ActionButtonLabel'
import { NerdFontIconPicker } from './NerdFontIconPicker'
import {
  validateActionPadConfig,
  type ActionPadConfig,
  type ConfigIssue
} from './document'
import {
  analyzeActionPadMenus,
  editActionPad,
  groupDeletionReason,
  menuDeletionReason,
  type ActionPadEdit,
  type ButtonLocation,
  type EditableButtonPatch,
  type EditableInteraction,
  type MenuReference
} from './editing'
import {
  ACTION_BUTTON_FONT_SIZES,
  type ActionButtonFontSize,
  type ActionButtonLabel as ActionButtonLabelValue,
  type ActionButtonLabelRun,
  type ActionButtonStyles,
  type ActionPadButtonTarget
} from './types'
import {
  actionButtonLabelRuns,
  containsPrivateUseGlyph,
  plainActionButtonLabel
} from './label'
import { insertLabelText, type LabelTextSelection } from './label-selection'
import {
  ACTION_BUTTON_SIZE_OPTIONS,
  resolveActionButtonLabelColor,
  resolveActionButtonStyles
} from './style'

export interface ActionPadEditorProps {
  readonly config: ActionPadConfig
  readonly onChange: (config: ActionPadConfig) => void
  readonly connected: boolean
  readonly busy: boolean
  readonly dirty: boolean
  readonly sourcePath: string
  readonly message: string
  readonly onLoad: (path: string) => Promise<void>
  readonly onSave: (path: string) => Promise<void>
  readonly onExport: (path: string) => Promise<void>
  readonly onCancel: () => void
  readonly initialButton?: ActionPadButtonTarget
  readonly onPendingEditsChange?: (pending: boolean) => void
  readonly initialIdDrafts?: Readonly<Record<string, string>>
  readonly onIdDraftsChange?: (drafts: Readonly<Record<string, string>>) => void
}

type SelectionKind = 'manager' | 'menu' | 'group' | 'button'
interface Choice {
  readonly value: string
  readonly label: string
}

interface PendingIdEdit {
  readonly value: string
  readonly message: string
}

interface ReferenceGuide {
  readonly buttonIdentity: string
  readonly gesture: 'tap' | 'longPress'
  readonly interactionType: 'menu' | 'group'
  readonly target: string
}

interface CleanupMenuSummary {
  readonly id: string
  readonly label: string
  readonly groupCount: number
  readonly buttonCount: number
}

interface CleanupConfirmation {
  readonly config: ActionPadConfig
  readonly menus: readonly CleanupMenuSummary[]
  readonly groupCount: number
  readonly buttonCount: number
}

interface IconInsertionRequest {
  readonly config: ActionPadConfig
  readonly buttonIdentity: string
  readonly insert: (icon: NerdFontIcon) => void
}

type EditorScrollTarget = 'button' | 'tap' | 'longPress'
type EditorLayoutPart = 'workspace' | 'details' | EditorScrollTarget

const MENU_REFERENCE_PAGE_SIZE = 25
const ACTION_BUTTON_COLOR_OPTIONS = [
  { value: '#9ece6a', label: 'Green' },
  { value: '#e0af68', label: 'Yellow' },
  { value: '#73daca', label: 'Cyan' },
  { value: '#ff7b72', label: 'Red' }
] as const

export function ActionPadEditor({
  config,
  onChange,
  connected,
  busy: hostBusy,
  dirty,
  sourcePath,
  message,
  onLoad,
  onSave,
  onExport,
  onCancel,
  initialButton,
  onPendingEditsChange,
  initialIdDrafts,
  onIdDraftsChange
}: ActionPadEditorProps) {
  const { width } = useWindowDimensions()
  const wide = width >= 900
  const [fontLoaded, fontError] = useCodeyNerdFontFaces()
  // Resolve only at entry. Subsequent edits use the existing selection, and a
  // loaded or saved document still resets to its root below.
  const [initialButtonLocation] = useState(() => findInitialButton(config, initialButton))
  const [menuSelection, setMenuSelection] = useState(() => initialButtonLocation?.menuIndex ?? Math.max(0, config.menus.findIndex((menu) => menu.id === config.rootMenuId)))
  const [groupSelection, setGroupSelection] = useState(initialButtonLocation?.groupIndex ?? 0)
  const [buttonSelection, setButtonSelection] = useState(initialButtonLocation?.buttonIndex ?? 0)
  const [selectionKind, setSelectionKind] = useState<SelectionKind>(initialButtonLocation ? 'button' : 'manager')
  const [targetNotice, setTargetNotice] = useState(() => initialButton && !initialButtonLocation
    ? 'The selected button could not be found uniquely in this draft. It may have been moved, renamed, or removed. Your draft has been kept; choose a button below.'
    : '')
  const scrollView = useRef<ScrollView>(null)
  const editorScroll = useRef<{
    pending: boolean
    contentReady: boolean
    target: EditorScrollTarget
    animated: boolean
    expectedButtonIdentity: string
    positionedButtonIdentity: string
    positions: Partial<Record<EditorLayoutPart, number>>
  }>({
    pending: !!initialButtonLocation,
    contentReady: false,
    target: 'button',
    animated: false,
    expectedButtonIdentity: initialButtonLocation ? buttonIdentityAt(config, initialButtonLocation) : '',
    positionedButtonIdentity: '',
    positions: {}
  })
  const [hostPath, setHostPath] = useState(sourcePath)
  const [exportPath, setExportPath] = useState('')
  const [showExport, setShowExport] = useState(false)
  const [moveDestination, setMoveDestination] = useState('')
  const [editError, setEditError] = useState<ConfigIssue | null>(null)
  const [pendingIds, setPendingIds] = useState<Readonly<Record<string, PendingIdEdit>>>(() => restorePendingIds(config, initialIdDrafts))
  const [operationError, setOperationError] = useState('')
  const [operationPending, setOperationPending] = useState(false)
  const [iconRequest, setIconRequest] = useState<IconInsertionRequest>()
  const activeIconRequest = useRef(iconRequest)
  activeIconRequest.current = iconRequest
  const [labelEditorRevision, setLabelEditorRevision] = useState(0)
  const [referenceGuide, setReferenceGuide] = useState<ReferenceGuide>()
  const [cleanupConfirmation, setCleanupConfirmation] = useState<CleanupConfirmation>()
  const operationInFlight = useRef(false)
  const observedConfig = useRef(config)
  const localChangeSignature = useRef<string | null>(null)
  const draftCallbacks = useRef({ onPendingEditsChange, onIdDraftsChange })
  draftCallbacks.current = { onPendingEditsChange, onIdDraftsChange }
  const busy = hostBusy || operationPending
  const hasPendingIds = Object.keys(pendingIds).length > 0
  const structuralBusy = busy || hasPendingIds
  const latestEditor = useRef({ config, busy, hasPendingIds })
  latestEditor.current = { config, busy, hasPendingIds }
  const idDrafts = useMemo(() => Object.fromEntries(Object.entries(pendingIds).map(([path, pending]) => [path, pending.value])), [pendingIds])
  const idDraftsSignature = JSON.stringify(idDrafts)

  useEffect(() => { setHostPath(sourcePath) }, [sourcePath])

  useEffect(() => () => { activeIconRequest.current = undefined }, [])

  useEffect(() => {
    if (observedConfig.current === config) return
    observedConfig.current = config
    const local = localChangeSignature.current === JSON.stringify(config)
    localChangeSignature.current = null
    if (local) return
    // A successful Load/Reload or Save may replace the controlled document.
    // Old field errors and index-based selections do not belong to that file.
    editorScroll.current.pending = false
    editorScroll.current.positionedButtonIdentity = ''
    editorScroll.current.positions = {}
    setTargetNotice('')
    setPendingIds({})
    setEditError(null)
    setOperationError('')
    setMenuSelection(Math.max(0, config.menus.findIndex((menu) => menu.id === config.rootMenuId)))
    setGroupSelection(0)
    setButtonSelection(0)
    setSelectionKind(initialButtonLocation ? 'button' : 'manager')
    setMoveDestination('')
    dismissIconPicker()
    setLabelEditorRevision((revision) => revision + 1)
    setReferenceGuide(undefined)
    setCleanupConfirmation(undefined)
    setHostPath(sourcePath)
  }, [config, sourcePath])

  useEffect(() => {
    draftCallbacks.current.onPendingEditsChange?.(hasPendingIds)
    return () => { draftCallbacks.current.onPendingEditsChange?.(false) }
  }, [hasPendingIds])

  useEffect(() => {
    draftCallbacks.current.onIdDraftsChange?.(idDrafts)
    // Do not clear recovery drafts on unmount: the parent may keep them.
  }, [idDraftsSignature])

  const menuIndex = Math.min(menuSelection, Math.max(0, config.menus.length - 1))
  const menu = config.menus[menuIndex]
  const groupIndex = Math.min(groupSelection, Math.max(0, (menu?.groups.length ?? 0) - 1))
  const group = menu?.groups[groupIndex]
  const buttonIndex = Math.min(buttonSelection, Math.max(0, (group?.buttons.length ?? 0) - 1))
  const button = group?.buttons[buttonIndex]
  const kind = selectionKind === 'button' && !button
    ? group ? 'group' : 'menu'
    : selectionKind === 'group' && !group ? 'menu' : selectionKind
  const menuPath = `menus[${menuIndex}]`
  const groupPath = `${menuPath}.groups[${groupIndex}]`
  const buttonPath = `${groupPath}.buttons[${buttonIndex}]`
  const groupLocation = { menuIndex, groupIndex }
  const buttonLocation = { ...groupLocation, buttonIndex }
  const buttonIdentity = button ? buttonIdentityAt(config, buttonLocation) : ''
  const issues = useMemo(() => validateActionPadConfig(config), [config])
  const menuAnalysis = useMemo(() => analyzeActionPadMenus(config), [config])
  const selectedMenuAnalysis = menuAnalysis.find((analysis) => analysis.menuIndex === menuIndex)
  const unusedMenuAnalysis = menuAnalysis.filter((analysis) => !analysis.reachable)
  const displayedIssues = [
    ...issues,
    ...Object.entries(pendingIds).map(([path, pending]) => ({ path, message: pending.message })),
    ...(editError ? [editError] : [])
  ]
  const valid = displayedIssues.length === 0
  const canWrite = connected && !busy && valid
  const deletionReason = menu ? menuDeletionReason(config, menuIndex) : undefined
  const groupDeleteReason = group ? groupDeletionReason(config, groupLocation) : undefined
  const destinations = config.menus.flatMap((candidate, candidateMenuIndex) =>
    candidate.groups.flatMap((candidateGroup, candidateGroupIndex) =>
      candidateMenuIndex === menuIndex && candidateGroupIndex === groupIndex ? [] : [{
        value: `${candidateMenuIndex}:${candidateGroupIndex}`,
        label: `${menuDisplayName(candidate)} / ${candidateGroup.id || 'Unnamed group'}`
      }]
    )
  )
  const destinationExists = destinations.some((candidate) => candidate.value === moveDestination)

  useEffect(() => {
    if (iconRequest && (busy || !fontLoaded || kind !== 'button' ||
      iconRequest.config !== config || iconRequest.buttonIdentity !== buttonIdentity)) {
      dismissIconPicker()
    }
  }, [iconRequest, busy, fontLoaded, kind, config, buttonIdentity])

  function canApply(edit: ActionPadEdit): boolean {
    const latest = latestEditor.current
    if (busy || latest.busy) return false
    // Native confirmation callbacks can outlive a host Load or reconnect.
    if (latest.config !== config) {
      setOperationError('The configuration changed while the confirmation was open. Review the new document and try again.')
      return false
    }
    const structural = !['update-menu', 'update-group', 'update-button', 'set-root-menu'].includes(edit.type)
    return !structural || !latest.hasPendingIds
  }

  function apply(edit: ActionPadEdit, path: string, after?: (next: ActionPadConfig) => void) {
    if (!canApply(edit)) return
    try {
      const next = editActionPad(config, edit)
      localChangeSignature.current = JSON.stringify(next)
      onChange(next)
      setEditError(null)
      setOperationError('')
      after?.(next)
    } catch (error) {
      setEditError({ path, message: error instanceof Error ? error.message : 'This change could not be applied.' })
    }
  }

  function applyId(edit: ActionPadEdit, path: string, value: string) {
    if (!canApply(edit)) return
    try {
      const next = editActionPad(config, edit)
      localChangeSignature.current = JSON.stringify(next)
      onChange(next)
      undoPendingId(path)
      setEditError(null)
      setOperationError('')
    } catch (error) {
      setPendingIds((previous) => ({
        ...previous,
        [path]: { value, message: error instanceof Error ? error.message : 'This ID could not be applied.' }
      }))
    }
  }

  function undoPendingId(path: string) {
    setPendingIds((previous) => {
      const next = { ...previous }
      delete next[path]
      return next
    })
  }

  function runOperation(operation: () => Promise<void>) {
    if (operationInFlight.current || hostBusy) return
    operationInFlight.current = true
    setOperationPending(true)
    setOperationError('')
    void (async () => {
      try {
        await operation()
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : 'The host operation failed. Your draft has been kept.')
      } finally {
        operationInFlight.current = false
        setOperationPending(false)
      }
    })()
  }

  function chooseMenu(index: number) {
    setMenuSelection(index)
    setGroupSelection(0)
    setButtonSelection(0)
    setSelectionKind('button')
    setMoveDestination('')
    setEditError(null)
    setReferenceGuide(undefined)
  }

  function chooseGroup(index: number) {
    setGroupSelection(index)
    setButtonSelection(0)
    setSelectionKind('button')
    setMoveDestination('')
    setEditError(null)
    setReferenceGuide(undefined)
  }

  function updateButton(patch: EditableButtonPatch, path: string) {
    apply({ type: 'update-button', location: buttonLocation, patch }, path)
  }

  function updateButtonStyles(patch: Partial<ActionButtonStyles>, path: string) {
    updateButton({ styles: patch }, path)
  }

  function dismissIconPicker() {
    activeIconRequest.current = undefined
    setIconRequest(undefined)
  }

  function chooseNerdFontIcon(insert: (icon: NerdFontIcon) => void) {
    if (!button || busy || !fontLoaded || latestEditor.current.config !== config) return
    const request = { config, buttonIdentity, insert }
    activeIconRequest.current = request
    setIconRequest(request)
  }

  function insertNerdFontIcon(icon: NerdFontIcon) {
    // Native picker callbacks may arrive after dismissal, another picker, or a
    // draft replacement. Never apply a captured run/cursor to a newer document.
    if (!iconRequest || activeIconRequest.current !== iconRequest) return
    const request = iconRequest
    dismissIconPicker()
    if (busy || latestEditor.current.busy || !fontLoaded ||
      latestEditor.current.config !== request.config || buttonIdentity !== request.buttonIdentity) return
    request.insert(icon)
  }

  function focusIssue(issue: ConfigIssue) {
    const indices = /^menus\[(\d+)\](?:\.groups\[(\d+)\](?:\.buttons\[(\d+)\])?)?/.exec(issue.path)
    setReferenceGuide(undefined)
    if (!indices) { setSelectionKind('menu'); return }
    setMenuSelection(Number(indices[1]))
    setGroupSelection(Number(indices[2] ?? 0))
    setButtonSelection(Number(indices[3] ?? 0))
    setSelectionKind(indices[3] !== undefined ? 'button' : indices[2] !== undefined ? 'group' : 'menu')
  }

  function scrollToEditorTarget() {
    const scroll = editorScroll.current
    const { workspace, details, button: buttonY } = scroll.positions
    const interactionY = scroll.target === 'button' ? 0 : scroll.positions[scroll.target]
    if (!scroll.pending || !scroll.contentReady || !scrollView.current ||
      scroll.expectedButtonIdentity !== scroll.positionedButtonIdentity ||
      workspace === undefined || details === undefined || buttonY === undefined || interactionY === undefined) return
    scroll.pending = false
    // These layouts are relative to successive ancestors. Summing them keeps
    // the target aligned in both the stacked and side-by-side editor layouts.
    scrollView.current.scrollTo({ y: workspace + details + buttonY + interactionY, animated: scroll.animated })
  }

  function recordEditorLayout(part: 'workspace' | 'details', y: number): void
  function recordEditorLayout(part: EditorScrollTarget, y: number, identity: string): void
  function recordEditorLayout(part: EditorLayoutPart, y: number, identity?: string) {
    const scroll = editorScroll.current
    if (part === 'button' || part === 'tap' || part === 'longPress') {
      if (!identity) return
      if (scroll.positionedButtonIdentity !== identity) {
        scroll.positionedButtonIdentity = identity
        delete scroll.positions.button
        delete scroll.positions.tap
        delete scroll.positions.longPress
      }
    }
    scroll.positions[part] = y
    scrollToEditorTarget()
  }

  function navigateToReference(
    location: ButtonLocation,
    gesture: 'tap' | 'longPress',
    interactionType: 'menu' | 'group',
    target: string
  ) {
    const sourceButton = config.menus[location.menuIndex]?.groups[location.groupIndex]?.buttons[location.buttonIndex]
    if (!sourceButton) {
      setOperationError('That source button no longer exists. Review the latest menu links and try again.')
      return
    }
    const identity = buttonIdentityAt(config, location)
    const scroll = editorScroll.current
    scroll.pending = true
    scroll.target = gesture
    scroll.animated = true
    scroll.expectedButtonIdentity = identity
    setMenuSelection(location.menuIndex)
    setGroupSelection(location.groupIndex)
    setButtonSelection(location.buttonIndex)
    setSelectionKind('button')
    setMoveDestination('')
    setEditError(null)
    setReferenceGuide({ buttonIdentity: identity, gesture, interactionType, target })
    requestAnimationFrame(scrollToEditorTarget)
  }

  function editManagedMenu(index: number) {
    setMenuSelection(index)
    setGroupSelection(0)
    setButtonSelection(0)
    setSelectionKind('menu')
    setMoveDestination('')
    setEditError(null)
    setReferenceGuide(undefined)
  }

  function deleteManagedMenu(index: number) {
    const candidate = config.menus[index]
    if (!candidate) return
    confirmRemoval(
      'Delete menu?',
      `Delete ${menuDisplayName(candidate)} and all its groups and buttons?`,
      () => apply({ type: 'delete-menu', menuIndex: index }, `menus[${index}]`, (next) => {
        setMenuSelection(Math.min(index, Math.max(0, next.menus.length - 1)))
        setGroupSelection(0)
        setButtonSelection(0)
        setSelectionKind('manager')
        setMoveDestination('')
        setReferenceGuide(undefined)
      })
    )
  }

  function openCleanupConfirmation() {
    if (busy || hasPendingIds || issues.length > 0 || unusedMenuAnalysis.length === 0) return
    const menus = unusedMenuAnalysis.flatMap(({ menuIndex: unusedIndex }) => {
      const unusedMenu = config.menus[unusedIndex]
      if (!unusedMenu) return []
      return [{
        id: unusedMenu.id,
        label: unusedMenu.label,
        groupCount: unusedMenu.groups.length,
        buttonCount: countMenuButtons(unusedMenu)
      }]
    })
    setCleanupConfirmation({
      config,
      menus,
      groupCount: menus.reduce((total, candidate) => total + candidate.groupCount, 0),
      buttonCount: menus.reduce((total, candidate) => total + candidate.buttonCount, 0)
    })
  }

  function removeUnusedMenus() {
    const confirmation = cleanupConfirmation
    setCleanupConfirmation(undefined)
    if (!confirmation) return
    if (confirmation.config !== config) {
      setOperationError('The configuration changed while the confirmation was open. Review the new document and try again.')
      return
    }
    const selectedMenuId = menu?.id
    apply({ type: 'delete-unused-menus' }, 'menus', (next) => {
      const survivingIndex = selectedMenuId === undefined ? -1 : next.menus.findIndex((candidate) => candidate.id === selectedMenuId)
      const rootIndex = next.menus.findIndex((candidate) => candidate.id === next.rootMenuId)
      setMenuSelection(Math.max(0, survivingIndex >= 0 ? survivingIndex : rootIndex))
      setGroupSelection(0)
      setButtonSelection(0)
      setSelectionKind('manager')
      setMoveDestination('')
      setReferenceGuide(undefined)
    })
  }

  return (
    <KeyboardAvoidingView behavior="height" style={styles.screen} testID="action-pad-editor">
      <View style={styles.header}>
        <View style={styles.titleBlock}>
          <Text accessibilityRole="header" style={styles.title}>Edit Action Pad</Text>
          <Text style={styles.muted}>{dirty || hasPendingIds ? 'Unsaved changes' : 'No unsaved changes'} · {connected ? 'Host connected' : 'Offline editing'}</Text>
        </View>
        <EditorButton disabled={busy} label="Cancel" onPress={onCancel} />
        <EditorButton
          disabled={!canWrite || hostPath.length === 0}
          label={busy ? 'Working…' : 'Save'}
          onPress={() => runOperation(() => onSave(hostPath))}
          primary
          testID="action-pad-editor-save"
        />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={(_width, height) => {
          editorScroll.current.contentReady = height > 0
          scrollToEditorTarget()
        }}
        ref={scrollView}
        style={styles.scroll}
        testID="action-pad-editor-scroll"
      >
        <View style={styles.card}>
          <FormField
            disabled={busy}
            fontLoaded={fontLoaded}
            label="Host YAML path"
            onChange={setHostPath}
            placeholder="~/.config/nvim/codey/action-pad.yaml"
            value={hostPath}
          />
          <View style={styles.actions}>
            <EditorButton
              disabled={!connected || busy || hostPath.length === 0}
              label={hostPath === sourcePath ? 'Load / Reload' : 'Load'}
              onPress={() => runOperation(() => onLoad(hostPath))}
            />
            <EditorButton disabled={busy} label={showExport ? 'Hide export' : 'Export copy…'} onPress={() => setShowExport(!showExport)} />
          </View>
          {showExport ? (
            <View style={styles.section}>
              <FormField
                disabled={busy}
                fontLoaded={fontLoaded}
                hint="Export writes a copy without activating it or changing the linked file."
                label="Export YAML path"
                onChange={setExportPath}
                placeholder="/path/to/action-pad-copy.yaml"
                value={exportPath}
              />
              <EditorButton disabled={!canWrite || exportPath.length === 0} label="Write exported copy" onPress={() => runOperation(() => onExport(exportPath))} />
            </View>
          ) : null}
          <Text style={styles.muted}>Paths are on the Neovim host. Use an absolute path or ~/. Save activates the draft only after the file is written.</Text>
          {!connected ? <Text style={styles.notice}>You can edit offline. Reconnect to load, save, or export; drafts are never uploaded automatically.</Text> : null}
          {message ? <Text accessibilityLiveRegion="polite" style={styles.notice}>{message}</Text> : null}
          {targetNotice ? <Text accessibilityLiveRegion="polite" style={styles.notice} testID="action-pad-editor-target-notice">{targetNotice}</Text> : null}
          {operationError ? <Text accessibilityLiveRegion="polite" style={styles.error}>{operationError}</Text> : null}
        </View>

        {displayedIssues.length > 0 ? (
          <View style={[styles.card, styles.errorCard]}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>Resolve {displayedIssues.length} {displayedIssues.length === 1 ? 'issue' : 'issues'} before saving</Text>
            {hasPendingIds ? <Text style={styles.muted}>An ID is still being edited. Finish or undo it before reordering, moving, or deleting items.</Text> : null}
            {displayedIssues.map((issue, index) => (
              <Pressable
                accessibilityLabel={`${issue.path}: ${issue.message}`}
                accessibilityRole="button"
                key={`${issue.path}-${index}`}
                onPress={() => focusIssue(issue)}
                style={styles.issue}
              >
                <Text style={styles.error}>{issue.message}</Text>
                <Text style={styles.muted}>{issue.path}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <View onLayout={(event) => recordEditorLayout('workspace', event.nativeEvent.layout.y)} style={[styles.workspace, wide && styles.wideWorkspace]} testID="action-pad-editor-workspace">
          <View style={[styles.navigation, wide && styles.wideNavigation]}>
            <View style={[styles.selectors, wide && styles.verticalSelectors]}>
              <View style={styles.selector}>
                <Picker
                  disabled={busy || config.menus.length === 0}
                  fontLoaded={fontLoaded}
                  label="Menu"
                  onChange={(value) => chooseMenu(Number(value))}
                  options={config.menus.map((candidate, index) => ({ value: String(index), label: `${menuDisplayName(candidate)}${candidate.id === config.rootMenuId ? ' · Root' : ''}` }))}
                  placeholder="No menus"
                  value={menu ? String(menuIndex) : ''}
                />
                <EditorButton disabled={structuralBusy} label="Add menu" onPress={() => apply({ type: 'add-menu' }, 'menus', (next) => {
                  chooseMenu(next.menus.length - 1)
                  setSelectionKind('menu')
                })} />
              </View>
              <View style={styles.selector}>
                <Picker
                  disabled={busy || !group}
                  fontLoaded={fontLoaded}
                  label="Group"
                  onChange={(value) => chooseGroup(Number(value))}
                  options={menu?.groups.map((candidate, index) => ({ value: String(index), label: candidate.id || 'Unnamed group' })) ?? []}
                  placeholder="No groups"
                  value={group ? String(groupIndex) : ''}
                />
                <EditorButton disabled={structuralBusy || !menu} label="Add group" onPress={() => apply({ type: 'add-group', menuIndex }, `${menuPath}.groups`, (next) => {
                  setGroupSelection((next.menus[menuIndex]?.groups.length ?? 1) - 1)
                  setButtonSelection(0)
                  setSelectionKind('group')
                })} />
              </View>
              <View style={styles.selector}>
                <Picker
                  disabled={busy || !button}
                  fontLoaded={fontLoaded}
                  label="Button"
                  onChange={(value) => { setButtonSelection(Number(value)); setSelectionKind('button'); setEditError(null); setMoveDestination(''); setReferenceGuide(undefined) }}
                  options={group?.buttons.map((candidate, index) => ({ value: String(index), label: buttonDisplayName(candidate) })) ?? []}
                  placeholder="No buttons"
                  value={button ? String(buttonIndex) : ''}
                />
                <EditorButton disabled={structuralBusy || !group} label="Add button" onPress={() => apply({ type: 'add-button', location: groupLocation }, `${groupPath}.buttons`, (next) => {
                  setButtonSelection((next.menus[menuIndex]?.groups[groupIndex]?.buttons.length ?? 1) - 1)
                  setSelectionKind('button')
                })} />
                <EditorButton disabled={structuralBusy || !button} label="Duplicate button" onPress={() => apply({ type: 'duplicate-button', location: buttonLocation }, buttonPath, () => {
                  setButtonSelection(buttonIndex + 1)
                  setSelectionKind('button')
                  setMoveDestination('')
                })} />
              </View>
            </View>
            <View style={[styles.actions, wide && styles.verticalSelectors]}>
              <EditorButton disabled={busy} label="Manage menus" onPress={() => { setSelectionKind('manager'); setReferenceGuide(undefined) }} selected={kind === 'manager'} />
              <EditorButton disabled={busy || !menu} label="Menu settings" onPress={() => { setSelectionKind('menu'); setReferenceGuide(undefined) }} selected={kind === 'menu'} />
              <EditorButton disabled={busy || !group} label="Group settings" onPress={() => { setSelectionKind('group'); setReferenceGuide(undefined) }} selected={kind === 'group'} />
              <EditorButton disabled={busy || !button} label="Button settings" onPress={() => { setSelectionKind('button'); setReferenceGuide(undefined) }} selected={kind === 'button'} />
            </View>
          </View>

          <View onLayout={(event) => recordEditorLayout('details', event.nativeEvent.layout.y)} style={styles.details} testID="action-pad-editor-details">
            {kind === 'manager' ? (
              <View style={styles.card} testID="action-pad-menu-manager">
                <Text accessibilityRole="header" style={styles.sectionTitle}>Manage menus</Text>
                <Text style={styles.muted}>Removing a launcher or clearing its action does not remove the destination menu. Delete menu definitions here when they are no longer needed.</Text>
                <Text style={styles.muted}>Changes update this recoverable draft immediately. Save writes the YAML and activates the edited Action Pad.</Text>

                <View style={styles.menuList}>
                  {menuAnalysis.map((analysis) => {
                    const candidate = config.menus[analysis.menuIndex]
                    if (!candidate) return null
                    const root = candidate.id === config.rootMenuId
                    const displayName = menuDisplayName(candidate)
                    const buttonCount = countMenuButtons(candidate)
                    const sourceMenuIndexes = [...new Set(analysis.incoming.map((reference) => reference.location.menuIndex))]
                    const candidateDeletionReason = root
                      ? 'Choose another root menu before deleting this menu.'
                      : sourceMenuIndexes.length > 0
                        ? `Remove menu links from ${sourceMenuIndexes.map((sourceIndex) => {
                          const sourceMenu = config.menus[sourceIndex]
                          return sourceMenu?.label || sourceMenu?.id || `menu ${sourceIndex + 1}`
                        }).join(', ')} before deleting this menu.`
                        : undefined
                    const status = root ? 'Root · Reachable' : analysis.reachable ? 'Reachable' : 'Unused'
                    return (
                      <View key={`${candidate.id}-${analysis.menuIndex}`} style={styles.menuRow} testID={`action-pad-menu-row-${analysis.menuIndex}`}>
                        <View style={styles.menuRowHeader}>
                          <View style={styles.menuRowTitle}>
                            <Text style={[styles.menuName, fontLoaded && styles.nerdFont]}>{displayName}</Text>
                            <Text style={analysis.reachable ? styles.muted : styles.notice}>{status}</Text>
                          </View>
                          <Text style={styles.muted}>
                            {candidate.groups.length} {candidate.groups.length === 1 ? 'group' : 'groups'} · {buttonCount} {buttonCount === 1 ? 'button' : 'buttons'} · {analysis.incoming.length} incoming {analysis.incoming.length === 1 ? 'link' : 'links'}
                          </Text>
                        </View>
                        <View style={styles.actions}>
                          <EditorButton disabled={busy} label={`Edit ${displayName}`} onPress={() => editManagedMenu(analysis.menuIndex)} />
                          <EditorButton
                            disabled={busy || root}
                            label={root ? `${displayName} is root` : `Make ${displayName} root`}
                            onPress={() => apply({ type: 'set-root-menu', menuIndex: analysis.menuIndex }, 'rootMenuId')}
                            selected={root}
                          />
                          <EditorButton
                            danger
                            disabled={structuralBusy || Boolean(candidateDeletionReason)}
                            label={`Delete ${displayName}`}
                            onPress={() => deleteManagedMenu(analysis.menuIndex)}
                          />
                        </View>
                        {candidateDeletionReason ? <Text style={[styles.muted, fontLoaded && styles.nerdFont]}>{candidateDeletionReason}</Text> : null}
                        {analysis.incoming.length > 0 ? (
                          <MenuReferenceList
                            busy={busy}
                            config={config}
                            onOpen={(reference) => navigateToReference(reference.location, reference.gesture, reference.interactionType, displayName)}
                            references={analysis.incoming}
                            target={displayName}
                            testIDPrefix={`action-pad-reference-${analysis.menuIndex}`}
                          />
                        ) : null}
                      </View>
                    )
                  })}
                  {config.menus.length === 0 ? <Text style={styles.muted}>No menu definitions yet. Add a menu to start building your Action Pad.</Text> : null}
                </View>

                <View style={styles.cleanupSection}>
                  <Text style={styles.label}>Unused menu cleanup</Text>
                  <Text style={styles.muted}>Unused menus cannot be reached from the root through any Tap or Hold Menu or Group action.</Text>
                  <EditorButton
                    danger
                    disabled={busy || hasPendingIds || issues.length > 0 || unusedMenuAnalysis.length === 0}
                    label={unusedMenuAnalysis.length === 0 ? 'No unused menus' : `Remove ${unusedMenuAnalysis.length} unused ${unusedMenuAnalysis.length === 1 ? 'menu' : 'menus'}…`}
                    onPress={openCleanupConfirmation}
                    testID="action-pad-remove-unused-menus"
                  />
                  {hasPendingIds ? <Text style={styles.muted}>Finish or undo pending ID edits before removing menus.</Text> : null}
                  {issues.length > 0 ? <Text style={styles.muted}>Resolve configuration issues before removing unused menus.</Text> : null}
                  {!hasPendingIds && issues.length === 0 && unusedMenuAnalysis.length === 0 ? <Text style={styles.muted}>Every menu is reachable from the root.</Text> : null}
                </View>
              </View>
            ) : null}

            {kind === 'menu' && menu ? (
              <View style={styles.card} testID="action-pad-menu-form">
                <Text accessibilityRole="header" style={styles.sectionTitle}>Menu settings</Text>
                <FormField disabled={busy} fontLoaded={fontLoaded} issues={displayedIssues} label="Menu label" onChange={(label) => apply({ type: 'update-menu', menuIndex, patch: { label } }, `${menuPath}.label`)} path={`${menuPath}.label`} value={menu.label} />
                <FormField disabled={busy} fontLoaded={fontLoaded} hint="Stable ID used by menu links. Renaming updates those links automatically." issues={displayedIssues} label="Menu ID" onChange={(id) => applyId({ type: 'update-menu', menuIndex, patch: { id } }, `${menuPath}.id`, id)} onUndo={pendingIds[`${menuPath}.id`] ? () => undoPendingId(`${menuPath}.id`) : undefined} path={`${menuPath}.id`} value={pendingIds[`${menuPath}.id`]?.value ?? menu.id} />
                <EditorButton disabled={busy || menu.id === config.rootMenuId} label={menu.id === config.rootMenuId ? 'This is the root menu' : 'Use as root menu'} onPress={() => apply({ type: 'set-root-menu', menuIndex }, 'rootMenuId')} selected={menu.id === config.rootMenuId} />
                <FieldIssues issues={displayedIssues} path="rootMenuId" />
                <ReorderControls busy={structuralBusy} count={config.menus.length} index={menuIndex} item="menu" onMove={(direction) => apply({ type: 'reorder-menu', menuIndex, direction }, menuPath, () => setMenuSelection(menuIndex + direction))} />
                <Text style={styles.muted}>{menu.groups.length} {menu.groups.length === 1 ? 'group' : 'groups'} in this menu.</Text>
                <EditorButton danger disabled={structuralBusy || Boolean(deletionReason)} label="Delete menu" onPress={() => confirmRemoval('Delete menu?', `Delete ${menuDisplayName(menu)} and all its groups and buttons?`, () => apply({ type: 'delete-menu', menuIndex }, menuPath, (next) => chooseMenu(Math.max(0, Math.min(menuIndex, next.menus.length - 1)))))} />
                {deletionReason ? <Text style={[styles.muted, fontLoaded && styles.nerdFont]}>{deletionReason}</Text> : null}
                {selectedMenuAnalysis && selectedMenuAnalysis.incoming.length > 0 ? (
                  <MenuReferenceList
                    busy={busy}
                    config={config}
                    onOpen={(reference) => navigateToReference(reference.location, reference.gesture, reference.interactionType, menuDisplayName(menu))}
                    references={selectedMenuAnalysis.incoming}
                    target={menuDisplayName(menu)}
                    testIDPrefix="action-pad-menu-form-reference"
                  />
                ) : null}
              </View>
            ) : null}

            {kind === 'group' && group ? (
              <View style={styles.card} testID="action-pad-group-form">
                <Text accessibilityRole="header" style={styles.sectionTitle}>Group settings</Text>
                <FormField disabled={busy} fontLoaded={fontLoaded} hint="Group IDs identify the ordered sections of a menu. Renaming updates group links automatically." issues={displayedIssues} label="Group ID" onChange={(id) => applyId({ type: 'update-group', location: groupLocation, id }, `${groupPath}.id`, id)} onUndo={pendingIds[`${groupPath}.id`] ? () => undoPendingId(`${groupPath}.id`) : undefined} path={`${groupPath}.id`} value={pendingIds[`${groupPath}.id`]?.value ?? group.id} />
                <ReorderControls busy={structuralBusy} count={menu?.groups.length ?? 0} index={groupIndex} item="group" onMove={(direction) => apply({ type: 'reorder-group', location: groupLocation, direction }, groupPath, () => setGroupSelection(groupIndex + direction))} />
                <Text style={styles.muted}>{group.buttons.length} {group.buttons.length === 1 ? 'button' : 'buttons'} in this group. Add a button or select an existing one above.</Text>
                <EditorButton danger disabled={structuralBusy || Boolean(groupDeleteReason)} label="Delete group" onPress={() => {
                  const remove = () => apply({ type: 'delete-group', location: groupLocation }, groupPath, () => { setGroupSelection(Math.max(0, groupIndex - 1)); setButtonSelection(0) })
                  if (group.buttons.length === 0) remove()
                  else confirmRemoval('Delete group?', `Delete “${group.id}” and its ${group.buttons.length} buttons?`, remove)
                }} />
                {groupDeleteReason ? <Text style={[styles.muted, fontLoaded && styles.nerdFont]}>{groupDeleteReason}</Text> : null}
              </View>
            ) : null}

            {kind === 'button' && button ? (
              <View onLayout={(event) => recordEditorLayout('button', event.nativeEvent.layout.y, buttonIdentity)} style={styles.card} testID="action-pad-button-form">
                <Text accessibilityRole="header" style={styles.sectionTitle}>Button settings</Text>
                {referenceGuide?.buttonIdentity === buttonIdentity ? (
                  <Text accessibilityLiveRegion="polite" style={styles.notice}>The exact blocking action is highlighted below. Change its action type or destination to remove the menu reference.</Text>
                ) : null}
                <ActionButtonLabelEditor
                  key={`${buttonIdentity}:${labelEditorRevision}`}
                  buttonStyles={button.styles}
                  disabled={busy}
                  fontError={fontError}
                  fontLoaded={fontLoaded}
                  issues={displayedIssues}
                  label={button.label}
                  onChange={(label) => updateButton({ label }, `${buttonPath}.label`)}
                  onInsertIcon={chooseNerdFontIcon}
                  path={`${buttonPath}.label`}
                />
                {fontError ? <Text accessibilityLiveRegion="polite" style={styles.notice}>The bundled Nerd Font could not be loaded, so icon previews are unavailable.</Text> : null}
                <FormField disabled={busy} fontLoaded={fontLoaded} issues={displayedIssues} label="Button ID" onChange={(id) => applyId({ type: 'update-button', location: buttonLocation, patch: { id } }, `${buttonPath}.id`, id)} onUndo={pendingIds[`${buttonPath}.id`] ? () => undoPendingId(`${buttonPath}.id`) : undefined} path={`${buttonPath}.id`} value={pendingIds[`${buttonPath}.id`]?.value ?? button.id} />
                <Choices disabled={busy} label="Button size" onChange={(size) => updateButtonStyles({ size: size as ActionButtonStyles['size'] }, `${buttonPath}.styles.size`)} options={ACTION_BUTTON_SIZE_OPTIONS} value={button.styles.size} />
                <Text style={styles.muted}>Choose whole, half, third, quarter, or fifth width in the Action Pad rail.</Text>
                <FieldIssues issues={displayedIssues} path={`${buttonPath}.styles.size`} />
                <Choices
                  disabled={busy}
                  label="Button appearance"
                  onChange={(appearance) => updateButtonStyles({ appearance: appearance === 'filled' ? undefined : 'outline' }, `${buttonPath}.styles.appearance`)}
                  options={[{ value: 'filled', label: 'Filled' }, { value: 'outline', label: 'Outline' }]}
                  value={button.styles.appearance ?? 'filled'}
                />
                <Text style={styles.muted}>Outline uses a transparent background and the same thin muted border as Edit Action Pad.</Text>
                <FieldIssues issues={displayedIssues} path={`${buttonPath}.styles.appearance`} />
                <ColorControl
                  allowTransparent
                  disabled={busy}
                  issues={displayedIssues}
                  label="Button background color"
                  onChange={(backgroundColor) => updateButtonStyles({ backgroundColor }, `${buttonPath}.styles.backgroundColor`)}
                  path={`${buttonPath}.styles.backgroundColor`}
                  value={button.styles.backgroundColor}
                />
                <ColorControl
                  allowTransparent
                  disabled={busy}
                  issues={displayedIssues}
                  label="Button outline color"
                  onChange={(outlineColor) => updateButtonStyles({ outlineColor }, `${buttonPath}.styles.outlineColor`)}
                  path={`${buttonPath}.styles.outlineColor`}
                  value={button.styles.outlineColor}
                />
                <FormField disabled={busy} fontLoaded={fontLoaded} hint="Leave blank to use the button label." issues={displayedIssues} label="Accessibility label" onChange={(accessibilityLabel) => updateButton({ accessibilityLabel: accessibilityLabel || undefined }, `${buttonPath}.accessibilityLabel`)} path={`${buttonPath}.accessibilityLabel`} value={button.accessibilityLabel ?? ''} />
                {!button.accessibilityLabel?.trim() && containsPrivateUseGlyph(button.label) ? (
                  <Text accessibilityLiveRegion="polite" style={styles.notice} testID="action-pad-label-accessibility-warning">
                    This label contains a Nerd Font icon. Add a human-readable Accessibility label for screen readers.
                  </Text>
                ) : null}
                <FormField disabled={busy} fontLoaded={fontLoaded} issues={displayedIssues} label="Accessibility hint" multiline onChange={(accessibilityHint) => updateButton({ accessibilityHint: accessibilityHint || undefined }, `${buttonPath}.accessibilityHint`)} path={`${buttonPath}.accessibilityHint`} value={button.accessibilityHint ?? ''} />
                <InteractionForm
                  action={button.tap}
                  config={config}
                  disabled={busy}
                  fontLoaded={fontLoaded}
                  gesture="Tap"
                  guide={referenceGuide?.buttonIdentity === buttonIdentity && referenceGuide.gesture === 'tap'
                    ? `This Tap ${referenceGuide.interactionType === 'menu' ? 'Menu' : 'Group'} action links to ${referenceGuide.target}.`
                    : undefined}
                  issues={displayedIssues}
                  menuId={menu?.id ?? ''}
                  onChange={(tap) => { updateButton({ tap }, `${buttonPath}.tap`); setReferenceGuide(undefined) }}
                  onLayout={(y) => recordEditorLayout('tap', y, buttonIdentity)}
                  path={`${buttonPath}.tap`}
                  testID="action-pad-interaction-tap"
                />
                <InteractionForm
                  action={button.longPress}
                  config={config}
                  disabled={busy}
                  fontLoaded={fontLoaded}
                  gesture="Hold"
                  guide={referenceGuide?.buttonIdentity === buttonIdentity && referenceGuide.gesture === 'longPress'
                    ? `This Hold ${referenceGuide.interactionType === 'menu' ? 'Menu' : 'Group'} action links to ${referenceGuide.target}.`
                    : undefined}
                  issues={displayedIssues}
                  menuId={menu?.id ?? ''}
                  onChange={(longPress) => { updateButton({ longPress }, `${buttonPath}.longPress`); setReferenceGuide(undefined) }}
                  onLayout={(y) => recordEditorLayout('longPress', y, buttonIdentity)}
                  path={`${buttonPath}.longPress`}
                  testID="action-pad-interaction-longPress"
                />
                <ReorderControls busy={structuralBusy} count={group?.buttons.length ?? 0} index={buttonIndex} item="button" onMove={(direction) => apply({ type: 'reorder-button', location: buttonLocation, direction }, buttonPath, () => setButtonSelection(buttonIndex + direction))} />
                {destinations.length > 0 ? (
                  <View style={styles.section}>
                    <Picker disabled={structuralBusy} fontLoaded={fontLoaded} label="Destination group" onChange={setMoveDestination} options={destinations} placeholder="Choose a group to move this button" value={destinationExists ? moveDestination : ''} />
                    <EditorButton disabled={structuralBusy || !destinationExists} label="Move to group" onPress={() => {
                      const [destinationMenu = 0, destinationGroup = 0] = moveDestination.split(':').map(Number)
                      const destinationButton = config.menus[destinationMenu]?.groups[destinationGroup]?.buttons.length ?? 0
                      apply({ type: 'move-button', location: buttonLocation, destination: { menuIndex: destinationMenu, groupIndex: destinationGroup } }, buttonPath, () => {
                        setMenuSelection(destinationMenu)
                        setGroupSelection(destinationGroup)
                        setButtonSelection(destinationButton)
                        setMoveDestination('')
                      })
                    }} />
                  </View>
                ) : <Text style={styles.muted}>Add another group to move this button to a different section.</Text>}
                <EditorButton danger disabled={structuralBusy} label="Delete button" onPress={() => confirmRemoval('Delete button?', `Delete “${plainActionButtonLabel(button.label)}”?`, () => apply({ type: 'delete-button', location: buttonLocation }, buttonPath, () => setButtonSelection(Math.max(0, buttonIndex - 1))))} />
              </View>
            ) : null}

            {!menu ? <Text style={styles.muted}>Add a menu to start building your Action Pad.</Text> : null}

          </View>
        </View>
      </ScrollView>
      {cleanupConfirmation ? (
        <Modal
          animationType="fade"
          onRequestClose={() => setCleanupConfirmation(undefined)}
          transparent
          visible
        >
          <View style={styles.modalBackdrop}>
            <View accessibilityViewIsModal style={styles.confirmationCard} testID="action-pad-cleanup-confirmation">
              <Text accessibilityRole="header" style={styles.sectionTitle}>Remove unused menus?</Text>
              <Text style={styles.muted}>This removes the following unreachable menu definitions and everything inside them from the draft.</Text>
              <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled style={styles.confirmationList}>
                {cleanupConfirmation.menus.map((candidate, index) => (
                  <View key={`${candidate.id}-${index}`} style={styles.confirmationRow}>
                    <Text style={[styles.menuName, fontLoaded && styles.nerdFont]}>{menuDisplayName(candidate)}</Text>
                    <Text style={styles.muted}>
                      {candidate.groupCount} {candidate.groupCount === 1 ? 'group' : 'groups'} · {candidate.buttonCount} {candidate.buttonCount === 1 ? 'button' : 'buttons'}
                    </Text>
                  </View>
                ))}
              </ScrollView>
              <Text style={styles.notice}>
                Total: {cleanupConfirmation.menus.length} {cleanupConfirmation.menus.length === 1 ? 'menu' : 'menus'}, {cleanupConfirmation.groupCount} {cleanupConfirmation.groupCount === 1 ? 'group' : 'groups'}, and {cleanupConfirmation.buttonCount} {cleanupConfirmation.buttonCount === 1 ? 'button' : 'buttons'}.
              </Text>
              <Text style={styles.muted}>You can still discard the draft with Cancel. The live Action Pad changes only after Save.</Text>
              <View style={styles.actions}>
                <EditorButton disabled={busy} label="Keep menus" onPress={() => setCleanupConfirmation(undefined)} />
                <EditorButton
                  danger
                  disabled={busy}
                  label={`Delete ${cleanupConfirmation.menus.length} unused ${cleanupConfirmation.menus.length === 1 ? 'menu' : 'menus'}`}
                  onPress={removeUnusedMenus}
                  testID="action-pad-confirm-remove-unused-menus"
                />
              </View>
            </View>
          </View>
        </Modal>
      ) : null}
      <NerdFontIconPicker
        onDismiss={dismissIconPicker}
        onSelect={insertNerdFontIcon}
        visible={!!iconRequest && iconRequest.config === config && iconRequest.buttonIdentity === buttonIdentity && kind === 'button' && fontLoaded && !busy}
      />
    </KeyboardAvoidingView>
  )
}

function menuDisplayName(menu: { readonly id: string; readonly label: string }): string {
  return `${menu.label || 'Unnamed menu'} (${menu.id || 'no ID'})`
}

function buttonDisplayName(button: { readonly id: string; readonly label: ActionButtonLabelValue }): string {
  return `${plainActionButtonLabel(button.label) || 'Unnamed button'} (${button.id || 'no ID'})`
}

function countMenuButtons(menu: ActionPadConfig['menus'][number]): number {
  return menu.groups.reduce((total, group) => total + group.buttons.length, 0)
}

function buttonIdentityAt(config: ActionPadConfig, location: ButtonLocation): string {
  const menu = config.menus[location.menuIndex]
  const group = menu?.groups[location.groupIndex]
  const button = group?.buttons[location.buttonIndex]
  if (!menu || !group || !button) return ''
  return JSON.stringify([location.menuIndex, menu.id, location.groupIndex, group.id, location.buttonIndex, button.id])
}

function referenceSourceDisplay(config: ActionPadConfig, location: ButtonLocation): string {
  const menu = config.menus[location.menuIndex]
  const group = menu?.groups[location.groupIndex]
  const button = group?.buttons[location.buttonIndex]
  if (!menu || !group || !button) return 'Missing source button'
  return `${menuDisplayName(menu)} / ${group.id || 'Unnamed group'} / ${buttonDisplayName(button)}`
}

function MenuReferenceList({ busy, config, onOpen, references, target, testIDPrefix }: {
  readonly busy: boolean
  readonly config: ActionPadConfig
  readonly onOpen: (reference: MenuReference) => void
  readonly references: readonly MenuReference[]
  readonly target: string
  readonly testIDPrefix: string
}) {
  const [page, setPage] = useState<number | null>(null)
  useEffect(() => { setPage(null) }, [references, target])
  const pageCount = Math.max(1, Math.ceil(references.length / MENU_REFERENCE_PAGE_SIZE))
  const currentPage = Math.min(page ?? 0, pageCount - 1)
  const firstReference = currentPage * MENU_REFERENCE_PAGE_SIZE
  const visibleReferences = page === null
    ? []
    : references.slice(firstReference, firstReference + MENU_REFERENCE_PAGE_SIZE)
  return (
    <View style={styles.referenceList}>
      <Text style={styles.label}>Blocking references</Text>
      {page === null ? (
        <EditorButton
          disabled={busy}
          label={`Show ${references.length} blocking ${references.length === 1 ? 'reference' : 'references'} for ${target}`}
          onPress={() => setPage(0)}
        />
      ) : (
        <>
          <Text style={styles.muted}>
            Showing {firstReference + 1}–{firstReference + visibleReferences.length} of {references.length}.
          </Text>
          {visibleReferences.map((reference, pageIndex) => {
            const referenceIndex = firstReference + pageIndex
            const source = referenceSourceDisplay(config, reference.location)
            const gesture = reference.gesture === 'tap' ? 'Tap' : 'Hold'
            const interaction = reference.interactionType === 'menu' ? 'Menu' : 'Group'
            return (
              <EditorButton
                disabled={busy}
                key={`${reference.location.menuIndex}:${reference.location.groupIndex}:${reference.location.buttonIndex}:${reference.gesture}:${reference.interactionType}`}
                label={`${source} · ${gesture} ${interaction} action`}
                onPress={() => onOpen(reference)}
                testID={`${testIDPrefix}-${referenceIndex}`}
              />
            )
          })}
          <View style={styles.actions}>
            <EditorButton disabled={busy || currentPage === 0} label={`Previous references for ${target}`} onPress={() => setPage(currentPage - 1)} />
            <EditorButton disabled={busy || currentPage >= pageCount - 1} label={`Next references for ${target}`} onPress={() => setPage(currentPage + 1)} />
            <EditorButton disabled={busy} label={`Hide references for ${target}`} onPress={() => setPage(null)} />
          </View>
        </>
      )}
    </View>
  )
}

function findInitialButton(config: ActionPadConfig, target: ActionPadButtonTarget | undefined): ButtonLocation | undefined {
  if (!target) return undefined
  let match: ButtonLocation | undefined
  // ID scopes matter: imported groups/buttons can legitimately share an ID.
  // Incomplete recovery drafts may also contain ambiguous tuples; never guess.
  for (const [menuIndex, menu] of config.menus.entries()) {
    if (menu.id !== target.menuId) continue
    for (const [groupIndex, group] of menu.groups.entries()) {
      if (group.id !== target.groupId) continue
      for (const [buttonIndex, button] of group.buttons.entries()) {
        if (button.id !== target.buttonId) continue
        if (match) return undefined
        match = { menuIndex, groupIndex, buttonIndex }
      }
    }
  }
  return match
}

function InteractionForm({ action, config, disabled, fontLoaded, gesture, guide, issues, menuId, onChange, onLayout, path, testID }: {
  readonly action: EditableInteraction | undefined
  readonly config: ActionPadConfig
  readonly disabled: boolean
  readonly fontLoaded: boolean
  readonly gesture: 'Tap' | 'Hold'
  readonly guide?: string
  readonly issues: readonly ConfigIssue[]
  readonly menuId: string
  readonly onChange: (action: EditableInteraction | undefined) => void
  readonly onLayout: (y: number) => void
  readonly path: string
  readonly testID: string
}) {
  function selectType(type: string) {
    if (type === (action?.type ?? 'none')) return
    const after = action?.after ?? 'stay'
    switch (type) {
      case 'none': onChange(undefined); break
      case 'input': onChange({ type, nvimInput: '', after }); break
      case 'menu': onChange({ type, menuId: '', after }); break
      case 'group': onChange({ type, menuId: '', groupId: '', after }); break
      case 'back':
      case 'keyboard': onChange({ type, after })
    }
  }
  return (
    <View
      onLayout={(event) => onLayout(event.nativeEvent.layout.y)}
      style={[styles.interaction, guide && styles.guidedInteraction]}
      testID={testID}
    >
      {guide ? <Text accessibilityLiveRegion="polite" style={styles.notice}>{guide} Change this action or destination to remove the reference.</Text> : null}
      <Choices disabled={disabled} label={`${gesture} action`} onChange={selectType} options={[{ value: 'none', label: 'None' }, { value: 'input', label: 'Input' }, { value: 'menu', label: 'Menu' }, { value: 'group', label: 'Group' }, { value: 'back', label: 'Back' }, { value: 'keyboard', label: 'Keyboard' }]} value={action?.type ?? 'none'} />
      <FieldIssues issues={issues} path={path} />
      <FieldIssues issues={issues} path={`${path}.type`} />
      {action?.type === 'input' ? <FormField disabled={disabled} fontLoaded={fontLoaded} hint="Use Neovim key notation, for example <C-w>h or <Space>sg. Spaces and line breaks are preserved exactly." issues={issues} label={`${gesture} Neovim input`} multiline onChange={(nvimInput) => onChange({ ...action, nvimInput })} path={`${path}.nvimInput`} value={action.nvimInput} /> : null}
      {action?.type === 'menu' ? (
        <View style={styles.section}>
          <Picker disabled={disabled} fontLoaded={fontLoaded} label={`${gesture} menu`} onChange={(nextMenuId) => onChange({ ...action, menuId: nextMenuId })} options={config.menus.filter((menu) => menu.id !== menuId).map((menu) => ({ value: menu.id, label: `${menu.label || 'Unnamed menu'} (${menu.id})` }))} placeholder={action.menuId || 'Choose a menu'} value={action.menuId} />
          <FieldIssues issues={issues} path={`${path}.menuId`} />
        </View>
      ) : null}
      {action?.type === 'group' ? (
        <GroupInteractionDestination
          action={action}
          config={config}
          disabled={disabled}
          fontLoaded={fontLoaded}
          gesture={gesture}
          issues={issues}
          menuId={menuId}
          onChange={onChange}
          path={path}
        />
      ) : null}
      {action ? (
        <View style={styles.section}>
          <Choices disabled={disabled} label={`${gesture} after`} onChange={(after) => onChange({ ...action, after: after as 'root' | 'stay' })} options={[{ value: 'stay', label: 'Stay' }, { value: 'root', label: 'Return to root' }]} value={action.after} />
          <FieldIssues issues={issues} path={`${path}.after`} />
        </View>
      ) : null}
    </View>
  )
}

function GroupInteractionDestination({ action, config, disabled, fontLoaded, gesture, issues, menuId, onChange, path }: {
  readonly action: Extract<EditableInteraction, { readonly type: 'group' }>
  readonly config: ActionPadConfig
  readonly disabled: boolean
  readonly fontLoaded: boolean
  readonly gesture: 'Tap' | 'Hold'
  readonly issues: readonly ConfigIssue[]
  readonly menuId: string
  readonly onChange: (action: EditableInteraction | undefined) => void
  readonly path: string
}) {
  const destinationMenu = config.menus.find((menu) => menu.id === action.menuId)
  return (
    <View style={styles.section}>
      <Picker
        disabled={disabled}
        fontLoaded={fontLoaded}
        label={`${gesture} destination menu`}
        onChange={(nextMenuId) => onChange(nextMenuId === action.menuId
          ? action
          : { ...action, menuId: nextMenuId, groupId: '' })}
        options={config.menus.filter((menu) => menu.id !== menuId).map((menu) => ({ value: menu.id, label: `${menu.label || 'Unnamed menu'} (${menu.id})` }))}
        placeholder={action.menuId || 'Choose a destination menu'}
        value={action.menuId}
      />
      <FieldIssues issues={issues} path={`${path}.menuId`} />
      <Picker
        disabled={disabled || destinationMenu === undefined}
        fontLoaded={fontLoaded}
        label={`${gesture} destination group`}
        onChange={(groupId) => onChange({ ...action, groupId })}
        options={destinationMenu?.groups.map((group) => ({ value: group.id, label: group.id || 'Unnamed group' })) ?? []}
        placeholder={action.groupId || (destinationMenu ? 'Choose a destination group' : 'Choose a destination menu first')}
        value={action.groupId}
      />
      <FieldIssues issues={issues} path={`${path}.groupId`} />
    </View>
  )
}

interface LabelRunInputState {
  readonly key: number
  input: TextInput | null
  selection?: LabelTextSelection
}

function ActionButtonLabelEditor({ buttonStyles, disabled, fontError, fontLoaded, issues, label, onChange, onInsertIcon, path }: {
  readonly buttonStyles: ActionButtonStyles
  readonly disabled: boolean
  readonly fontError: Error | null
  readonly fontLoaded: boolean
  readonly issues: readonly ConfigIssue[]
  readonly label: ActionButtonLabelValue
  readonly onChange: (label: ActionButtonLabelValue) => void
  readonly onInsertIcon: (insert: (icon: NerdFontIcon) => void) => void
  readonly path: string
}) {
  const rich = typeof label !== 'string'
  const runs = actionButtonLabelRuns(label)
  // Editor-only keys keep native inputs and remembered selections attached to
  // their run when reordered. Nothing is added to the persisted label format.
  const nextRunKey = useRef(0)
  const runInputs = useRef<LabelRunInputState[]>([])
  while (runInputs.current.length < runs.length) {
    runInputs.current.push({ key: nextRunKey.current++, input: null })
  }
  runInputs.current.length = runs.length
  const [focusRun, setFocusRun] = useState<{ readonly key: number }>()
  const [restoredSelection, setRestoredSelection] = useState<{
    readonly key: number
    readonly text: string
    readonly selection: LabelTextSelection
  }>()
  const [compactPreview, setCompactPreview] = useState(false)
  const previewStyles = resolveActionButtonStyles(buttonStyles)

  useEffect(() => {
    if (focusRun === undefined) return
    if (disabled || !runInputs.current.some((input) => input.key === focusRun.key)) {
      setFocusRun(undefined)
      setRestoredSelection(undefined)
      return
    }
    const frame = requestAnimationFrame(() => {
      runInputs.current.find((input) => input.key === focusRun.key)?.input?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [focusRun, disabled])

  function changeRun(index: number, patch: Partial<ActionButtonLabelRun>) {
    if (disabled) return
    const run = runs[index]
    const changesColor = Object.prototype.hasOwnProperty.call(patch, 'color') && patch.color !== run?.color
    if (!run || (
      (patch.text === undefined || patch.text === run.text) &&
      (patch.fontSize === undefined || patch.fontSize === run.fontSize) &&
      (patch.bold === undefined || patch.bold === run.bold) &&
      !changesColor
    )) return
    if (!rich && index === 0 && Object.keys(patch).length === 1 && patch.text !== undefined) {
      onChange(patch.text)
      return
    }
    onChange(runs.map((run, runIndex) => {
      const next = runIndex === index ? { ...run, ...patch } : { ...run }
      if (runIndex === index && Object.prototype.hasOwnProperty.call(patch, 'color') && patch.color === undefined) {
        delete next.color
      }
      return next
    }))
  }

  function addRun() {
    if (disabled || runs.length >= 64) return
    const input = { key: nextRunKey.current++, input: null }
    runInputs.current.push(input)
    onChange([...runs.map((run) => ({ ...run })), { text: '', fontSize: 15, bold: false }])
    setFocusRun({ key: input.key })
  }

  function moveRun(index: number, direction: -1 | 1) {
    if (disabled) return
    const destination = index + direction
    if (destination < 0 || destination >= runs.length) return
    const next = runs.map((run) => ({ ...run }))
    const [moved] = next.splice(index, 1)
    if (!moved) return
    next.splice(destination, 0, moved)
    const [input] = runInputs.current.splice(index, 1)
    if (input) runInputs.current.splice(destination, 0, input)
    onChange(next)
  }

  function deleteRun(index: number) {
    if (disabled || runs.length === 1) return
    runInputs.current.splice(index, 1)
    onChange(runs.filter((_run, runIndex) => runIndex !== index).map((run) => ({ ...run })))
  }

  function insertIcon(index: number) {
    const run = runs[index]
    const input = runInputs.current[index]
    if (disabled || !fontLoaded || !run || !input) return
    const selection = input.selection && { ...input.selection }
    onInsertIcon((icon) => {
      const inserted = insertLabelText(run.text, icon.glyph, selection)
      changeRun(index, { text: inserted.text })
      input.selection = inserted.selection
      setRestoredSelection({ key: input.key, ...inserted })
      setFocusRun({ key: input.key })
    })
  }

  return (
    <View style={styles.labelEditor} testID="action-button-label-editor">
      <View style={styles.section}>
        <Text style={styles.label}>Button label</Text>
        <Text style={styles.muted}>Build the label from ordered runs. Each run can mix text and icons at one preset size and weight.</Text>
      </View>

      {runs.map((run, index) => {
        const runPath = `${path}[${index}]`
        const runIssues = issues.filter((issue) => issue.path === runPath || issue.path.startsWith(`${runPath}.`))
        const textLabel = index === 0 ? 'Button label' : `Button label run ${index + 1}`
        const input = runInputs.current[index]!
        const pendingSelection = restoredSelection?.key === input.key && restoredSelection.text === run.text
          ? restoredSelection.selection : undefined
        const iconButtonLabel = fontLoaded ? 'Insert Nerd Font icon…' : fontError ? 'Nerd Font icons unavailable' : 'Loading Nerd Font icons…'
        return (
          <View key={input.key} style={styles.labelRun} testID={`action-button-label-run-${index}`}>
            <View style={styles.labelRunHeader}>
              <Text accessibilityRole="header" style={styles.label}>Run {index + 1}</Text>
              <Text style={styles.muted}>{run.fontSize} · {run.bold ? 'Bold' : 'Regular'} · {run.color ?? 'Default color'}</Text>
            </View>
            <TextInput
              accessibilityLabel={textLabel}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!disabled}
              multiline
              onChangeText={(text) => {
                if (restoredSelection?.key === input.key) setRestoredSelection(undefined)
                changeRun(index, { text })
              }}
              onSelectionChange={(event) => {
                const selection = event.nativeEvent.selection
                // Ignore late native events for the old text until insertion's
                // requested caret is acknowledged. Normal typing stays native.
                if (pendingSelection && (selection.start !== pendingSelection.start || selection.end !== pendingSelection.end)) return
                input.selection = selection
                if (pendingSelection) setRestoredSelection(undefined)
              }}
              placeholder={index === 0 ? 'Button text' : 'Text or spacing'}
              placeholderTextColor="#65717e"
              ref={(node) => { input.input = node }}
              selection={pendingSelection}
              style={[
                styles.input,
                styles.multilineInput,
                fontLoaded ? run.bold ? styles.nerdFontBold : styles.nerdFont : { fontWeight: run.bold ? '700' : '400' },
                { color: resolveActionButtonLabelColor(run.color) },
                (issues.some((issue) => issue.path === path) || runIssues.length > 0) && styles.invalidInput
              ]}
              textAlignVertical="top"
              value={run.text}
            />
            <FieldIssues issues={issues} path={runPath} />
            <FieldIssues issues={issues} path={`${runPath}.text`} />
            <EditorButton
              accessibilityLabel={`Run ${index + 1}: ${iconButtonLabel}`}
              disabled={disabled || !fontLoaded}
              label={iconButtonLabel}
              onPress={() => insertIcon(index)}
            />
            <Choices
              disabled={disabled}
              label={`Run ${index + 1} font size`}
              onChange={(fontSize) => changeRun(index, { fontSize: Number(fontSize) as ActionButtonFontSize })}
              options={ACTION_BUTTON_FONT_SIZES.map((fontSize) => ({ value: String(fontSize), label: String(fontSize) }))}
              value={String(run.fontSize)}
            />
            <FieldIssues issues={issues} path={`${runPath}.fontSize`} />
            <Choices
              disabled={disabled}
              label={`Run ${index + 1} weight`}
              onChange={(weight) => changeRun(index, { bold: weight === 'bold' })}
              options={[{ value: 'regular', label: 'Regular' }, { value: 'bold', label: 'Bold' }]}
              value={run.bold ? 'bold' : 'regular'}
            />
            <FieldIssues issues={issues} path={`${runPath}.bold`} />
            <ColorControl
              disabled={disabled}
              issues={issues}
              label={`Run ${index + 1} font color`}
              onChange={(color) => changeRun(index, { color })}
              path={`${runPath}.color`}
              value={run.color}
            />
            <View style={styles.actions}>
              <EditorButton disabled={disabled || index === 0} label={`Move label run ${index + 1} earlier`} onPress={() => moveRun(index, -1)} />
              <EditorButton disabled={disabled || index === runs.length - 1} label={`Move label run ${index + 1} later`} onPress={() => moveRun(index, 1)} />
              <EditorButton danger disabled={disabled || runs.length === 1} label={`Delete label run ${index + 1}`} onPress={() => deleteRun(index)} />
            </View>
          </View>
        )
      })}

      <FieldIssues issues={issues} path={path} />
      <View style={styles.actions}>
        <EditorButton disabled={disabled || runs.length >= 64} label="Add run" onPress={addRun} />
        {rich ? <EditorButton disabled={disabled} label="Remove label formatting" onPress={() => {
          runInputs.current = [{ key: nextRunKey.current++, input: null }]
          setRestoredSelection(undefined)
          setFocusRun(undefined)
          onChange(plainActionButtonLabel(label))
        }} /> : null}
      </View>
      {runs.length >= 64 ? <Text style={styles.muted}>A label can contain at most 64 runs.</Text> : null}

      <View style={styles.labelPreviewSection}>
        <Text style={styles.label}>Label preview</Text>
        <Choices
          disabled={disabled}
          label="Preview density"
          onChange={(density) => setCompactPreview(density === 'compact')}
          options={[{ value: 'normal', label: 'Normal' }, { value: 'compact', label: 'Compact' }]}
          value={compactPreview ? 'compact' : 'normal'}
        />
        <View
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.labelPreviewStage, compactPreview && styles.compactLabelPreviewStage]}
          testID="action-button-label-preview"
        >
          <View style={[
            styles.labelPreviewButton,
            compactPreview && styles.compactLabelPreviewButton,
            {
              width: previewStyles.width,
              backgroundColor: previewStyles.backgroundColor,
              borderColor: previewStyles.outlineColor
            }
          ]} testID="action-button-label-preview-button">
            <ActionButtonLabel
              compact={compactPreview}
              fontFacesLoaded={fontLoaded}
              label={label}
              testID="action-button-label-preview-text"
            />
          </View>
        </View>
      </View>
    </View>
  )
}

function EditorButton({ accessibilityLabel, label, onPress, disabled = false, selected = false, primary = false, danger = false, testID }: {
  readonly accessibilityLabel?: string
  readonly label: string
  readonly onPress: () => void
  readonly disabled?: boolean
  readonly selected?: boolean
  readonly primary?: boolean
  readonly danger?: boolean
  readonly testID?: string
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, primary && styles.primaryButton, selected && styles.selectedButton, danger && styles.dangerButton, disabled && styles.disabled, pressed && !disabled && styles.pressed]}
      testID={testID}
    >
      <Text style={[styles.buttonText, primary && styles.primaryText, danger && styles.error]}>{label}</Text>
    </Pressable>
  )
}

function FormField({ disabled = false, fontLoaded, hint, inputRef, issues = [], label, multiline = false, onChange, onUndo, path = '', placeholder, value }: {
  readonly disabled?: boolean
  readonly fontLoaded: boolean
  readonly hint?: string
  readonly inputRef?: RefObject<TextInput | null>
  readonly issues?: readonly ConfigIssue[]
  readonly label: string
  readonly multiline?: boolean
  readonly onChange: (value: string) => void
  readonly onUndo?: () => void
  readonly path?: string
  readonly placeholder?: string
  readonly value: string
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityHint={hint}
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!disabled}
        multiline={multiline}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor="#65717e"
        ref={inputRef}
        style={[styles.input, fontLoaded && styles.nerdFont, multiline && styles.multilineInput, issues.some((issue) => issue.path === path) && styles.invalidInput]}
        textAlignVertical={multiline ? 'top' : 'center'}
        value={value}
      />
      {hint ? <Text style={styles.muted}>{hint}</Text> : null}
      <FieldIssues issues={issues} path={path} />
      {onUndo ? (
        <View style={styles.actions}>
          <EditorButton disabled={disabled} label={`Apply ${label} edit`} onPress={() => onChange(value)} />
          <EditorButton disabled={disabled} label={`Undo ${label} edit`} onPress={onUndo} />
        </View>
      ) : null}
    </View>
  )
}

function FieldIssues({ issues, path }: { readonly issues: readonly ConfigIssue[]; readonly path: string }) {
  return <>{issues.filter((issue) => issue.path === path).map((issue, index) => <Text accessibilityLiveRegion="polite" key={index} style={styles.error}>{issue.message}</Text>)}</>
}

function Choices({ disabled = false, label, onChange, options, value }: {
  readonly disabled?: boolean
  readonly label: string
  readonly onChange: (value: string) => void
  readonly options: readonly Choice[]
  readonly value: string
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.actions}>
        {options.map((option) => (
          <Pressable
            accessibilityLabel={`${label}: ${option.label}`}
            accessibilityRole="button"
            accessibilityState={{ disabled, selected: option.value === value }}
            disabled={disabled}
            key={option.value}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [styles.button, option.value === value && styles.selectedButton, disabled && styles.disabled, pressed && !disabled && styles.pressed]}
          >
            <Text style={styles.buttonText}>{option.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  )
}

function ColorControl({ allowTransparent = false, disabled = false, issues, label, onChange, path, value }: {
  readonly allowTransparent?: boolean
  readonly disabled?: boolean
  readonly issues: readonly ConfigIssue[]
  readonly label: string
  readonly onChange: (value: string | undefined) => void
  readonly path: string
  readonly value?: string
}) {
  const normalized = value?.toLowerCase()
  const presets = allowTransparent
    ? [...ACTION_BUTTON_COLOR_OPTIONS, { value: 'transparent', label: 'Transparent' }] as const
    : ACTION_BUTTON_COLOR_OPTIONS
  const invalid = issues.some((issue) => issue.path === path)

  return (
    <View style={styles.section}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.actions}>
        <Pressable
          accessibilityLabel={`${label}: Default`}
          accessibilityRole="button"
          accessibilityState={{ disabled, selected: value === undefined }}
          disabled={disabled}
          onPress={() => onChange(undefined)}
          style={({ pressed }) => [styles.button, value === undefined && styles.selectedButton, disabled && styles.disabled, pressed && !disabled && styles.pressed]}
        >
          <Text style={styles.buttonText}>Default</Text>
        </Pressable>
        {presets.map((preset) => (
          <Pressable
            accessibilityLabel={`${label}: ${preset.label}`}
            accessibilityRole="button"
            accessibilityState={{ disabled, selected: normalized === preset.value }}
            disabled={disabled}
            key={preset.value}
            onPress={() => onChange(preset.value)}
            style={({ pressed }) => [styles.button, normalized === preset.value && styles.selectedButton, disabled && styles.disabled, pressed && !disabled && styles.pressed]}
          >
            <View style={styles.colorChoiceContent}>
              <View style={[
                styles.colorSwatch,
                preset.value === 'transparent'
                  ? styles.transparentSwatch
                  : { backgroundColor: preset.value }
              ]} />
              <Text style={styles.buttonText}>{preset.label}</Text>
            </View>
          </Pressable>
        ))}
      </View>
      <TextInput
        accessibilityLabel={`${label} custom hex`}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!disabled}
        onChangeText={(next) => onChange(next === '' ? undefined : next)}
        placeholder="#RRGGBB"
        placeholderTextColor="#65717e"
        style={[styles.input, invalid && styles.invalidInput]}
        value={value ?? ''}
      />
      <Text style={styles.muted}>Choose a palette color or enter #RRGGBB{allowTransparent ? '; Transparent removes the paint.' : '.'}</Text>
      <FieldIssues issues={issues} path={path} />
    </View>
  )
}

function Picker({ disabled = false, fontLoaded, label, onChange, options, placeholder = 'Choose…', value }: {
  readonly disabled?: boolean
  readonly fontLoaded: boolean
  readonly label: string
  readonly onChange: (value: string) => void
  readonly options: readonly Choice[]
  readonly placeholder?: string
  readonly value: string
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((option) => option.value === value)
  useEffect(() => { setOpen(false) }, [disabled, value])
  return (
    <View style={styles.section}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        accessibilityLabel={`Choose ${label.toLowerCase()}`}
        accessibilityRole="button"
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled}
        onPress={() => setOpen(!open)}
        style={[styles.picker, disabled && styles.disabled]}
      >
        <Text numberOfLines={2} style={[styles.pickerText, fontLoaded && styles.nerdFont]}>{current?.label ?? placeholder}</Text>
        <Text style={styles.muted}>{open ? '▴' : '▾'}</Text>
      </Pressable>
      {open && !disabled ? (
        <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled style={styles.pickerOptions}>
          {options.length === 0 ? <Text style={styles.muted}>No choices available.</Text> : null}
          {options.map((option) => (
            <Pressable
              accessibilityLabel={`${label}: ${option.label}`}
              accessibilityRole="button"
              accessibilityState={{ selected: option.value === value }}
              key={option.value}
              onPress={() => { onChange(option.value); setOpen(false) }}
              style={[styles.pickerOption, option.value === value && styles.selectedButton]}
            >
              <Text style={[styles.buttonText, fontLoaded && styles.nerdFontSemiBold]}>{option.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
    </View>
  )
}

function ReorderControls({ busy, count, index, item, onMove }: {
  readonly busy: boolean
  readonly count: number
  readonly index: number
  readonly item: string
  readonly onMove: (direction: -1 | 1) => void
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.label}>Position {index + 1} of {count}</Text>
      <View style={styles.actions}>
        <EditorButton disabled={busy || index === 0} label={`Move ${item} earlier`} onPress={() => onMove(-1)} />
        <EditorButton disabled={busy || index >= count - 1} label={`Move ${item} later`} onPress={() => onMove(1)} />
      </View>
    </View>
  )
}

function confirmRemoval(title: string, message: string, remove: () => void) {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: remove }
  ])
}

function restorePendingIds(
  config: ActionPadConfig,
  drafts: Readonly<Record<string, string>> = {}
): Readonly<Record<string, PendingIdEdit>> {
  const pending: Record<string, PendingIdEdit> = {}
  for (const [path, value] of Object.entries(drafts)) {
    const indices = /^menus\[(\d+)\](?:\.groups\[(\d+)\](?:\.buttons\[(\d+)\])?)?\.id$/.exec(path)
    if (!indices) continue
    const menuIndex = Number(indices[1])
    const groupIndex = Number(indices[2] ?? 0)
    const buttonIndex = Number(indices[3] ?? 0)
    const menu = config.menus[menuIndex]
    const group = menu?.groups[groupIndex]
    const button = group?.buttons[buttonIndex]
    const current = indices[3] !== undefined ? button?.id : indices[2] !== undefined ? group?.id : menu?.id
    // A save may have persisted the accepted ID just before clearing its buffer.
    if (current === undefined || current === value) continue
    const edit: ActionPadEdit = indices[3] !== undefined
      ? { type: 'update-button', location: { menuIndex, groupIndex, buttonIndex }, patch: { id: value } }
      : indices[2] !== undefined
        ? { type: 'update-group', location: { menuIndex, groupIndex }, id: value }
        : { type: 'update-menu', menuIndex, patch: { id: value } }
    let message = 'Apply or undo this recovered ID edit.'
    try {
      editActionPad(config, edit)
    } catch (error) {
      if (error instanceof Error) message = error.message
    }
    pending[path] = { value, message }
  }
  return pending
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b0e12' },
  header: { padding: 16, gap: 10, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#27303a' },
  titleBlock: { flex: 1, minWidth: 200, gap: 4 },
  title: { fontSize: 22, fontWeight: '700', color: '#eef4fa' },
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 40, gap: 16 },
  card: { gap: 12, padding: 16, borderWidth: 1, borderColor: '#27303a', borderRadius: 12, backgroundColor: '#111419' },
  section: { gap: 6 },
  sectionTitle: { color: '#eef4fa', fontSize: 18, fontWeight: '600' },
  label: { color: '#c0caf5', fontSize: 14, fontWeight: '600' },
  muted: { color: '#9eabb8', fontSize: 13, lineHeight: 19 },
  notice: { color: '#e0af68', fontSize: 13, lineHeight: 19 },
  error: { color: '#ff7b72', fontSize: 13, lineHeight: 19 },
  errorCard: { borderColor: '#744248' },
  issue: { minHeight: 48, paddingVertical: 6, gap: 3 },
  workspace: { gap: 16, alignItems: 'stretch' },
  wideWorkspace: { flexDirection: 'row', alignItems: 'flex-start' },
  navigation: { gap: 12 },
  wideNavigation: { width: 240, flexShrink: 0 },
  selectors: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  verticalSelectors: { flexDirection: 'column', flexWrap: 'nowrap' },
  selector: { minWidth: 155, flex: 1, gap: 8 },
  details: { flex: 1, minWidth: 0, gap: 16 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'stretch', gap: 8 },
  menuList: { gap: 12 },
  menuRow: { gap: 10, padding: 12, borderWidth: 1, borderColor: '#303946', borderRadius: 10, backgroundColor: '#151b22' },
  menuRowHeader: { gap: 5 },
  menuRowTitle: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  menuName: { flexShrink: 1, color: '#eef4fa', fontSize: 15, fontWeight: '600' },
  referenceList: { gap: 8, paddingTop: 4 },
  cleanupSection: { gap: 8, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#27303a' },
  button: { minHeight: 48, minWidth: 48, paddingHorizontal: 14, paddingVertical: 10, justifyContent: 'center', alignItems: 'center', borderRadius: 8, borderWidth: 1, borderColor: '#303946', backgroundColor: '#24283b' },
  buttonText: { color: '#c0caf5', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  primaryButton: { backgroundColor: '#7ee787', borderColor: '#7ee787' },
  primaryText: { color: '#0b0e12' },
  selectedButton: { borderColor: '#73daca', backgroundColor: '#20343d' },
  dangerButton: { borderColor: '#744248', backgroundColor: '#301f29' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.72 },
  input: { minHeight: 48, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#303946', backgroundColor: '#151b22', color: '#e7edf3', fontFamily: 'monospace', fontSize: 15 },
  nerdFont: { fontFamily: CODEY_NERD_FONT_FAMILIES.regular, fontWeight: 'normal' },
  nerdFontSemiBold: { fontFamily: CODEY_NERD_FONT_FAMILIES.semiBold, fontWeight: 'normal' },
  nerdFontBold: { fontFamily: CODEY_NERD_FONT_FAMILIES.bold, fontWeight: 'normal' },
  multilineInput: { minHeight: 84 },
  invalidInput: { borderColor: '#ff7b72' },
  picker: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#303946', backgroundColor: '#151b22' },
  pickerText: { flex: 1, color: '#c0caf5', fontSize: 14 },
  pickerOptions: { maxHeight: 240, borderWidth: 1, borderColor: '#303946', borderRadius: 8, backgroundColor: '#151b22' },
  pickerOption: { minHeight: 48, justifyContent: 'center', padding: 12, borderBottomWidth: 1, borderBottomColor: '#27303a' },
  interaction: { paddingTop: 14, borderTopWidth: 1, borderTopColor: '#27303a', gap: 10 },
  guidedInteraction: { marginHorizontal: -8, paddingHorizontal: 8, paddingBottom: 8, borderWidth: 1, borderColor: '#e0af68', borderRadius: 8, backgroundColor: '#2b271f' },
  labelEditor: { gap: 12 },
  labelRun: { gap: 10, padding: 12, borderWidth: 1, borderColor: '#303946', borderRadius: 10, backgroundColor: '#151b22' },
  labelRunHeader: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  labelPreviewSection: { gap: 10, paddingTop: 4 },
  labelPreviewStage: { width: 336, maxWidth: '100%', padding: 24, alignSelf: 'center', borderLeftWidth: 2, borderColor: '#10121a', backgroundColor: '#16161e', borderRadius: 12 },
  compactLabelPreviewStage: { padding: 8 },
  labelPreviewButton: { width: '48%', height: 52, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'transparent', borderRadius: 12, backgroundColor: '#24283b' },
  compactLabelPreviewButton: { height: 48, paddingHorizontal: 4, borderRadius: 8 },
  colorChoiceContent: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  colorSwatch: { width: 18, height: 18, borderRadius: 4, borderWidth: 1, borderColor: '#65717e' },
  transparentSwatch: { backgroundColor: 'transparent', borderColor: '#c0caf5' },
  modalBackdrop: { flex: 1, justifyContent: 'center', padding: 20, backgroundColor: 'rgba(0, 0, 0, 0.72)' },
  confirmationCard: { width: '100%', maxWidth: 620, maxHeight: '86%', alignSelf: 'center', gap: 12, padding: 18, borderWidth: 1, borderColor: '#744248', borderRadius: 12, backgroundColor: '#111419' },
  confirmationList: { maxHeight: 280, borderWidth: 1, borderColor: '#303946', borderRadius: 8, backgroundColor: '#151b22' },
  confirmationRow: { gap: 3, padding: 12, borderBottomWidth: 1, borderBottomColor: '#27303a' }
})
