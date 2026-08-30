import { isAlias, isNode, parseDocument, stringify, visit } from 'yaml'

import {
  isActionButtonAppearance,
  isActionButtonLabelColor,
  isActionButtonSize,
  isActionButtonStyleColor
} from './style'
import { ACTION_BUTTON_FONT_SIZES } from './types'
import type {
  ActionAfter,
  ActionButton,
  ActionButtonLabel,
  ActionButtonStyles,
  ActionInteraction,
  ActionMenu
} from './types'

export const ACTION_PAD_CONFIG_MAX_BYTES = 1_048_576

const MAX_MENUS = 128
const MAX_GROUPS_PER_MENU = 128
const MAX_BUTTONS_PER_GROUP = 1024
const MAX_LABEL_RUNS = 64
const MAX_ITEMS = 10_000
const MAX_ISSUES = 100
const MAX_YAML_DEPTH = 24

export type ActionMenuDefinitionInteraction =
  | { readonly type: 'input'; readonly nvimInput: string; readonly after: ActionAfter }
  | { readonly type: 'menu'; readonly menuId: string; readonly after: ActionAfter }
  | { readonly type: 'group'; readonly menuId: string; readonly groupId: string; readonly after: ActionAfter }
  | { readonly type: 'back'; readonly after: ActionAfter }
  | { readonly type: 'keyboard'; readonly after: ActionAfter }

export interface ActionMenuDefinitionButton {
  readonly id: string
  readonly label: ActionButtonLabel
  readonly accessibilityLabel?: string
  readonly accessibilityHint?: string
  readonly styles: ActionButtonStyles
  readonly tap?: ActionMenuDefinitionInteraction
  readonly longPress?: ActionMenuDefinitionInteraction
}

export interface ActionMenuDefinitionGroup {
  readonly id: string
  readonly buttons: readonly ActionMenuDefinitionButton[]
}

export interface ActionMenuDefinition {
  readonly id: string
  readonly label: string
  readonly groups: readonly ActionMenuDefinitionGroup[]
}

export interface ActionPadConfig {
  readonly version: 1
  readonly rootMenuId: string
  readonly menus: readonly ActionMenuDefinition[]
}

export interface ConfigIssue {
  readonly path: string
  readonly message: string
}

export class ActionPadConfigError extends Error {
  readonly issues: readonly ConfigIssue[]

  constructor(issues: readonly ConfigIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'))
    this.name = 'ActionPadConfigError'
    this.issues = issues
  }
}

/** Also accepts incomplete editor drafts, but never malformed stored objects. */
export function isActionPadConfigShape(value: unknown): value is ActionPadConfig {
  return inspectConfig(value, false).length === 0
}

export function validateActionPadConfig(value: unknown): readonly ConfigIssue[] {
  return inspectConfig(value, true)
}

function inspectConfig(value: unknown, semantic: boolean): readonly ConfigIssue[] {
  const issues: ConfigIssue[] = []
  let itemCount = 0
  let stringBytes = 0

  function issue(path: string, message: string) {
    if (issues.length < MAX_ISSUES) issues.push({ path, message })
  }

  function object(
    candidate: unknown,
    path: string,
    keys: readonly string[]
  ): candidate is Record<string, unknown> {
    if (
      candidate === null || typeof candidate !== 'object' || Array.isArray(candidate) ||
      (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null)
    ) {
      issue(path, 'Expected an object.')
      return false
    }
    for (const key of Object.keys(candidate)) {
      if (!keys.includes(key)) issue(path === '$' ? key : `${path}.${key}`, 'Unknown field.')
    }
    return true
  }

  function string(candidate: unknown, path: string, required: 'text' | 'input' | false = false): candidate is string {
    if (typeof candidate !== 'string') {
      issue(path, 'Expected a string; quote numeric labels and inputs in YAML.')
      return false
    }
    stringBytes += utf8Bytes(candidate)
    if (semantic && required && (required === 'text' ? candidate.trim().length : candidate.length) === 0) {
      issue(path, 'Must not be empty.')
    }
    return true
  }

  function array(candidate: unknown, path: string, maximum: number): candidate is readonly unknown[] {
    if (!Array.isArray(candidate)) {
      issue(path, 'Expected an array.')
      return false
    }
    itemCount += candidate.length
    if (candidate.length > maximum) {
      issue(path, `Must contain at most ${maximum} items.`)
      return false
    }
    if (itemCount > MAX_ITEMS) {
      issue(path, `Configuration must contain at most ${MAX_ITEMS} menus, groups, buttons and label runs in total.`)
      return false
    }
    return true
  }

  function color(candidate: unknown, path: string, transparent: boolean): candidate is string {
    if (!string(candidate, path)) return false
    if (semantic && !(transparent ? isActionButtonStyleColor(candidate) : isActionButtonLabelColor(candidate))) {
      issue(path, transparent
        ? 'Expected "transparent" or a color in "#RRGGBB" format.'
        : 'Expected a color in "#RRGGBB" format.')
      return false
    }
    return true
  }

  function identifier(candidate: unknown, path: string, identifiers: Set<string>) {
    if (!string(candidate, path, 'text')) return
    if (semantic && identifiers.has(candidate)) issue(path, `Duplicate identifier: ${candidate}`)
    identifiers.add(candidate)
  }

  function buttonLabel(candidate: unknown, path: string) {
    if (typeof candidate === 'string') {
      string(candidate, path, 'text')
      return
    }
    if (!array(candidate, path, MAX_LABEL_RUNS)) return
    if (candidate.length === 0) {
      issue(path, 'Must contain at least 1 run.')
      return
    }

    let combinedText = ''
    let allTextValid = true
    let hasEmptyRun = false
    candidate.forEach((run, runIndex) => {
      const runPath = `${path}[${runIndex}]`
      if (!object(run, runPath, ['text', 'fontSize', 'bold', 'color'])) {
        allTextValid = false
        return
      }
      if (string(run.text, `${runPath}.text`)) {
        combinedText += run.text
        if (semantic && run.text.length === 0) {
          hasEmptyRun = true
          issue(`${runPath}.text`, 'Must not be empty.')
        }
      } else {
        allTextValid = false
      }
      if (
        typeof run.fontSize !== 'number' ||
        !ACTION_BUTTON_FONT_SIZES.some((fontSize) => fontSize === run.fontSize)
      ) {
        issue(`${runPath}.fontSize`, `Expected one of ${ACTION_BUTTON_FONT_SIZES.join(', ')}.`)
      }
      if (typeof run.bold !== 'boolean') issue(`${runPath}.bold`, 'Expected a Boolean.')
      if (run.color !== undefined) color(run.color, `${runPath}.color`, false)
    })
    if (semantic && allTextValid && !hasEmptyRun && combinedText.trim().length === 0) {
      issue(path, 'Must contain visible text.')
    }
  }

  function interaction(candidate: unknown, path: string) {
    if (!object(candidate, path, ['type', 'after', 'nvimInput', 'menuId', 'groupId'])) return
    if (candidate.after !== 'root' && candidate.after !== 'stay') {
      issue(`${path}.after`, 'Expected "root" or "stay".')
    }
    switch (candidate.type) {
      case 'input':
        string(candidate.nvimInput, `${path}.nvimInput`, 'input')
        if ('menuId' in candidate) issue(`${path}.menuId`, 'Only menu and group interactions have a menuId.')
        if ('groupId' in candidate) issue(`${path}.groupId`, 'Only group interactions have a groupId.')
        break
      case 'menu':
        string(candidate.menuId, `${path}.menuId`, 'text')
        if ('nvimInput' in candidate) issue(`${path}.nvimInput`, 'Only input interactions have nvimInput.')
        if ('groupId' in candidate) issue(`${path}.groupId`, 'Only group interactions have a groupId.')
        break
      case 'group':
        string(candidate.menuId, `${path}.menuId`, 'text')
        string(candidate.groupId, `${path}.groupId`, 'text')
        if ('nvimInput' in candidate) issue(`${path}.nvimInput`, 'Only input interactions have nvimInput.')
        break
      case 'back':
      case 'keyboard':
        if ('menuId' in candidate) issue(`${path}.menuId`, 'Only menu and group interactions have a menuId.')
        if ('groupId' in candidate) issue(`${path}.groupId`, 'Only group interactions have a groupId.')
        if ('nvimInput' in candidate) issue(`${path}.nvimInput`, 'Only input interactions have nvimInput.')
        break
      default:
        issue(`${path}.type`, 'Expected "input", "menu", "group", "back" or "keyboard".')
    }
  }

  if (!object(value, '$', ['version', 'rootMenuId', 'menus'])) return issues
  if (value.version !== 1) issue('version', 'Only action pad configuration version 1 is supported.')
  string(value.rootMenuId, 'rootMenuId', 'text')
  if (!array(value.menus, 'menus', MAX_MENUS)) return issues

  const menuIds = new Set<string>()
  value.menus.forEach((menu, menuIndex) => {
    const menuPath = `menus[${menuIndex}]`
    if (!object(menu, menuPath, ['id', 'label', 'groups'])) return
    identifier(menu.id, `${menuPath}.id`, menuIds)
    string(menu.label, `${menuPath}.label`, 'text')
    if (!array(menu.groups, `${menuPath}.groups`, MAX_GROUPS_PER_MENU)) return

    const groupIds = new Set<string>()
    menu.groups.forEach((group, groupIndex) => {
      const groupPath = `${menuPath}.groups[${groupIndex}]`
      if (!object(group, groupPath, ['id', 'buttons'])) return
      identifier(group.id, `${groupPath}.id`, groupIds)
      if (!array(group.buttons, `${groupPath}.buttons`, MAX_BUTTONS_PER_GROUP)) return

      const buttonIds = new Set<string>()
      group.buttons.forEach((button, buttonIndex) => {
        const buttonPath = `${groupPath}.buttons[${buttonIndex}]`
        if (!object(button, buttonPath, [
          'id', 'label', 'accessibilityLabel', 'accessibilityHint', 'styles', 'tap', 'longPress'
        ])) return
        identifier(button.id, `${buttonPath}.id`, buttonIds)
        buttonLabel(button.label, `${buttonPath}.label`)
        for (const key of ['accessibilityLabel', 'accessibilityHint'] as const) {
          if (button[key] !== undefined) string(button[key], `${buttonPath}.${key}`)
        }
        if (object(button.styles, `${buttonPath}.styles`, ['size', 'appearance', 'backgroundColor', 'outlineColor'])) {
          const size = button.styles.size
          if (!isActionButtonSize(size)) {
            issue(`${buttonPath}.styles.size`, 'Expected "1/1", "1/2", "1/3", "1/4" or "1/5".')
          }
          if (button.styles.appearance !== undefined && !isActionButtonAppearance(button.styles.appearance)) {
            issue(`${buttonPath}.styles.appearance`, 'Expected "filled" or "outline".')
          }
          if (button.styles.backgroundColor !== undefined) {
            color(button.styles.backgroundColor, `${buttonPath}.styles.backgroundColor`, true)
          }
          if (button.styles.outlineColor !== undefined) {
            color(button.styles.outlineColor, `${buttonPath}.styles.outlineColor`, true)
          }
        }
        if (semantic && button.tap === undefined && button.longPress === undefined) {
          issue(`${buttonPath}.tap`, 'A button must define tap or longPress.')
        }
        if (button.tap !== undefined) interaction(button.tap, `${buttonPath}.tap`)
        if (button.longPress !== undefined) interaction(button.longPress, `${buttonPath}.longPress`)
      })
    })
  })

  if (stringBytes > ACTION_PAD_CONFIG_MAX_BYTES) issue('$', 'Configuration text exceeds the 1 MiB limit.')
  if (semantic && issues.length === 0) validateGraph(value as unknown as ActionPadConfig, issue)
  return issues
}

function validateGraph(config: ActionPadConfig, issue: (path: string, message: string) => void) {
  interface GraphEdge {
    readonly target: string
    readonly path: string
    readonly type: 'menu' | 'group'
  }
  const menus = new Map(config.menus.map((menu) => [menu.id, menu]))
  const menuIds = new Set(menus.keys())
  const edges = new Map<string, GraphEdge[]>()
  if (!menuIds.has(config.rootMenuId)) issue('rootMenuId', `Missing action menu definition: ${config.rootMenuId}`)

  config.menus.forEach((menu, menuIndex) => {
    const references: GraphEdge[] = []
    menu.groups.forEach((group, groupIndex) => {
      group.buttons.forEach((button, buttonIndex) => {
        for (const gesture of ['tap', 'longPress'] as const) {
          const interaction = button[gesture]
          if (interaction?.type !== 'menu' && interaction?.type !== 'group') continue
          const interactionPath = `menus[${menuIndex}].groups[${groupIndex}].buttons[${buttonIndex}].${gesture}`
          const menuPath = `${interactionPath}.menuId`
          const targetMenu = menus.get(interaction.menuId)
          if (targetMenu === undefined) {
            issue(menuPath, `Missing action menu definition: ${interaction.menuId}`)
          } else if (interaction.type === 'group') {
            const groupPath = `${interactionPath}.groupId`
            const sameMenu = interaction.menuId === menu.id
            if (sameMenu) {
              issue(menuPath, 'Group interactions must target a different menu.')
            }
            if (!targetMenu.groups.some((candidate) => candidate.id === interaction.groupId)) {
              issue(groupPath, `Missing action group definition: ${interaction.menuId}/${interaction.groupId}`)
            }
          }
          if (interaction.type !== 'group' || interaction.menuId !== menu.id) {
            references.push({ target: interaction.menuId, path: menuPath, type: interaction.type })
          }
        }
      })
    })
    edges.set(menu.id, references)
  })

  const complete = new Set<string>()
  const visiting: string[] = []
  const visitingEdges: GraphEdge[] = []
  function walk(menuId: string) {
    if (complete.has(menuId)) return
    visiting.push(menuId)
    for (const edge of edges.get(menuId) ?? []) {
      const cycleStart = visiting.indexOf(edge.target)
      if (cycleStart >= 0) {
        const cycleIncludesGroup = [...visitingEdges.slice(cycleStart), edge].some((candidate) => candidate.type === 'group')
        issue(edge.path, `Cyclic action ${cycleIncludesGroup ? 'menu/group' : 'menu'} reference: ${[...visiting.slice(cycleStart), edge.target].join(' -> ')}`)
      } else if (menuIds.has(edge.target)) {
        visitingEdges.push(edge)
        walk(edge.target)
        visitingEdges.pop()
      }
    }
    visiting.pop()
    complete.add(menuId)
  }
  for (const menu of config.menus) walk(menu.id)
}

export function parseActionPadConfig(source: string): ActionPadConfig {
  try {
    assertTextSize(source)
    const document = parseDocument(source, {
      version: '1.2',
      schema: 'core',
      uniqueKeys: true,
      stringKeys: true,
      merge: false,
      resolveKnownTags: false,
      customTags: [],
      // `silent` also suppresses the parser's multiple-document error.
      logLevel: 'error'
    })
    const syntaxIssues = [...document.errors, ...document.warnings].map((error) => ({
      path: 'yaml',
      message: error.message
    }))
    if (document.directives?.yaml.version !== '1.2') {
      syntaxIssues.push({ path: 'yaml', message: 'Only YAML 1.2 documents are supported.' })
    }
    let nodes = 0
    visit(document, (_key, node, path) => {
      nodes += 1
      if (nodes > MAX_ITEMS * 20 || path.length > MAX_YAML_DEPTH) {
        syntaxIssues.push({ path: 'yaml', message: 'YAML document is too deeply nested or complex.' })
        return visit.BREAK
      }
      if (isAlias(node) || (isNode(node) && (node.tag !== undefined || ('anchor' in node && node.anchor !== undefined)))) {
        syntaxIssues.push({ path: 'yaml', message: 'YAML aliases, anchors and explicit tags are not supported.' })
        return visit.BREAK
      }
    })
    if (syntaxIssues.length > 0) throw new ActionPadConfigError(syntaxIssues)
    const value: unknown = document.toJS({ maxAliasCount: 0 })
    assertValid(value)
    return normalizeConfig(value)
  } catch (error) {
    if (error instanceof ActionPadConfigError) throw error
    throw new ActionPadConfigError([{ path: 'yaml', message: error instanceof Error ? error.message : 'Could not parse YAML.' }])
  }
}

export function serializeActionPadConfig(config: ActionPadConfig): string {
  assertValid(config)
  const source = stringify(normalizeConfig(config), {
    version: '1.2',
    defaultStringType: 'QUOTE_SINGLE',
    defaultKeyType: 'PLAIN',
    aliasDuplicateObjects: false,
    lineWidth: 0
  })
  assertTextSize(source)
  return source
}

function assertValid(value: unknown): asserts value is ActionPadConfig {
  const issues = validateActionPadConfig(value)
  if (issues.length > 0) throw new ActionPadConfigError(issues)
}

function assertTextSize(source: string) {
  if (typeof source !== 'string') throw new ActionPadConfigError([{ path: 'yaml', message: 'Expected YAML text.' }])
  if (source.length > ACTION_PAD_CONFIG_MAX_BYTES || utf8Bytes(source) > ACTION_PAD_CONFIG_MAX_BYTES) {
    throw new ActionPadConfigError([{ path: 'yaml', message: 'Configuration file exceeds the 1 MiB limit.' }])
  }
}

function utf8Bytes(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}

function normalizeInteraction(interaction: ActionMenuDefinitionInteraction): ActionMenuDefinitionInteraction {
  switch (interaction.type) {
    case 'input': return { type: 'input', nvimInput: interaction.nvimInput, after: interaction.after }
    case 'menu': return { type: 'menu', menuId: interaction.menuId, after: interaction.after }
    case 'group': return { type: 'group', menuId: interaction.menuId, groupId: interaction.groupId, after: interaction.after }
    case 'back': return { type: 'back', after: interaction.after }
    case 'keyboard': return { type: 'keyboard', after: interaction.after }
  }
}

function normalizeConfig(config: ActionPadConfig): ActionPadConfig {
  return {
    version: 1,
    rootMenuId: config.rootMenuId,
    menus: config.menus.map((menu) => ({
      id: menu.id,
      label: menu.label,
      groups: menu.groups.map((group) => ({
        id: group.id,
        buttons: group.buttons.map((button) => ({
          id: button.id,
          label: normalizeButtonLabel(button.label),
          ...(button.accessibilityLabel === undefined ? {} : { accessibilityLabel: button.accessibilityLabel }),
          ...(button.accessibilityHint === undefined ? {} : { accessibilityHint: button.accessibilityHint }),
          styles: {
            size: button.styles.size,
            ...(button.styles.appearance === undefined ? {} : { appearance: button.styles.appearance }),
            ...(button.styles.backgroundColor === undefined ? {} : { backgroundColor: button.styles.backgroundColor }),
            ...(button.styles.outlineColor === undefined ? {} : { outlineColor: button.styles.outlineColor })
          },
          ...(button.tap === undefined ? {} : { tap: normalizeInteraction(button.tap) }),
          ...(button.longPress === undefined ? {} : { longPress: normalizeInteraction(button.longPress) })
        }))
      }))
    }))
  }
}

function normalizeButtonLabel(label: ActionButtonLabel): ActionButtonLabel {
  if (typeof label === 'string') return label
  return label.map((run) => ({
    text: run.text,
    fontSize: run.fontSize,
    bold: run.bold,
    ...(run.color === undefined ? {} : { color: run.color })
  }))
}

export function resolveActionPadConfig(config: ActionPadConfig): ActionMenu {
  assertValid(config)
  const definitions = new Map(config.menus.map((menu) => [menu.id, menu]))
  const resolved = new Map<string, ActionMenu>()

  function resolveInteraction(interaction: ActionMenuDefinitionInteraction): ActionInteraction {
    if (interaction.type === 'menu') {
      return { type: 'menu', menu: resolveMenu(interaction.menuId), after: interaction.after }
    }
    if (interaction.type === 'group') {
      const menu = resolveMenu(interaction.menuId)
      const group = menu.groups.find((candidate) => candidate.id === interaction.groupId)
      if (group === undefined) {
        throw new ActionPadConfigError([{
          path: 'menus',
          message: `Missing action group definition: ${interaction.menuId}/${interaction.groupId}`
        }])
      }
      return { type: 'group', menu, group, after: interaction.after }
    }
    return { ...interaction }
  }

  function resolveButton(button: ActionMenuDefinitionButton): ActionButton {
    const { tap, longPress, ...base } = button
    if (tap !== undefined) {
      return {
        ...base,
        tap: resolveInteraction(tap),
        ...(longPress === undefined ? {} : { longPress: resolveInteraction(longPress) })
      }
    }
    if (longPress !== undefined) return { ...base, longPress: resolveInteraction(longPress) }
    throw new ActionPadConfigError([{ path: button.id, message: 'A button must define tap or longPress.' }])
  }

  function resolveMenu(menuId: string): ActionMenu {
    const cached = resolved.get(menuId)
    if (cached !== undefined) return cached
    const definition = definitions.get(menuId)
    if (definition === undefined) throw new ActionPadConfigError([{ path: 'menus', message: `Missing action menu definition: ${menuId}` }])
    const menu: ActionMenu = {
      id: definition.id,
      label: definition.label,
      groups: definition.groups.map((group) => ({ id: group.id, buttons: group.buttons.map(resolveButton) }))
    }
    resolved.set(menuId, menu)
    return menu
  }

  return resolveMenu(config.rootMenuId)
}
