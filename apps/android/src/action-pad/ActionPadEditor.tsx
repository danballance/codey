import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  Alert,
  KeyboardAvoidingView,
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
import { ActionPad, type ActionPadPlacement } from './ActionPad'
import { NerdFontIconPicker } from './NerdFontIconPicker'
import {
  resolveActionPadConfig,
  validateActionPadConfig,
  type ActionPadConfig,
  type ConfigIssue
} from './document'
import {
  editActionPad,
  groupDeletionReason,
  menuDeletionReason,
  type ActionPadEdit,
  type ButtonLocation,
  type EditableButton,
  type EditableInteraction
} from './editing'
import { type ActionPadButtonTarget } from './types'

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

type SelectionKind = 'menu' | 'group' | 'button'
interface Choice {
  readonly value: string
  readonly label: string
}

interface PendingIdEdit {
  readonly value: string
  readonly message: string
}

interface TextSelection {
  readonly start: number
  readonly end: number
}

// The preview cannot access a session or the native Neovim input bridge.
const ignorePreviewInput = () => undefined

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
  const [selectionKind, setSelectionKind] = useState<SelectionKind>('button')
  const [targetNotice, setTargetNotice] = useState(() => initialButton && !initialButtonLocation
    ? 'The selected button could not be found uniquely in this draft. It may have been moved, renamed, or removed. Your draft has been kept; choose a button below.'
    : '')
  const scrollView = useRef<ScrollView>(null)
  const initialButtonScroll = useRef<{
    pending: boolean
    contentReady: boolean
    positions: Partial<Record<'workspace' | 'details' | 'button', number>>
  }>({ pending: !!initialButtonLocation, contentReady: false, positions: {} })
  const [hostPath, setHostPath] = useState(sourcePath)
  const [exportPath, setExportPath] = useState('')
  const [showExport, setShowExport] = useState(false)
  const [moveDestination, setMoveDestination] = useState('')
  const [editError, setEditError] = useState<ConfigIssue | null>(null)
  const [pendingIds, setPendingIds] = useState<Readonly<Record<string, PendingIdEdit>>>(() => restorePendingIds(config, initialIdDrafts))
  const [operationError, setOperationError] = useState('')
  const [operationPending, setOperationPending] = useState(false)
  const [iconPickerOpen, setIconPickerOpen] = useState(false)
  const [buttonLabelSelection, setButtonLabelSelection] = useState<TextSelection>()
  const [labelFocusRequest, setLabelFocusRequest] = useState(0)
  const buttonLabelInput = useRef<TextInput>(null)
  const operationInFlight = useRef(false)
  const observedConfig = useRef(config)
  const localChangeSignature = useRef<string | null>(null)
  const draftCallbacks = useRef({ onPendingEditsChange, onIdDraftsChange })
  draftCallbacks.current = { onPendingEditsChange, onIdDraftsChange }
  const [previewOrigin, setPreviewOrigin] = useState('selected')
  const [previewPlacement, setPreviewPlacement] = useState<ActionPadPlacement>('right')
  const busy = hostBusy || operationPending
  const hasPendingIds = Object.keys(pendingIds).length > 0
  const structuralBusy = busy || hasPendingIds
  const latestEditor = useRef({ config, busy, hasPendingIds })
  latestEditor.current = { config, busy, hasPendingIds }
  const idDrafts = useMemo(() => Object.fromEntries(Object.entries(pendingIds).map(([path, pending]) => [path, pending.value])), [pendingIds])
  const idDraftsSignature = JSON.stringify(idDrafts)

  useEffect(() => { setHostPath(sourcePath) }, [sourcePath])

  useEffect(() => {
    if (observedConfig.current === config) return
    observedConfig.current = config
    const local = localChangeSignature.current === JSON.stringify(config)
    localChangeSignature.current = null
    if (local) return
    // A successful Load/Reload or Save may replace the controlled document.
    // Old field errors and index-based selections do not belong to that file.
    initialButtonScroll.current.pending = false
    setTargetNotice('')
    setPendingIds({})
    setEditError(null)
    setOperationError('')
    setMenuSelection(Math.max(0, config.menus.findIndex((menu) => menu.id === config.rootMenuId)))
    setGroupSelection(0)
    setButtonSelection(0)
    setSelectionKind('button')
    setMoveDestination('')
    setIconPickerOpen(false)
    setButtonLabelSelection(undefined)
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
  const buttonIdentity = button ? `${menuIndex}:${menu?.id}:${groupIndex}:${group?.id}:${buttonIndex}:${button.id}` : ''
  const groupLocation = { menuIndex, groupIndex }
  const buttonLocation = { ...groupLocation, buttonIndex }
  const issues = useMemo(() => validateActionPadConfig(config), [config])
  const displayedIssues = [
    ...issues,
    ...Object.entries(pendingIds).map(([path, pending]) => ({ path, message: pending.message })),
    ...(editError ? [editError] : [])
  ]
  const valid = displayedIssues.length === 0
  const canWrite = connected && !busy && valid
  const preview = useMemo(() => {
    if (issues.length > 0) return null
    return resolveActionPadConfig({
      ...config,
      rootMenuId: previewOrigin === 'selected' ? menu?.id ?? config.rootMenuId : config.rootMenuId
    })
  }, [config, issues, menu?.id, previewOrigin])
  const [lastValidPreview, setLastValidPreview] = useState(preview)
  useEffect(() => { if (preview) setLastValidPreview(preview) }, [preview])
  const previewMenu = preview ?? lastValidPreview
  const deletionReason = menu ? menuDeletionReason(config, menuIndex) : undefined
  const groupDeleteReason = group ? groupDeletionReason(config, groupLocation) : undefined
  const destinations = config.menus.flatMap((candidate, candidateMenuIndex) =>
    candidate.groups.flatMap((candidateGroup, candidateGroupIndex) =>
      candidateMenuIndex === menuIndex && candidateGroupIndex === groupIndex ? [] : [{
        value: `${candidateMenuIndex}:${candidateGroupIndex}`,
        label: `${candidate.label || candidate.id} / ${candidateGroup.id || 'Unnamed group'}`
      }]
    )
  )
  const destinationExists = destinations.some((candidate) => candidate.value === moveDestination)
  const observedButtonIdentity = useRef(buttonIdentity)

  useEffect(() => {
    if (observedButtonIdentity.current === buttonIdentity) return
    observedButtonIdentity.current = buttonIdentity
    setIconPickerOpen(false)
    setButtonLabelSelection(undefined)
  }, [buttonIdentity])

  useEffect(() => {
    if (!busy && fontLoaded) return
    setIconPickerOpen(false)
  }, [busy, fontLoaded])

  useEffect(() => {
    if (labelFocusRequest === 0 || iconPickerOpen) return
    const frame = requestAnimationFrame(() => buttonLabelInput.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [iconPickerOpen, labelFocusRequest])

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
  }

  function chooseGroup(index: number) {
    setGroupSelection(index)
    setButtonSelection(0)
    setSelectionKind('button')
    setMoveDestination('')
    setEditError(null)
  }

  function updateButton(patch: Partial<EditableButton>, path: string) {
    apply({ type: 'update-button', location: buttonLocation, patch }, path)
  }

  function insertNerdFontIcon(icon: NerdFontIcon) {
    if (!button || busy || !fontLoaded) {
      setIconPickerOpen(false)
      return
    }
    const fallback = button.label.length
    const start = Math.max(0, Math.min(buttonLabelSelection?.start ?? fallback, button.label.length))
    const end = Math.max(start, Math.min(buttonLabelSelection?.end ?? start, button.label.length))
    const label = `${button.label.slice(0, start)}${icon.glyph}${button.label.slice(end)}`
    const caret = start + icon.glyph.length
    updateButton({ label }, `${buttonPath}.label`)
    setButtonLabelSelection({ start: caret, end: caret })
    setIconPickerOpen(false)
    setLabelFocusRequest((request) => request + 1)
  }

  function focusIssue(issue: ConfigIssue) {
    const indices = /^menus\[(\d+)\](?:\.groups\[(\d+)\](?:\.buttons\[(\d+)\])?)?/.exec(issue.path)
    if (!indices) { setSelectionKind('menu'); return }
    setMenuSelection(Number(indices[1]))
    setGroupSelection(Number(indices[2] ?? 0))
    setButtonSelection(Number(indices[3] ?? 0))
    setSelectionKind(indices[3] !== undefined ? 'button' : indices[2] !== undefined ? 'group' : 'menu')
  }

  function scrollToInitialButton() {
    const scroll = initialButtonScroll.current
    const { workspace, details, button: buttonY } = scroll.positions
    if (!scroll.pending || !scroll.contentReady || !scrollView.current ||
      workspace === undefined || details === undefined || buttonY === undefined) return
    scroll.pending = false
    // These layouts are relative to successive ancestors. Summing them keeps
    // the card aligned in both the stacked and side-by-side editor layouts.
    scrollView.current.scrollTo({ y: workspace + details + buttonY, animated: false })
  }

  function recordInitialButtonLayout(part: 'workspace' | 'details' | 'button', y: number) {
    if (!initialButtonScroll.current.pending) return
    initialButtonScroll.current.positions[part] = y
    scrollToInitialButton()
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
          initialButtonScroll.current.contentReady = height > 0
          scrollToInitialButton()
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

        <View onLayout={(event) => recordInitialButtonLayout('workspace', event.nativeEvent.layout.y)} style={[styles.workspace, wide && styles.wideWorkspace]} testID="action-pad-editor-workspace">
          <View style={[styles.navigation, wide && styles.wideNavigation]}>
            <View style={[styles.selectors, wide && styles.verticalSelectors]}>
              <View style={styles.selector}>
                <Picker
                  disabled={busy || config.menus.length === 0}
                  fontLoaded={fontLoaded}
                  label="Menu"
                  onChange={(value) => chooseMenu(Number(value))}
                  options={config.menus.map((candidate, index) => ({ value: String(index), label: `${candidate.label || 'Unnamed menu'}${candidate.id === config.rootMenuId ? ' · Root' : ''}` }))}
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
                  onChange={(value) => { setButtonSelection(Number(value)); setSelectionKind('button'); setEditError(null); setMoveDestination('') }}
                  options={group?.buttons.map((candidate, index) => ({ value: String(index), label: candidate.label || 'Unnamed button' })) ?? []}
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
              <EditorButton disabled={busy || !menu} label="Menu settings" onPress={() => setSelectionKind('menu')} selected={kind === 'menu'} />
              <EditorButton disabled={busy || !group} label="Group settings" onPress={() => setSelectionKind('group')} selected={kind === 'group'} />
              <EditorButton disabled={busy || !button} label="Button settings" onPress={() => setSelectionKind('button')} selected={kind === 'button'} />
            </View>
          </View>

          <View onLayout={(event) => recordInitialButtonLayout('details', event.nativeEvent.layout.y)} style={styles.details} testID="action-pad-editor-details">
            {kind === 'menu' && menu ? (
              <View style={styles.card} testID="action-pad-menu-form">
                <Text accessibilityRole="header" style={styles.sectionTitle}>Menu settings</Text>
                <FormField disabled={busy} fontLoaded={fontLoaded} issues={displayedIssues} label="Menu label" onChange={(label) => apply({ type: 'update-menu', menuIndex, patch: { label } }, `${menuPath}.label`)} path={`${menuPath}.label`} value={menu.label} />
                <FormField disabled={busy} fontLoaded={fontLoaded} hint="Stable ID used by menu links. Renaming updates those links automatically." issues={displayedIssues} label="Menu ID" onChange={(id) => applyId({ type: 'update-menu', menuIndex, patch: { id } }, `${menuPath}.id`, id)} onUndo={pendingIds[`${menuPath}.id`] ? () => undoPendingId(`${menuPath}.id`) : undefined} path={`${menuPath}.id`} value={pendingIds[`${menuPath}.id`]?.value ?? menu.id} />
                <EditorButton disabled={busy || menu.id === config.rootMenuId} label={menu.id === config.rootMenuId ? 'This is the root menu' : 'Use as root menu'} onPress={() => apply({ type: 'set-root-menu', menuIndex }, 'rootMenuId')} selected={menu.id === config.rootMenuId} />
                <FieldIssues issues={displayedIssues} path="rootMenuId" />
                <ReorderControls busy={structuralBusy} count={config.menus.length} index={menuIndex} item="menu" onMove={(direction) => apply({ type: 'reorder-menu', menuIndex, direction }, menuPath, () => setMenuSelection(menuIndex + direction))} />
                <Text style={styles.muted}>{menu.groups.length} {menu.groups.length === 1 ? 'group' : 'groups'} in this menu.</Text>
                <EditorButton danger disabled={structuralBusy || Boolean(deletionReason)} label="Delete menu" onPress={() => confirmRemoval('Delete menu?', `Delete “${menu.label}” and all its groups and buttons?`, () => apply({ type: 'delete-menu', menuIndex }, menuPath, (next) => chooseMenu(Math.min(menuIndex, next.menus.length - 1))))} />
                {deletionReason ? <Text style={[styles.muted, fontLoaded && styles.nerdFont]}>{deletionReason}</Text> : null}
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
              <View onLayout={(event) => recordInitialButtonLayout('button', event.nativeEvent.layout.y)} style={styles.card} testID="action-pad-button-form">
                <Text accessibilityRole="header" style={styles.sectionTitle}>Button settings</Text>
                <FormField
                  disabled={busy}
                  fontLoaded={fontLoaded}
                  hint="Choose an icon to insert it at the cursor. For icon-only buttons, set an Accessibility label below."
                  inputRef={buttonLabelInput}
                  issues={displayedIssues}
                  label="Button label"
                  multiline
                  onChange={(label) => updateButton({ label }, `${buttonPath}.label`)}
                  onSelectionChange={setButtonLabelSelection}
                  path={`${buttonPath}.label`}
                  selection={buttonLabelSelection}
                  value={button.label}
                />
                <EditorButton
                  disabled={busy || !fontLoaded}
                  label={fontLoaded ? 'Choose Nerd Font icon…' : fontError ? 'Nerd Font icons unavailable' : 'Loading Nerd Font icons…'}
                  onPress={() => setIconPickerOpen(true)}
                />
                {fontError ? <Text accessibilityLiveRegion="polite" style={styles.notice}>The bundled Nerd Font could not be loaded, so icon previews are unavailable.</Text> : null}
                <FormField disabled={busy} fontLoaded={fontLoaded} issues={displayedIssues} label="Button ID" onChange={(id) => applyId({ type: 'update-button', location: buttonLocation, patch: { id } }, `${buttonPath}.id`, id)} onUndo={pendingIds[`${buttonPath}.id`] ? () => undoPendingId(`${buttonPath}.id`) : undefined} path={`${buttonPath}.id`} value={pendingIds[`${buttonPath}.id`]?.value ?? button.id} />
                <Choices disabled={busy} label="Button size" onChange={(size) => updateButton({ styles: size === 'default' ? undefined : { size: size as '1/2' | '1/4' } }, `${buttonPath}.styles.size`)} options={[{ value: 'default', label: 'Default' }, { value: '1/2', label: 'Half' }, { value: '1/4', label: 'Quarter' }]} value={button.styles?.size ?? 'default'} />
                <Text style={styles.muted}>Sizes affect the side rail. The bottom pad uses equal widths.</Text>
                <FieldIssues issues={displayedIssues} path={`${buttonPath}.styles.size`} />
                <FormField disabled={busy} fontLoaded={fontLoaded} hint="Leave blank to use the button label." issues={displayedIssues} label="Accessibility label" onChange={(accessibilityLabel) => updateButton({ accessibilityLabel: accessibilityLabel || undefined }, `${buttonPath}.accessibilityLabel`)} path={`${buttonPath}.accessibilityLabel`} value={button.accessibilityLabel ?? ''} />
                <FormField disabled={busy} fontLoaded={fontLoaded} issues={displayedIssues} label="Accessibility hint" multiline onChange={(accessibilityHint) => updateButton({ accessibilityHint: accessibilityHint || undefined }, `${buttonPath}.accessibilityHint`)} path={`${buttonPath}.accessibilityHint`} value={button.accessibilityHint ?? ''} />
                <InteractionForm action={button.tap} config={config} disabled={busy} fontLoaded={fontLoaded} gesture="Tap" issues={displayedIssues} menuId={menu?.id ?? ''} onChange={(tap) => updateButton({ tap }, `${buttonPath}.tap`)} path={`${buttonPath}.tap`} />
                <InteractionForm action={button.longPress} config={config} disabled={busy} fontLoaded={fontLoaded} gesture="Hold" issues={displayedIssues} menuId={menu?.id ?? ''} onChange={(longPress) => updateButton({ longPress }, `${buttonPath}.longPress`)} path={`${buttonPath}.longPress`} />
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
                <EditorButton danger disabled={structuralBusy} label="Delete button" onPress={() => confirmRemoval('Delete button?', `Delete “${button.label}”?`, () => apply({ type: 'delete-button', location: buttonLocation }, buttonPath, () => setButtonSelection(Math.max(0, buttonIndex - 1))))} />
              </View>
            ) : null}

            {!menu ? <Text style={styles.muted}>Add a menu to start building your Action Pad.</Text> : null}

            <View style={styles.card} testID="action-pad-editor-preview">
              <Text accessibilityRole="header" style={styles.sectionTitle}>Safe preview</Text>
              <Text style={styles.muted}>Nothing is sent to Neovim. Tap and hold menu links to try navigation; input and keyboard actions do nothing.</Text>
              <Choices label="Preview starts at" onChange={setPreviewOrigin} options={[{ value: 'selected', label: 'Selected menu' }, { value: 'root', label: 'Root menu' }]} value={previewOrigin} />
              <Choices label="Preview layout" onChange={(value) => setPreviewPlacement(value as ActionPadPlacement)} options={[{ value: 'right', label: 'Side rail' }, { value: 'below', label: 'Bottom pad' }]} value={previewPlacement} />
              {previewOrigin === 'selected' ? <Text style={styles.muted}>In this preview, “return to root” returns to the selected start menu. Choose Root menu to check the full pad.</Text> : null}
              {!valid ? <Text style={styles.notice}>Showing the last valid preview while you complete the fields.</Text> : null}
              {previewMenu ? (
                <View style={[styles.previewFrame, previewPlacement === 'right' ? styles.previewRail : styles.previewBottom]}>
                  <ActionPad
                    dimensions={previewMenu.label}
                    enabled
                    mode="PREVIEW"
                    onInput={ignorePreviewInput}
                    onKeyboardPress={ignorePreviewInput}
                    placement={previewPlacement}
                    rootMenu={previewMenu}
                  />
                </View>
              ) : <Text style={styles.muted}>Complete a valid configuration to see a preview.</Text>}
            </View>
          </View>
        </View>
      </ScrollView>
      <NerdFontIconPicker
        onDismiss={() => setIconPickerOpen(false)}
        onSelect={insertNerdFontIcon}
        visible={iconPickerOpen && fontLoaded && !busy}
      />
    </KeyboardAvoidingView>
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

function InteractionForm({ action, config, disabled, fontLoaded, gesture, issues, menuId, onChange, path }: {
  readonly action: EditableInteraction | undefined
  readonly config: ActionPadConfig
  readonly disabled: boolean
  readonly fontLoaded: boolean
  readonly gesture: 'Tap' | 'Hold'
  readonly issues: readonly ConfigIssue[]
  readonly menuId: string
  readonly onChange: (action: EditableInteraction | undefined) => void
  readonly path: string
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
    <View style={styles.interaction}>
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

function EditorButton({ label, onPress, disabled = false, selected = false, primary = false, danger = false, testID }: {
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
      accessibilityLabel={label}
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

function FormField({ disabled = false, fontLoaded, hint, inputRef, issues = [], label, multiline = false, onChange, onSelectionChange, onUndo, path = '', placeholder, selection, value }: {
  readonly disabled?: boolean
  readonly fontLoaded: boolean
  readonly hint?: string
  readonly inputRef?: RefObject<TextInput | null>
  readonly issues?: readonly ConfigIssue[]
  readonly label: string
  readonly multiline?: boolean
  readonly onChange: (value: string) => void
  readonly onSelectionChange?: (selection: TextSelection) => void
  readonly onUndo?: () => void
  readonly path?: string
  readonly placeholder?: string
  readonly selection?: TextSelection
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
        onSelectionChange={onSelectionChange ? (event) => onSelectionChange(event.nativeEvent.selection) : undefined}
        placeholder={placeholder}
        placeholderTextColor="#65717e"
        ref={inputRef}
        selection={selection}
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
  multilineInput: { minHeight: 84 },
  invalidInput: { borderColor: '#ff7b72' },
  picker: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#303946', backgroundColor: '#151b22' },
  pickerText: { flex: 1, color: '#c0caf5', fontSize: 14 },
  pickerOptions: { maxHeight: 240, borderWidth: 1, borderColor: '#303946', borderRadius: 8, backgroundColor: '#151b22' },
  pickerOption: { minHeight: 48, justifyContent: 'center', padding: 12, borderBottomWidth: 1, borderBottomColor: '#27303a' },
  interaction: { paddingTop: 14, borderTopWidth: 1, borderTopColor: '#27303a', gap: 10 },
  previewFrame: { minWidth: 0, overflow: 'hidden', borderRadius: 12 },
  previewRail: { height: 360, width: '100%', maxWidth: 340, alignSelf: 'center' },
  previewBottom: { width: '100%' }
})
