export const DIAGNOSTIC_LEVELS = ['debug', 'info', 'warn', 'error'] as const

export type DiagnosticLevel = (typeof DIAGNOSTIC_LEVELS)[number]

export const DIAGNOSTIC_CATEGORIES = [
  'app',
  'device',
  'settings',
  'workspace',
  'connection',
  'transport',
  'rpc',
  'nvim',
  'action-pad',
  'renderer',
  'ime'
] as const

export type DiagnosticCategory = (typeof DIAGNOSTIC_CATEGORIES)[number]

export type DiagnosticValue =
  | null
  | boolean
  | number
  | string
  | readonly DiagnosticValue[]
  | { readonly [key: string]: DiagnosticValue }

export interface DiagnosticLogMetadata {
  operationId?: string
  parentOperationId?: string
  durationMs?: number
}

export interface DiagnosticLogInput extends DiagnosticLogMetadata {
  category: DiagnosticCategory
  event: string
  message: string
  details?: unknown
}

export interface DiagnosticEntry extends DiagnosticLogMetadata {
  sequence: number
  timestamp: number
  elapsedMs: number
  level: DiagnosticLevel
  category: DiagnosticCategory
  event: string
  message: string
  details?: DiagnosticValue
  detailsText: string
  truncated: boolean
  sizeBytes: number
}

export interface DiagnosticSnapshot {
  runId: string
  runStartedAt: number
  entries: readonly DiagnosticEntry[]
  evictedCount: number
  totalBytes: number
}

export interface DiagnosticOperationCheckpointInput {
  event?: string
  message?: string
  details?: unknown
  level?: DiagnosticLevel
}

export interface DiagnosticOperationOutcomeInput {
  event?: string
  message?: string
  details?: unknown
  durationMs?: number
}

export interface DiagnosticOperation {
  readonly id: string
  checkpoint(input?: DiagnosticOperationCheckpointInput): DiagnosticEntry | undefined
  checkpoint(event: string, message?: string, details?: unknown): DiagnosticEntry | undefined
  success(input?: DiagnosticOperationOutcomeInput): DiagnosticEntry
  failure(error: unknown, input?: DiagnosticOperationOutcomeInput): DiagnosticEntry
  cancellation(input?: DiagnosticOperationOutcomeInput): DiagnosticEntry
}

export interface DiagnosticLogger {
  debug(input: DiagnosticLogInput): DiagnosticEntry
  info(input: DiagnosticLogInput): DiagnosticEntry
  warn(input: DiagnosticLogInput): DiagnosticEntry
  error(input: DiagnosticLogInput): DiagnosticEntry
  operation(input: DiagnosticLogInput): DiagnosticOperation
  getSnapshot(): DiagnosticSnapshot
  subscribe(listener: () => void): () => void
  clear(): void
}

export interface DiagnosticConsole {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface CreateDiagnosticLoggerOptions {
  maxEntries?: number
  maxTotalBytes?: number
  maxEntryBytes?: number
  maxDepth?: number
  maxNodes?: number
  maxCollectionEntries?: number
  now?: () => number
  elapsedNow?: () => number
  idGenerator?: () => string
  console?: DiagnosticConsole
}

const DEFAULT_MAX_ENTRIES = 1_024
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1_024 * 1_024
const DEFAULT_MAX_ENTRY_BYTES = 2 * 1_024 * 1_024
const DEFAULT_MAX_DEPTH = 16
const DEFAULT_MAX_NODES = 50_000
const DEFAULT_MAX_COLLECTION_ENTRIES = 10_000
const TRUNCATED_SUFFIX = '\u2026[truncated]'
const NORMALIZATION_NODE_BYTES = 64
const NORMALIZATION_ERROR_BYTES = 4_096
const MATERIALIZATION_LIMIT_SENTINEL = '[Truncated: materialization limit]'

let generatedIdSequence = 0

function defaultIdGenerator(): string {
  generatedIdSequence += 1
  return `${Date.now().toString(36)}-${generatedIdSequence.toString(36)}`
}

function defaultElapsedNow(): number {
  if (typeof globalThis.performance?.now === 'function') {
    return globalThis.performance.now()
  }
  return Date.now()
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('Diagnostic logger limits must be finite positive numbers')
  }
  return Math.max(1, Math.floor(value))
}

/** Returns the exact number of bytes produced by UTF-8 encoding `value`. */
export function diagnosticUtf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit <= 0x7f) {
      bytes += 1
    } else if (codeUnit <= 0x7ff) {
      bytes += 2
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }
  return bytes
}

function truncateUtf8(value: string, maximumBytes: number, suffix = TRUNCATED_SUFFIX): string {
  if (maximumBytes <= 0) return ''
  if (diagnosticUtf8ByteLength(value) <= maximumBytes) return value

  const suffixBytes = diagnosticUtf8ByteLength(suffix)
  if (suffixBytes >= maximumBytes) {
    let result = ''
    for (const character of suffix) {
      if (diagnosticUtf8ByteLength(result + character) > maximumBytes) break
      result += character
    }
    return result
  }

  const prefixLimit = maximumBytes - suffixBytes
  let prefix = ''
  let prefixBytes = 0
  for (const character of value) {
    const characterBytes = diagnosticUtf8ByteLength(character)
    if (prefixBytes + characterBytes > prefixLimit) break
    prefix += character
    prefixBytes += characterBytes
  }
  return prefix + suffix
}

interface NormalizationState {
  maxDepth: number
  maxNodes: number
  maxCollectionEntries: number
  maxStringBytes: number
  remainingMaterializationBytes: number
  materializationExhausted: boolean
  nodes: number
  truncated: boolean
  ancestors: WeakMap<object, string>
}

function safeString(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '[Unprintable value]'
  }
}

function jsonStringCharacterBytes(value: string, index: number): readonly [number, number] {
  const codeUnit = value.charCodeAt(index)
  if (codeUnit === 0x22 || codeUnit === 0x5c) return [2, 1]
  if (codeUnit <= 0x1f) {
    return codeUnit === 0x08 || codeUnit === 0x09 || codeUnit === 0x0a ||
      codeUnit === 0x0c || codeUnit === 0x0d
      ? [2, 1]
      : [6, 1]
  }
  if (codeUnit <= 0x7f) return [1, 1]
  if (codeUnit <= 0x7ff) return [2, 1]
  if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
    const next = value.charCodeAt(index + 1)
    if (next >= 0xdc00 && next <= 0xdfff) return [4, 2]
  }
  return [3, 1]
}

function jsonStringByteLength(value: string, stopAfter = Number.POSITIVE_INFINITY): number {
  let bytes = 2
  for (let index = 0; index < value.length;) {
    const [characterBytes, codeUnits] = jsonStringCharacterBytes(value, index)
    bytes += characterBytes
    if (bytes > stopAfter) return bytes
    index += codeUnits
  }
  return bytes
}

function truncateJsonString(value: string, maximumBytes: number): string {
  if (maximumBytes <= 2) return ''
  const contentLimit = maximumBytes - 2
  const suffixContentBytes = jsonStringByteLength(TRUNCATED_SUFFIX) - 2
  const retainedSuffix = suffixContentBytes <= contentLimit ? TRUNCATED_SUFFIX : ''
  const prefixLimit = contentLimit - (retainedSuffix.length === 0 ? 0 : suffixContentBytes)
  let prefixBytes = 0
  let end = 0
  for (let index = 0; index < value.length;) {
    const [characterBytes, codeUnits] = jsonStringCharacterBytes(value, index)
    if (prefixBytes + characterBytes > prefixLimit) break
    prefixBytes += characterBytes
    index += codeUnits
    end = index
  }
  return value.slice(0, end) + retainedSuffix
}

function reserveMaterialization(state: NormalizationState, bytes: number): boolean {
  if (bytes > state.remainingMaterializationBytes) {
    state.truncated = true
    state.materializationExhausted = true
    return false
  }
  state.remainingMaterializationBytes -= bytes
  if (state.remainingMaterializationBytes < NORMALIZATION_NODE_BYTES) {
    state.materializationExhausted = true
  }
  return true
}

function normalizeNumber(value: number): DiagnosticValue {
  if (Number.isNaN(value)) return '[NaN]'
  if (value === Number.POSITIVE_INFINITY) return '[Infinity]'
  if (value === Number.NEGATIVE_INFINITY) return '[-Infinity]'
  if (Object.is(value, -0)) return '[-0]'
  return value
}

function normalizeString(value: string, state: NormalizationState): string {
  const maximumBytes = Math.min(state.maxStringBytes, state.remainingMaterializationBytes)
  const encodedBytes = jsonStringByteLength(value, maximumBytes)
  if (encodedBytes <= maximumBytes) {
    reserveMaterialization(state, encodedBytes)
    return value
  }

  state.truncated = true
  const result = truncateJsonString(value, maximumBytes)
  reserveMaterialization(state, jsonStringByteLength(result))
  return result
}

function constructorName(value: object): string | undefined {
  try {
    const name = value.constructor?.name
    return typeof name === 'string' && name.length > 0 ? name : undefined
  } catch {
    return undefined
  }
}

interface BoundedEnumerableKeys {
  readonly keys: readonly string[]
  readonly truncated: boolean
  readonly error?: unknown
}

/** Enumerates only a bounded prefix so very wide objects never create an unbounded key array. */
function boundedOwnEnumerableKeys(value: object, maximum: number): BoundedEnumerableKeys {
  const keys: string[] = []
  try {
    for (const key in value) {
      let own = true
      try {
        own = Object.prototype.hasOwnProperty.call(value, key)
      } catch {
        // A hostile proxy cannot be trusted to distinguish inherited keys. Retaining
        // the bounded value is more useful than dropping the complete diagnostic.
      }
      if (!own) continue
      if (keys.length >= maximum) return { keys, truncated: true }
      keys.push(key)
    }
    return { keys, truncated: false }
  } catch (error) {
    return { keys, truncated: false, error }
  }
}

function normalizeError(
  value: Error,
  state: NormalizationState,
  depth: number,
  path: string
): DiagnosticValue {
  const result: Record<string, DiagnosticValue> = {
    $type: constructorName(value) ?? 'Error',
    name: normalizeString(value.name, state),
    message: normalizeString(value.message, state)
  }
  if (typeof value.stack === 'string') {
    result.stack = normalizeString(value.stack, state)
  }
  const errorWithCause = value as Error & { cause?: unknown }
  if ('cause' in errorWithCause) {
    result.cause = normalizeValue(errorWithCause.cause, state, depth + 1, `${path}.cause`)
  }
  const keyResult = boundedOwnEnumerableKeys(value, state.maxCollectionEntries)
  if (keyResult.error !== undefined) {
    result.$propertyError = normalizeString(safeString(keyResult.error), state)
  }
  for (const key of keyResult.keys) {
    if (state.materializationExhausted) {
      state.truncated = true
      break
    }
    if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') continue
    const normalizedKey = normalizeString(key, state)
    if (state.materializationExhausted) {
      state.truncated = true
      result.$truncatedProperties = 1
      break
    }
    try {
      result[normalizedKey] = normalizeValue(
        (value as unknown as Record<string, unknown>)[key],
        state,
        depth + 1,
        `${path}.${key}`
      )
    } catch (error) {
      result[normalizedKey] = normalizeString(
        `[Thrown while reading: ${safeString(error)}]`,
        state
      )
    }
  }
  if (keyResult.truncated) {
    state.truncated = true
    result.$truncatedProperties = 1
  }
  return Object.freeze(result)
}

function normalizeArrayBuffer(
  value: ArrayBuffer,
  state: NormalizationState,
  depth: number,
  path: string,
  type: string
): DiagnosticValue {
  const bytes = new Uint8Array(value)
  const retainedLength = Math.min(
    bytes.length,
    state.maxCollectionEntries,
    Math.max(0, Math.floor(state.remainingMaterializationBytes / NORMALIZATION_NODE_BYTES))
  )
  const retained: number[] = []
  for (let index = 0; index < retainedLength; index += 1) {
    retained.push(bytes[index] ?? 0)
  }
  if (bytes.length > retainedLength) state.truncated = true
  const values = normalizeValue(retained, state, depth + 1, `${path}.values`)
  return Object.freeze({
    $type: type,
    byteLength: value.byteLength,
    values,
    ...(bytes.length > retainedLength ? { omittedValues: bytes.length - retainedLength } : {})
  })
}

function normalizeArrayBufferView(
  value: ArrayBufferView,
  state: NormalizationState,
  depth: number,
  path: string
): DiagnosticValue {
  const type = constructorName(value) ?? 'ArrayBufferView'
  if (value instanceof DataView) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    const retainedLength = Math.min(
      bytes.length,
      state.maxCollectionEntries,
      Math.max(0, Math.floor(state.remainingMaterializationBytes / NORMALIZATION_NODE_BYTES))
    )
    const retained: number[] = []
    for (let index = 0; index < retainedLength; index += 1) {
      retained.push(bytes[index] ?? 0)
    }
    if (bytes.length > retainedLength) state.truncated = true
    return Object.freeze({
      $type: type,
      byteLength: value.byteLength,
      values: normalizeValue(retained, state, depth + 1, `${path}.values`),
      ...(bytes.length > retainedLength ? { omittedValues: bytes.length - retainedLength } : {})
    })
  }

  let values: unknown[]
  try {
    const arrayLike = value as unknown as ArrayLike<unknown>
    const retainedLength = Math.min(
      arrayLike.length,
      state.maxCollectionEntries,
      Math.max(0, Math.floor(state.remainingMaterializationBytes / NORMALIZATION_NODE_BYTES))
    )
    values = []
    for (let index = 0; index < retainedLength; index += 1) {
      values.push(arrayLike[index])
    }
    if (arrayLike.length > retainedLength) state.truncated = true
  } catch (error) {
    values = [`[Unable to read typed values: ${safeString(error)}]`]
  }
  const sourceLength = (value as unknown as { length?: unknown }).length
  const omittedValues =
    typeof sourceLength === 'number' && sourceLength > values.length
      ? sourceLength - values.length
      : 0
  return Object.freeze({
    $type: type,
    byteLength: value.byteLength,
    values: normalizeValue(values, state, depth + 1, `${path}.values`),
    ...(omittedValues > 0 ? { omittedValues } : {})
  })
}

function normalizeObject(
  value: object,
  state: NormalizationState,
  depth: number,
  path: string
): DiagnosticValue {
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isNaN(time) ? '[Invalid Date]' : value.toISOString()
  }
  if (value instanceof RegExp) return value.toString()
  if (value instanceof Error) return normalizeError(value, state, depth, path)
  if (value instanceof ArrayBuffer) {
    return normalizeArrayBuffer(value, state, depth, path, 'ArrayBuffer')
  }
  if (ArrayBuffer.isView(value)) {
    return normalizeArrayBufferView(value, state, depth, path)
  }

  if (value instanceof Map) {
    const entries: DiagnosticValue[] = []
    let index = 0
    try {
      for (const [key, entryValue] of value) {
        if (index >= state.maxCollectionEntries || state.materializationExhausted) {
          state.truncated = true
          break
        }
        entries.push(
          Object.freeze([
            normalizeValue(key, state, depth + 1, `${path}.entries[${index}][0]`),
            normalizeValue(entryValue, state, depth + 1, `${path}.entries[${index}][1]`)
          ])
        )
        index += 1
      }
    } catch (error) {
      state.truncated = true
      if (!state.materializationExhausted) {
        entries.push(normalizeString(`[Iterator threw: ${safeString(error)}]`, state))
      }
    }
    return Object.freeze({
      $type: 'Map',
      size: value.size,
      entries: Object.freeze(entries)
    })
  }

  if (value instanceof Set) {
    const values: DiagnosticValue[] = []
    let index = 0
    try {
      for (const entryValue of value) {
        if (index >= state.maxCollectionEntries || state.materializationExhausted) {
          state.truncated = true
          break
        }
        values.push(normalizeValue(entryValue, state, depth + 1, `${path}.values[${index}]`))
        index += 1
      }
    } catch (error) {
      state.truncated = true
      if (!state.materializationExhausted) {
        values.push(normalizeString(`[Iterator threw: ${safeString(error)}]`, state))
      }
    }
    return Object.freeze({
      $type: 'Set',
      size: value.size,
      values: Object.freeze(values)
    })
  }

  if (Array.isArray(value)) {
    const length = Math.min(value.length, state.maxCollectionEntries)
    const result: DiagnosticValue[] = []
    for (let index = 0; index < length; index += 1) {
      if (state.materializationExhausted) {
        state.truncated = true
        if (result.at(-1) !== MATERIALIZATION_LIMIT_SENTINEL) {
          result.push(MATERIALIZATION_LIMIT_SENTINEL)
        }
        break
      }
      if (index in value) {
        result.push(normalizeValue(value[index], state, depth + 1, `${path}[${index}]`))
      } else {
        if (!reserveMaterialization(state, NORMALIZATION_NODE_BYTES)) {
          result.push(MATERIALIZATION_LIMIT_SENTINEL)
          break
        }
        result.push('[Array hole]')
      }
    }
    if (value.length > length) {
      state.truncated = true
      result.push(`[Truncated ${value.length - length} array entries]`)
    }
    return Object.freeze(result)
  }

  const result: Record<string, DiagnosticValue> = {}
  const type = constructorName(value)
  if (type !== undefined && type !== 'Object') result.$type = type

  const keyResult = boundedOwnEnumerableKeys(value, state.maxCollectionEntries)
  if (keyResult.error !== undefined) {
    result.$propertyError = normalizeString(safeString(keyResult.error), state)
  }

  for (const rawKey of keyResult.keys) {
    if (state.materializationExhausted) {
      state.truncated = true
      result.$truncatedProperties = 1
      break
    }
    const key = normalizeString(rawKey, state)
    if (state.materializationExhausted) {
      state.truncated = true
      result.$truncatedProperties = 1
      break
    }
    try {
      result[key] = normalizeValue(
        Reflect.get(value, rawKey),
        state,
        depth + 1,
        `${path}.${key}`
      )
    } catch (error) {
      result[key] = normalizeString(`[Thrown while reading: ${safeString(error)}]`, state)
    }
  }
  if (keyResult.truncated) {
    state.truncated = true
    result.$truncatedProperties = 1
  }
  return Object.freeze(result)
}

function normalizeValue(
  value: unknown,
  state: NormalizationState,
  depth: number,
  path: string
): DiagnosticValue {
  if (!reserveMaterialization(state, NORMALIZATION_NODE_BYTES)) {
    return MATERIALIZATION_LIMIT_SENTINEL
  }
  state.nodes += 1
  if (state.nodes > state.maxNodes) {
    state.truncated = true
    return '[Truncated: node limit]'
  }
  if (depth > state.maxDepth) {
    state.truncated = true
    return '[Truncated: depth limit]'
  }

  if (value === null) return null
  switch (typeof value) {
    case 'string':
      return normalizeString(value, state)
    case 'boolean':
      return value
    case 'number':
      return normalizeNumber(value)
    case 'undefined':
      return '[Undefined]'
    case 'bigint':
      return normalizeString(`${value.toString()}n`, state)
    case 'symbol':
      return normalizeString(safeString(value), state)
    case 'function':
      return normalizeString(
        `[Function ${safeString(value.name || 'anonymous')}]`,
        state
      )
    case 'object': {
      const existingPath = state.ancestors.get(value)
      if (existingPath !== undefined) return `[Circular -> ${existingPath}]`
      state.ancestors.set(value, path)
      try {
        return normalizeObject(value, state, depth, path)
      } finally {
        state.ancestors.delete(value)
      }
    }
  }
  return '[Unsupported value]'
}

interface NormalizedDetails {
  details?: DiagnosticValue
  detailsText: string
  truncated: boolean
}

function normalizeDetails(
  value: unknown,
  options: {
    maxDepth: number
    maxNodes: number
    maxCollectionEntries: number
    maxStringBytes: number
    maxMaterializationBytes: number
  }
): NormalizedDetails {
  if (value === undefined) return { detailsText: '', truncated: false }
  const state: NormalizationState = {
    ...options,
    nodes: 0,
    truncated: false,
    remainingMaterializationBytes: options.maxMaterializationBytes,
    materializationExhausted: false,
    ancestors: new WeakMap()
  }
  try {
    const details = normalizeValue(value, state, 0, '$')
    const detailsText = JSON.stringify(details, null, 2)
    return { details, detailsText, truncated: state.truncated }
  } catch (error) {
    const message = truncateUtf8(
      safeString(error),
      Math.min(NORMALIZATION_ERROR_BYTES, options.maxMaterializationBytes)
    )
    const details = Object.freeze({
      $normalizationError: message
    })
    return {
      details,
      detailsText: JSON.stringify(details, null, 2),
      truncated: true
    }
  }
}

type MutableDiagnosticEntry = Omit<DiagnosticEntry, 'sizeBytes'> & { sizeBytes: number }

function serializedEntrySize(entry: MutableDiagnosticEntry): number {
  return diagnosticUtf8ByteLength(JSON.stringify(entry))
}

function settleEntrySize(entry: MutableDiagnosticEntry): number {
  let size = entry.sizeBytes
  for (let attempt = 0; attempt < 8; attempt += 1) {
    entry.sizeBytes = size
    const next = serializedEntrySize(entry)
    if (next === size) return size
    size = next
  }
  entry.sizeBytes = size
  return serializedEntrySize(entry)
}

function fitEntryToLimit(entry: MutableDiagnosticEntry, maximumBytes: number): void {
  entry.sizeBytes = settleEntrySize(entry)
  if (entry.sizeBytes <= maximumBytes) return

  entry.truncated = true
  if (entry.details !== undefined || entry.detailsText.length > 0) {
    const rawDetailsText = entry.detailsText
    entry.details = Object.freeze({ $truncated: true })
    entry.detailsText = '[Truncated: entry size limit]'
    entry.sizeBytes = settleEntrySize(entry)

    if (entry.sizeBytes < maximumBytes && rawDetailsText.length > 0) {
      let low = 0
      let high = diagnosticUtf8ByteLength(rawDetailsText)
      let bestText = entry.detailsText
      while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const preview = truncateUtf8(rawDetailsText, middle, '\n' + TRUNCATED_SUFFIX)
        entry.details = Object.freeze({ $truncated: true, preview })
        entry.detailsText = preview
        const candidateSize = settleEntrySize(entry)
        if (candidateSize <= maximumBytes) {
          bestText = preview
          low = middle + 1
        } else {
          high = middle - 1
        }
      }
      entry.details = Object.freeze({ $truncated: true, preview: bestText })
      entry.detailsText = bestText
      entry.sizeBytes = settleEntrySize(entry)
    }
  }

  if (entry.sizeBytes <= maximumBytes) return

  delete entry.details
  entry.detailsText = ''
  const originals = {
    event: entry.event,
    message: entry.message,
    operationId: entry.operationId,
    parentOperationId: entry.parentOperationId
  }
  let low = 0
  let high = Math.max(
    diagnosticUtf8ByteLength(originals.event),
    diagnosticUtf8ByteLength(originals.message),
    originals.operationId === undefined ? 0 : diagnosticUtf8ByteLength(originals.operationId),
    originals.parentOperationId === undefined
      ? 0
      : diagnosticUtf8ByteLength(originals.parentOperationId)
  )
  let best = 0
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    entry.event = truncateUtf8(originals.event, middle)
    entry.message = truncateUtf8(originals.message, middle)
    if (originals.operationId !== undefined) {
      entry.operationId = truncateUtf8(originals.operationId, middle)
    }
    if (originals.parentOperationId !== undefined) {
      entry.parentOperationId = truncateUtf8(originals.parentOperationId, middle)
    }
    const candidateSize = settleEntrySize(entry)
    if (candidateSize <= maximumBytes) {
      best = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  entry.event = truncateUtf8(originals.event, best)
  entry.message = truncateUtf8(originals.message, best)
  if (originals.operationId !== undefined) {
    entry.operationId = truncateUtf8(originals.operationId, best)
  }
  if (originals.parentOperationId !== undefined) {
    entry.parentOperationId = truncateUtf8(originals.parentOperationId, best)
  }
  entry.sizeBytes = settleEntrySize(entry)
}

function freezeEntry(entry: MutableDiagnosticEntry): DiagnosticEntry {
  entry.sizeBytes = settleEntrySize(entry)
  return Object.freeze(entry)
}

function withFailureDetails(error: unknown, details: unknown): unknown {
  return details === undefined ? { error } : { error, context: details }
}

export function createDiagnosticLogger(
  options: CreateDiagnosticLoggerOptions = {}
): DiagnosticLogger {
  const maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES)
  const maxTotalBytes = positiveInteger(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES)
  const maxEntryBytes = Math.min(
    positiveInteger(options.maxEntryBytes, DEFAULT_MAX_ENTRY_BYTES),
    maxTotalBytes
  )
  const maxDepth = positiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH)
  const maxNodes = positiveInteger(options.maxNodes, DEFAULT_MAX_NODES)
  const maxCollectionEntries = positiveInteger(
    options.maxCollectionEntries,
    DEFAULT_MAX_COLLECTION_ENTRIES
  )
  const now = options.now ?? Date.now
  const elapsedNow = options.elapsedNow ?? defaultElapsedNow
  const idGenerator = options.idGenerator ?? defaultIdGenerator
  const consoleTarget = options.console ?? console
  const runStartedAt = now()
  const runStartedElapsed = elapsedNow()
  const runId = idGenerator()

  let sequence = 0
  let entries: DiagnosticEntry[] = []
  let evictedCount = 0
  let totalBytes = 0
  let snapshot: DiagnosticSnapshot = Object.freeze({
    runId,
    runStartedAt,
    entries: Object.freeze([]),
    evictedCount,
    totalBytes
  })
  const listeners = new Set<() => void>()

  const publish = (): void => {
    snapshot = Object.freeze({
      runId,
      runStartedAt,
      entries: Object.freeze(entries.slice()),
      evictedCount,
      totalBytes
    })
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch {
        // A diagnostics observer must never break the operation being observed.
      }
    }
  }

  const record = (level: DiagnosticLevel, input: DiagnosticLogInput): DiagnosticEntry => {
    sequence += 1
    const normalized = normalizeDetails(input.details, {
      maxDepth,
      maxNodes,
      maxCollectionEntries,
      maxStringBytes: maxEntryBytes,
      maxMaterializationBytes: maxEntryBytes
    })
    const mutableEntry: MutableDiagnosticEntry = {
      sequence,
      timestamp: now(),
      elapsedMs: Math.max(0, elapsedNow() - runStartedElapsed),
      level,
      category: input.category,
      event: String(input.event),
      message: String(input.message),
      ...(input.operationId === undefined ? {} : { operationId: String(input.operationId) }),
      ...(input.parentOperationId === undefined
        ? {}
        : { parentOperationId: String(input.parentOperationId) }),
      ...(input.durationMs === undefined
        ? {}
        : { durationMs: Math.max(0, Number(input.durationMs)) }),
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
      detailsText: normalized.detailsText,
      truncated: normalized.truncated,
      sizeBytes: 0
    }
    fitEntryToLimit(mutableEntry, maxEntryBytes)
    const entry = freezeEntry(mutableEntry)

    entries.push(entry)
    totalBytes += entry.sizeBytes
    while (entries.length > maxEntries || totalBytes > maxTotalBytes) {
      const evicted = entries.shift()
      if (evicted === undefined) break
      totalBytes -= evicted.sizeBytes
      evictedCount += 1
    }

    try {
      consoleTarget[level](`[codey][${entry.category}][${entry.event}]`, entry)
    } catch {
      // Logging must remain observational even if a custom console sink fails.
    }
    publish()
    return entry
  }

  const logger: DiagnosticLogger = {
    debug: (input) => record('debug', input),
    info: (input) => record('info', input),
    warn: (input) => record('warn', input),
    error: (input) => record('error', input),
    operation: (input) => {
      const id = input.operationId ?? idGenerator()
      const startedAt = elapsedNow()
      let terminalEntry: DiagnosticEntry | undefined

      record('info', {
        ...input,
        event: `${input.event}.started`,
        operationId: id
      })

      const terminal = (
        level: Extract<DiagnosticLevel, 'info' | 'warn' | 'error'>,
        suffix: 'succeeded' | 'failed' | 'cancelled',
        outcome: DiagnosticOperationOutcomeInput | undefined,
        details: unknown
      ): DiagnosticEntry => {
        if (terminalEntry !== undefined) return terminalEntry
        terminalEntry = record(level, {
          category: input.category,
          event: outcome?.event ?? `${input.event}.${suffix}`,
          message: outcome?.message ?? `${input.message} ${suffix}`,
          operationId: id,
          ...(input.parentOperationId === undefined
            ? {}
            : { parentOperationId: input.parentOperationId }),
          durationMs: outcome?.durationMs ?? Math.max(0, elapsedNow() - startedAt),
          ...(details === undefined ? {} : { details })
        })
        return terminalEntry
      }

      const checkpoint = (
        checkpointInput: DiagnosticOperationCheckpointInput | string = {},
        message?: string,
        details?: unknown
      ): DiagnosticEntry | undefined => {
        if (terminalEntry !== undefined) return undefined
        const normalizedInput: DiagnosticOperationCheckpointInput =
          typeof checkpointInput === 'string'
            ? { event: checkpointInput, message, details }
            : checkpointInput
        return record(normalizedInput.level ?? 'debug', {
          category: input.category,
          event: normalizedInput.event ?? `${input.event}.checkpoint`,
          message: normalizedInput.message ?? `${input.message} checkpoint`,
          operationId: id,
          ...(input.parentOperationId === undefined
            ? {}
            : { parentOperationId: input.parentOperationId }),
          ...(normalizedInput.details === undefined
            ? {}
            : { details: normalizedInput.details })
        })
      }

      return Object.freeze({
        id,
        checkpoint,
        success: (outcome?: DiagnosticOperationOutcomeInput) =>
          terminal('info', 'succeeded', outcome, outcome?.details),
        failure: (error: unknown, outcome?: DiagnosticOperationOutcomeInput) =>
          terminal('error', 'failed', outcome, withFailureDetails(error, outcome?.details)),
        cancellation: (outcome?: DiagnosticOperationOutcomeInput) =>
          terminal('warn', 'cancelled', outcome, outcome?.details)
      })
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        listeners.delete(listener)
      }
    },
    clear: () => {
      entries = []
      evictedCount = 0
      totalBytes = 0
      publish()
    }
  }

  return Object.freeze(logger)
}

export const diagnosticLogger = createDiagnosticLogger()
