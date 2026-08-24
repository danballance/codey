export interface KeyModifiers {
  readonly ctrl?: boolean
  readonly alt?: boolean
  readonly shift?: boolean
  readonly meta?: boolean
}

export type NvimSpecialKeyName =
  | 'Backspace'
  | 'Delete'
  | 'Enter'
  | 'Escape'
  | 'Tab'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown'
  | 'Insert'
  | `F${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12}`

export interface NativeSpecialKey {
  readonly key: string
  readonly modifiers?: KeyModifiers
}

const SPECIAL_KEYS: Readonly<Record<string, string>> = Object.freeze({
  Backspace: 'BS',
  Delete: 'Del',
  Enter: 'CR',
  Escape: 'Esc',
  Tab: 'Tab',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert'
})

export function isNvimSpecialKeyName(key: string): key is NvimSpecialKeyName {
  return Object.prototype.hasOwnProperty.call(SPECIAL_KEYS, key) || functionKey(key) !== null
}

export function escapeNvimText(text: string): string {
  return text.replaceAll('<', '<lt>')
}

export function specialKeyToNvimInput(event: NativeSpecialKey): string | null {
  const keyName = SPECIAL_KEYS[event.key] ?? functionKey(event.key)
  if (keyName !== null) return modifiedNotation(keyName, event.modifiers)

  const characters = Array.from(event.key)
  if (characters.length !== 1) return null
  const character = characters[0]!
  const modifiers = event.modifiers ?? {}
  if (modifiers.ctrl || modifiers.alt || modifiers.meta) {
    return modifiedNotation(character === '<' ? 'lt' : character, {
      ctrl: modifiers.ctrl,
      alt: modifiers.alt,
      meta: modifiers.meta
    })
  }
  return escapeNvimText(character)
}

export function committedTextToNvimInput(text: string): string {
  return escapeNvimText(text)
}

function functionKey(key: string): string | null {
  return /^F(?:[1-9]|1[0-2])$/.test(key) ? key : null
}

function modifiedNotation(keyName: string, modifiers: KeyModifiers = {}): string {
  const prefixes: string[] = []
  if (modifiers.ctrl) prefixes.push('C')
  if (modifiers.shift) prefixes.push('S')
  if (modifiers.alt) prefixes.push('A')
  if (modifiers.meta) prefixes.push('D')
  return `<${prefixes.length > 0 ? `${prefixes.join('-')}-` : ''}${keyName}>`
}
