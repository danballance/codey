/** Native TextInput selections use UTF-16 offsets, including for astral icons. */
export interface LabelTextSelection {
  readonly start: number
  readonly end: number
}

/** Replace a selection (or append), without ever splitting a surrogate pair. */
export function insertLabelText(text: string, inserted: string, selection?: LabelTextSelection): {
  readonly text: string
  readonly selection: LabelTextSelection
} {
  const clamp = (offset: number) => Number.isFinite(offset)
    ? Math.max(0, Math.min(text.length, Math.trunc(offset)))
    : text.length
  const first = clamp(selection?.start ?? text.length)
  const last = clamp(selection?.end ?? text.length)
  let start = Math.min(first, last)
  let end = Math.max(first, last)
  const splitsPair = (offset: number) => {
    const before = text.charCodeAt(offset - 1)
    const after = text.charCodeAt(offset)
    return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
  }
  if (start === end) {
    if (splitsPair(start)) start = end = start + 1
  } else {
    if (splitsPair(start)) start -= 1
    if (splitsPair(end)) end += 1
  }
  const cursor = start + inserted.length
  return {
    text: text.slice(0, start) + inserted + text.slice(end),
    selection: { start: cursor, end: cursor }
  }
}
