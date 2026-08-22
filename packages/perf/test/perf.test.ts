import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beginPerformance,
  clearPerformanceRecords,
  configurePerformanceDiagnostics,
  createPerformanceInputSample,
  getPerformanceRecords,
  recordPerformance,
  withPerformanceTags,
} from "../src/index.js";

afterEach(() => {
  configurePerformanceDiagnostics({ enabled: false });
  clearPerformanceRecords();
  vi.restoreAllMocks();
});

describe("performance diagnostics", () => {
  it("allocates monotonic input sample identities on the performance clock", () => {
    const first = createPerformanceInputSample(123.5);
    const second = createPerformanceInputSample();
    const fallback = createPerformanceInputSample(Number.NaN);

    expect(second.sampleId).toBe(first.sampleId + 1);
    expect(fallback.sampleId).toBe(second.sampleId + 1);
    expect(first.inputStartedAtMs).toBe(123.5);
    expect(Number.isFinite(second.inputStartedAtMs)).toBe(true);
    expect(Number.isFinite(fallback.inputStartedAtMs)).toBe(true);
  });

  it("is bounded and combines correlation tags without input content", () => {
    configurePerformanceDiagnostics({
      enabled: true,
      capacity: 16,
      build: "release",
      log: false,
    });

    withPerformanceTags({ source: "ime", inputLength: 1 }, () => {
      for (let index = 0; index < 20; index += 1) {
        recordPerformance("controller_input", {
          durationMs: index,
          tags: { connectionGeneration: 3 },
        });
      }
    });

    const records = getPerformanceRecords();
    expect(records).toHaveLength(16);
    expect(records[0]?.sequence).toBe(5);
    expect(records.at(-1)?.tags).toEqual({
      source: "ime",
      inputLength: 1,
      connectionGeneration: 3,
      build: "release",
    });
    expect(JSON.stringify(records)).not.toContain("text");
  });

  it("does not retain or log anything while disabled", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    configurePerformanceDiagnostics({ enabled: false });
    recordPerformance("ignored", { durationMs: 10 });
    beginPerformance("ignored")();

    expect(getPerformanceRecords()).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });
});
