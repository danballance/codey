export type PerformanceBuild = "development" | "release";

export type PerformanceInputSource =
  | "ime"
  | "hardware"
  | "action-pad"
  | "rpc"
  | "redraw"
  | "renderer";

/**
 * Deliberately closed metadata schema. In particular, there is no text, keys,
 * payload, or content field, so diagnostics cannot accidentally retain input.
 */
export interface PerformanceTags {
  readonly source?: PerformanceInputSource;
  readonly sampleId?: number;
  readonly inputStartedAtMs?: number;
  readonly inputLength?: number;
  readonly byteLength?: number;
  readonly connectionGeneration?: number;
  readonly flushCount?: number;
  readonly firstKeyAfterFocus?: boolean;
  readonly resizeInFlight?: boolean;
  readonly build?: PerformanceBuild;
  readonly sequence?: number;
  readonly eventCount?: number;
  readonly segmentCount?: number;
  readonly gridWidth?: number;
  readonly gridHeight?: number;
  readonly visibleColumns?: number;
  readonly visibleRows?: number;
  readonly scannedBytes?: number;
  readonly copiedBytes?: number;
  readonly didFlush?: boolean;
  readonly pictureChanged?: boolean;
}

export interface PerformanceInputSample {
  readonly sampleId: number;
  readonly inputStartedAtMs: number;
}

export interface PerformanceRecord {
  readonly sequence: number;
  readonly stage: string;
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly tags: Readonly<PerformanceTags>;
}

export interface PerformanceDiagnosticsOptions {
  readonly enabled: boolean;
  readonly capacity?: number;
  readonly build?: PerformanceBuild;
  readonly log?: boolean;
}

interface RecordOptions {
  readonly startedAtMs?: number;
  readonly durationMs?: number;
  readonly tags?: PerformanceTags;
}

const DEFAULT_CAPACITY = 512;
const MINIMUM_CAPACITY = 16;
const MAXIMUM_CAPACITY = 4_096;

const environment = (
  globalThis as typeof globalThis & {
    readonly process?: { readonly env?: Record<string, string | undefined> };
  }
).process?.env;

let enabled = environment?.EXPO_PUBLIC_CODEY_PERF === "1";
let shouldLog = enabled;
let capacity = DEFAULT_CAPACITY;
let build: PerformanceBuild | undefined;
let nextSequence = 1;
let nextInputSampleId = 1;
let records: PerformanceRecord[] = [];
let context: PerformanceTags = {};

export function configurePerformanceDiagnostics(
  options: PerformanceDiagnosticsOptions,
): void {
  enabled = options.enabled;
  shouldLog = options.log ?? options.enabled;
  capacity = clampCapacity(options.capacity ?? DEFAULT_CAPACITY);
  build = options.build;
  if (!enabled) {
    records = [];
    context = {};
  } else if (records.length > capacity) {
    records = records.slice(records.length - capacity);
  }
}

export function performanceDiagnosticsEnabled(): boolean {
  return enabled;
}

export function performanceNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

/** Allocate one process-local identity for correlating an input through paint. */
export function createPerformanceInputSample(
  inputStartedAtMs?: number,
): PerformanceInputSample {
  const sample = Object.freeze({
    sampleId: nextInputSampleId,
    inputStartedAtMs:
      finiteNonNegative(inputStartedAtMs) ?? performanceNow(),
  });
  nextInputSampleId += 1;
  return sample;
}

export function currentPerformanceTags(): Readonly<PerformanceTags> {
  return context;
}

/**
 * Propagates correlation tags through the synchronous portion of a call. A
 * transport can capture the tags before its asynchronous write queue starts.
 */
export function withPerformanceTags<T>(
  tags: PerformanceTags,
  operation: () => T,
): T {
  if (!enabled) return operation();
  const previous = context;
  context = mergeTags(previous, tags);
  try {
    return operation();
  } finally {
    context = previous;
  }
}

export function recordPerformance(
  stage: string,
  options: RecordOptions = {},
): void {
  if (!enabled) return;
  const now = performanceNow();
  const startedAtMs = finiteNonNegative(options.startedAtMs) ?? now;
  const durationMs =
    finiteNonNegative(options.durationMs) ?? Math.max(0, now - startedAtMs);
  const tags = Object.freeze(
    mergeTags(context, build === undefined ? options.tags : { build, ...options.tags }),
  );
  const record = Object.freeze({
    sequence: nextSequence++,
    stage,
    startedAtMs,
    durationMs,
    tags,
  });

  records.push(record);
  if (records.length > capacity) {
    records.splice(0, records.length - capacity);
  }
  if (shouldLog) {
    // The closed tag schema above guarantees this line never logs typed text.
    console.info(`[codey-perf] ${JSON.stringify(record)}`);
  }
}

export function beginPerformance(
  stage: string,
  tags?: PerformanceTags,
): () => void {
  if (!enabled) return () => undefined;
  const startedAtMs = performanceNow();
  const capturedTags = mergeTags(context, tags);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    recordPerformance(stage, { startedAtMs, tags: capturedTags });
  };
}

export function getPerformanceRecords(): readonly PerformanceRecord[] {
  return records.slice();
}

export function clearPerformanceRecords(): void {
  records = [];
  nextSequence = 1;
}

function mergeTags(
  left: PerformanceTags,
  right: PerformanceTags | undefined,
): PerformanceTags {
  if (right === undefined) return { ...left };
  return { ...left, ...right };
}

function clampCapacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CAPACITY;
  return Math.min(MAXIMUM_CAPACITY, Math.max(MINIMUM_CAPACITY, Math.trunc(value)));
}

function finiteNonNegative(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
