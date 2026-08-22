export interface KeyModifiers {
  readonly ctrl?: boolean
  readonly alt?: boolean
  readonly shift?: boolean
  readonly meta?: boolean
}

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

export function keyRowInput(key: string, control = false): string | null {
  const keyName = SPECIAL_KEYS[key]
  if (keyName === undefined) return null
  return modifiedNotation(keyName, control ? { ctrl: true } : undefined)
}

export function committedTextToNvimInput(text: string, control = false): string {
  if (!control) return escapeNvimText(text)

  const characters = Array.from(text)
  if (characters.length === 0) return ''
  const [character, ...remainder] = characters
  return `<C-${character === '<' ? 'lt' : character}>${escapeNvimText(remainder.join(''))}`
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
