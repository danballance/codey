const fallbackOrigins = new WeakMap<object, string>()

/** Marks an error at its first diagnostic origin without overwriting an earlier layer. */
export function markDiagnosticOrigin(reason: unknown, origin: string): void {
  if (!isObject(reason) || diagnosticOriginOf(reason) !== undefined) return
  try {
    Object.defineProperty(reason, 'codeyDiagnosticOrigin', {
      configurable: true,
      enumerable: false,
      value: origin
    })
  } catch {
    fallbackOrigins.set(reason, origin)
  }
}

/** Finds an origin on an error or any of its causes, guarding cycles and hostile values. */
export function diagnosticOriginOf(reason: unknown): string | undefined {
  const visited = new Set<object>()
  let current: unknown = reason
  while (isObject(current) && !visited.has(current)) {
    visited.add(current)
    const direct = directOriginOf(current)
    if (direct !== undefined) return direct
    try {
      current = (current as { readonly cause?: unknown }).cause
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Retains a non-Error native value as a cause when adapting it to an Error. */
export function attachDiagnosticCause<T extends Error>(error: T, cause: unknown): T {
  if (cause === error || cause === undefined) return error
  try {
    Object.defineProperty(error, 'cause', {
      configurable: true,
      enumerable: false,
      value: cause
    })
  } catch {
    // Cause retention is best-effort and must not hide the operational failure.
  }
  return error
}

function directOriginOf(value: object): string | undefined {
  const fallback = fallbackOrigins.get(value)
  if (fallback !== undefined) return fallback
  try {
    const origin = (value as { readonly codeyDiagnosticOrigin?: unknown }).codeyDiagnosticOrigin
    return typeof origin === 'string' && origin.length > 0 ? origin : undefined
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}
