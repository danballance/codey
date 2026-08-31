import {
  createDiagnosticLogger,
  diagnosticUtf8ByteLength,
  type DiagnosticConsole,
  type DiagnosticLogger
} from '../logger'

function createConsole(): jest.Mocked<DiagnosticConsole> {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}

describe('diagnostic logger', () => {
  it('orders all levels, publishes stable snapshots, and mirrors each entry exactly once', () => {
    const consoleTarget = createConsole()
    let wallTime = 1_700_000_000_000
    let elapsedTime = 500
    const logger = createDiagnosticLogger({
      console: consoleTarget,
      now: () => wallTime,
      elapsedNow: () => elapsedTime,
      idGenerator: () => 'run-id'
    })
    const initial = logger.getSnapshot()

    wallTime += 5
    elapsedTime += 5
    const debug = logger.debug({
      category: 'app',
      event: 'app.debugged',
      message: 'debug message',
      details: { ok: true }
    })
    const afterDebug = logger.getSnapshot()
    expect(logger.getSnapshot()).toBe(afterDebug)
    expect(afterDebug).not.toBe(initial)

    const info = logger.info({
      category: 'settings',
      event: 'settings.loaded',
      message: 'settings loaded'
    })
    const warning = logger.warn({
      category: 'workspace',
      event: 'workspace.fallback',
      message: 'using root'
    })
    const error = logger.error({
      category: 'transport',
      event: 'transport.failed',
      message: 'transport failed'
    })

    expect(logger.getSnapshot().entries).toEqual([debug, info, warning, error])
    expect(logger.getSnapshot().entries.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4])
    expect(logger.getSnapshot().entries.map((entry) => entry.level)).toEqual([
      'debug',
      'info',
      'warn',
      'error'
    ])
    expect(debug.timestamp).toBe(wallTime)
    expect(debug.elapsedMs).toBe(5)
    expect(debug.detailsText).toBe('{\n  "ok": true\n}')
    expect(debug.sizeBytes).toBe(diagnosticUtf8ByteLength(JSON.stringify(debug)))

    expect(consoleTarget.debug.mock.calls).toEqual([
      ['[codey][app][app.debugged]', debug]
    ])
    expect(consoleTarget.info.mock.calls).toEqual([
      ['[codey][settings][settings.loaded]', info]
    ])
    expect(consoleTarget.warn.mock.calls).toEqual([
      ['[codey][workspace][workspace.fallback]', warning]
    ])
    expect(consoleTarget.error.mock.calls).toEqual([
      ['[codey][transport][transport.failed]', error]
    ])
    expect(Object.isFrozen(debug)).toBe(true)
    expect(Object.isFrozen(logger.getSnapshot())).toBe(true)
    expect(Object.isFrozen(logger.getSnapshot().entries)).toBe(true)
  })

  it('snapshots arbitrary details immediately, immutably, and without redaction', () => {
    const consoleTarget = createConsole()
    const logger = createDiagnosticLogger({
      console: consoleTarget,
      now: () => 10,
      elapsedNow: () => 20,
      idGenerator: () => 'run'
    })
    const cause = new Error('root cause')
    const failure = new Error('top secret /storage/emulated/0/project')
    ;(failure as Error & { cause: unknown }).cause = cause
    ;(failure as Error & { status: number }).status = 503
    const details: Record<string, unknown> = {
      path: '/storage/emulated/0/project',
      unset: undefined,
      huge: 12n,
      badNumber: Number.NaN,
      bytes: new Uint8Array([0, 127, 255]),
      map: new Map<unknown, unknown>([['key', { nested: true }]]),
      failure
    }
    details.self = details

    const entry = logger.error({
      category: 'workspace',
      event: 'workspace.list.failed',
      message: 'listing failed',
      details
    })
    details.path = '/changed'
    ;(details.map as Map<unknown, unknown>).set('later', false)

    expect(entry.detailsText).toContain('/storage/emulated/0/project')
    expect(entry.detailsText).not.toContain('/changed')
    expect(entry.detailsText).toContain('[Circular -> $]')
    expect(entry.detailsText).toContain('root cause')
    expect(entry.detailsText).toContain('503')
    expect(entry.detailsText).toContain('Uint8Array')
    expect(entry.detailsText).toContain('255')
    expect(entry.detailsText).toContain('12n')
    expect(entry.detailsText).toContain('[NaN]')
    expect(Object.isFrozen(entry.details)).toBe(true)
  })

  it('emits one start, checkpoints, and one idempotent terminal operation outcome', () => {
    const consoleTarget = createConsole()
    let elapsed = 100
    const ids = ['run', 'operation-7']
    const logger = createDiagnosticLogger({
      console: consoleTarget,
      now: () => 1_000,
      elapsedNow: () => elapsed,
      idGenerator: () => ids.shift() ?? 'unexpected'
    })

    const operation = logger.operation({
      category: 'connection',
      event: 'connection.open',
      message: 'Open connection',
      parentOperationId: 'parent-1',
      details: { target: 'local' }
    })
    elapsed = 125
    operation.checkpoint('transport.opened', 'Transport opened', { port: 7777 })
    elapsed = 160
    const terminal = operation.success({ details: { channel: 1 } })
    expect(operation.success({ message: 'must not replace terminal' })).toBe(terminal)
    expect(operation.failure(new Error('late failure'))).toBe(terminal)
    expect(operation.checkpoint({ message: 'late checkpoint' })).toBeUndefined()

    const entries = logger.getSnapshot().entries
    expect(entries).toHaveLength(3)
    expect(entries.map((entry) => entry.event)).toEqual([
      'connection.open.started',
      'transport.opened',
      'connection.open.succeeded'
    ])
    expect(entries.map((entry) => entry.operationId)).toEqual([
      'operation-7',
      'operation-7',
      'operation-7'
    ])
    expect(entries.every((entry) => entry.parentOperationId === 'parent-1')).toBe(true)
    expect(terminal.durationMs).toBe(60)
    expect(consoleTarget.info).toHaveBeenCalledTimes(2)
    expect(consoleTarget.debug).toHaveBeenCalledTimes(1)
    expect(consoleTarget.error).not.toHaveBeenCalled()
  })

  it('captures failure context and uses warning for cancellation', () => {
    const consoleTarget = createConsole()
    let id = 0
    const logger = createDiagnosticLogger({
      console: consoleTarget,
      now: () => 1,
      elapsedNow: () => 1,
      idGenerator: () => `id-${id++}`
    })

    const failed = logger
      .operation({ category: 'rpc', event: 'rpc.attach', message: 'Attach RPC' })
      .failure(new Error('bad response'), { details: { request: 4 } })
    const cancelled = logger
      .operation({ category: 'ime', event: 'ime.settle', message: 'Settle IME' })
      .cancellation()

    expect(failed.level).toBe('error')
    expect(failed.detailsText).toContain('bad response')
    expect(failed.detailsText).toContain('request')
    expect(cancelled.level).toBe('warn')
    expect(cancelled.event).toBe('ime.settle.cancelled')
  })

  it('notifies subscribers and clears without resetting run identity or sequence', () => {
    const consoleTarget = createConsole()
    const logger = createDiagnosticLogger({
      console: consoleTarget,
      now: () => 123,
      elapsedNow: () => 456,
      idGenerator: () => 'persistent-run'
    })
    const listener = jest.fn()
    const unsubscribe = logger.subscribe(listener)
    const first = logger.info({ category: 'app', event: 'first', message: 'first' })
    const runId = logger.getSnapshot().runId
    const runStartedAt = logger.getSnapshot().runStartedAt

    logger.clear()
    expect(logger.getSnapshot()).toMatchObject({
      runId,
      runStartedAt,
      entries: [],
      evictedCount: 0,
      totalBytes: 0
    })
    expect(consoleTarget.info).toHaveBeenCalledTimes(1)

    const second = logger.info({ category: 'app', event: 'second', message: 'second' })
    expect(second.sequence).toBe(first.sequence + 1)
    expect(listener).toHaveBeenCalledTimes(3)
    unsubscribe()
    unsubscribe()
    logger.info({ category: 'app', event: 'third', message: 'third' })
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('enforces entry-count and exact UTF-8 total-byte limits by evicting oldest entries', () => {
    const consoleTarget = createConsole()
    const logger = createDiagnosticLogger({
      console: consoleTarget,
      maxEntries: 3,
      maxTotalBytes: 700,
      maxEntryBytes: 500,
      now: () => 1,
      elapsedNow: () => 1,
      idGenerator: () => 'run'
    })

    for (let index = 0; index < 8; index += 1) {
      logger.info({
        category: 'workspace',
        event: `workspace.entry.${index}`,
        message: `Directory ${index} \ud83d\ude80`,
        details: { path: `/storage/emulated/0/${index}` }
      })
    }

    const snapshot = logger.getSnapshot()
    const measuredTotal = snapshot.entries.reduce(
      (total, entry) => total + diagnosticUtf8ByteLength(JSON.stringify(entry)),
      0
    )
    expect(snapshot.entries.length).toBeLessThanOrEqual(3)
    expect(snapshot.totalBytes).toBe(measuredTotal)
    expect(snapshot.totalBytes).toBeLessThanOrEqual(700)
    expect(snapshot.evictedCount).toBe(8 - snapshot.entries.length)
    expect(snapshot.entries.at(-1)?.event).toBe('workspace.entry.7')
  })

  it('bounds oversized entries and exposes truncation from size, depth, and collection limits', () => {
    const consoleTarget = createConsole()
    const logger = createDiagnosticLogger({
      console: consoleTarget,
      maxEntryBytes: 600,
      maxTotalBytes: 2_000,
      maxDepth: 2,
      maxCollectionEntries: 3,
      now: () => 1,
      elapsedNow: () => 1,
      idGenerator: () => 'run'
    })
    const entry = logger.info({
      category: 'workspace',
      event: 'workspace.list.succeeded',
      message: 'Returned a large raw listing',
      details: {
        listing: Array.from({ length: 20 }, (_, index) => ({
          name: `entry-${index}`,
          document: 'x'.repeat(2_000)
        }))
      }
    })

    expect(entry.truncated).toBe(true)
    expect(entry.sizeBytes).toBe(diagnosticUtf8ByteLength(JSON.stringify(entry)))
    expect(entry.sizeBytes).toBeLessThanOrEqual(600)
    expect(consoleTarget.info).toHaveBeenCalledTimes(1)
  })

  it('retains details that fit near the configured entry limit', () => {
    const logger = createDiagnosticLogger({
      console: createConsole(),
      maxEntryBytes: 48 * 1_024,
      maxTotalBytes: 96 * 1_024,
      now: () => 1,
      elapsedNow: () => 1,
      idGenerator: () => 'run'
    })
    const document = 'x'.repeat(18 * 1_024)

    const entry = logger.info({
      category: 'action-pad',
      event: 'action_pad.document.loaded',
      message: 'Retained a bounded source document',
      details: { document }
    })

    expect(entry.truncated).toBe(false)
    expect(entry.details).toEqual({ document })
    expect(entry.sizeBytes).toBeLessThanOrEqual(48 * 1_024)
  })

  it('reads only a bounded prefix of an extremely wide object', () => {
    const logger = createDiagnosticLogger({
      console: createConsole(),
      maxCollectionEntries: 3,
      now: () => 1,
      elapsedNow: () => 1,
      idGenerator: () => 'run'
    })
    const reads: string[] = []
    const details: Record<string, unknown> = {}
    for (let index = 0; index < 100; index += 1) {
      Object.defineProperty(details, `key-${index}`, {
        enumerable: true,
        get: () => {
          reads.push(`key-${index}`)
          return index
        }
      })
    }

    const entry = logger.info({
      category: 'app',
      event: 'app.wide_details',
      message: 'Captured a wide object',
      details
    })

    expect(reads).toEqual(['key-0', 'key-1', 'key-2'])
    expect(entry.truncated).toBe(true)
    expect(entry.details).toMatchObject({ $truncatedProperties: 1 })
  })

  it('bounds a large repeated graph at the final entry-size fit', () => {
    const consoleTarget = createConsole()
    const logger = createDiagnosticLogger({
      console: consoleTarget,
      maxEntryBytes: 64 * 1_024,
      maxTotalBytes: 128 * 1_024,
      maxNodes: 100_000,
      maxCollectionEntries: 10_000,
      now: () => 1,
      elapsedNow: () => 1,
      idGenerator: () => 'run'
    })
    const shared = Object.freeze({
      name: 'large-document',
      text: 'x'.repeat(256 * 1_024)
    })
    const details = {
      listing: Array.from({ length: 2_000 }, () => shared)
    }

    const entry = logger.info({
      category: 'workspace',
      event: 'workspace.large_listing',
      message: 'Captured a large repeated listing',
      details
    })

    expect(entry.truncated).toBe(true)
    expect(entry.detailsText.length).toBeLessThan(32 * 1_024)
    expect(entry.detailsText).toContain('[truncated]')
    expect(entry.details).toMatchObject({ $truncated: true })
    expect(entry.sizeBytes).toBe(diagnosticUtf8ByteLength(JSON.stringify(entry)))
    expect(entry.sizeBytes).toBeLessThanOrEqual(64 * 1_024)
    expect(consoleTarget.info.mock.calls).toEqual([
      ['[codey][workspace][workspace.large_listing]', entry]
    ])
  })

  it('turns hostile getters, proxies, and iterators into bounded details instead of throwing', () => {
    const consoleTarget = createConsole()
    const logger = createDiagnosticLogger({
      console: consoleTarget,
      maxEntryBytes: 16 * 1_024,
      maxTotalBytes: 64 * 1_024,
      now: () => 1,
      elapsedNow: () => 1,
      idGenerator: () => 'run'
    })
    const hostileError = new Error('native failure')
    Object.defineProperty(hostileError, 'stack', {
      configurable: true,
      get: () => {
        throw new Error('stack getter exploded')
      }
    })
    const hostileProxy = new Proxy({}, {
      getPrototypeOf: () => {
        throw new Error('prototype lookup exploded')
      }
    })
    const hostileMap = new Map<string, string>()
    Object.defineProperty(hostileMap, Symbol.iterator, {
      value: () => {
        throw new Error('map iterator exploded')
      }
    })

    let getterEntry!: ReturnType<DiagnosticLogger['error']>
    let proxyEntry!: ReturnType<DiagnosticLogger['warn']>
    let iteratorEntry!: ReturnType<DiagnosticLogger['info']>
    expect(() => {
      getterEntry = logger.error({
        category: 'nvim',
        event: 'nvim.hostile_error',
        message: 'Captured hostile error',
        details: hostileError
      })
      proxyEntry = logger.warn({
        category: 'rpc',
        event: 'rpc.hostile_proxy',
        message: 'Captured hostile proxy',
        details: hostileProxy
      })
      iteratorEntry = logger.info({
        category: 'workspace',
        event: 'workspace.hostile_iterator',
        message: 'Captured hostile iterator',
        details: hostileMap
      })
    }).not.toThrow()

    expect(getterEntry.truncated).toBe(true)
    expect(getterEntry.detailsText).toContain('stack getter exploded')
    expect(proxyEntry.truncated).toBe(true)
    expect(proxyEntry.detailsText).toContain('prototype lookup exploded')
    expect(iteratorEntry.truncated).toBe(true)
    expect(iteratorEntry.detailsText).toContain('map iterator exploded')
    expect(consoleTarget.error).toHaveBeenCalledTimes(1)
    expect(consoleTarget.warn).toHaveBeenCalledTimes(1)
    expect(consoleTarget.info).toHaveBeenCalledTimes(1)
  })

  it('safely snapshots a detached ArrayBuffer when the runtime supports transfer', () => {
    const clone = (globalThis as typeof globalThis & {
      structuredClone?: (value: unknown, options?: { transfer?: object[] }) => unknown
    }).structuredClone
    if (clone === undefined) return

    const consoleTarget = createConsole()
    const logger = createDiagnosticLogger({
      console: consoleTarget,
      now: () => 1,
      elapsedNow: () => 1,
      idGenerator: () => 'run'
    })
    const buffer = new ArrayBuffer(16)
    clone(buffer, { transfer: [buffer] })

    let entry!: ReturnType<DiagnosticLogger['debug']>
    expect(() => {
      entry = logger.debug({
        category: 'transport',
        event: 'transport.detached_bytes',
        message: 'Captured detached bytes',
        details: buffer
      })
    }).not.toThrow()

    expect(entry.detailsText).toMatch(/ArrayBuffer|\$normalizationError/)
    expect(consoleTarget.debug.mock.calls).toEqual([
      ['[codey][transport][transport.detached_bytes]', entry]
    ])
  })

  it('validates retention and normalization limits', () => {
    expect(() => createDiagnosticLogger({ maxEntries: 0 })).toThrow(RangeError)
    expect(() => createDiagnosticLogger({ maxTotalBytes: Number.NaN })).toThrow(RangeError)
    expect(() => createDiagnosticLogger({ maxDepth: -1 })).toThrow(RangeError)
  })
})
