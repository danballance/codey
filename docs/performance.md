# Android input-to-paint performance

This document defines the repeatable benchmark for the Android client. The
primary device is the OPD2514 tablet running Android 16 (API 36), with a
physical display of 2400 × 3392 pixels at 420 dpi. Performance diagnostics are
off unless explicitly enabled and retain only a bounded set of timing records.

## Builds

Use the same source revision for both builds. The development client includes
Metro and development instrumentation:

```sh
pnpm android:install
pnpm android:metro
```

The local release command bundles JavaScript and Hermes into the APK and does
not depend on Metro while it is running:

```sh
pnpm android:install:release
```

This locally generated release uses the repository's normal local Android
signing configuration and is intended for benchmarking, not store delivery.

To opt into diagnostics, set the public build-time flag before starting Metro
or building/installing the APK:

```sh
EXPO_PUBLIC_CODEY_PERF=1 pnpm android:metro
EXPO_PUBLIC_CODEY_PERF=1 pnpm android:install:release
```

Records are kept in a 1,024-entry in-memory ring and are also written with the
`[codey-perf]` prefix. Their metadata schema contains lengths, sources, timing
correlation, connection generation, flush counts, resize state, and build
type. It has no field for input text, raw keys, MessagePack payloads, or other
typed content. A typical capture command is:

```sh
adb logcat -c
adb logcat -v monotonic ReactNativeJS:I '*:S'
```

Filter the captured output for `[codey-perf]` after the run. Perfetto sections
are named `Codey/IME/*`, `Codey/TCP/*`, `Codey/redraw`, and
`Codey.GridPicture.record`; they cover IME dispatch, socket reads/writes,
redraw work, and Skia picture recording.

Diagnostics allocate a process-local `sampleId` at each input receipt. The
controller deterministically assigns every outstanding sample to the next
Neovim `flush`, carries all assigned samples across animation-frame coalescing,
and emits `key_to_visible` once per sample at the committed Skia layout. It
also labels samples dropped by the bounded queue, left unmatched at close, or
canceled before publication. Neovim's RPC protocol does not echo the input
sample ID, so inbound socket/framing/decode records remain connection- and
time-window-correlated; do not invent a stronger causal link for those stages.
When diagnostics are enabled, TCP uses the separate measured native write path
to report IO-queue, write-lock, and socket-write durations. Normal builds keep
the clock-free native `write` fast path.

## Baseline recorded before the changes

The following snapshot was read from the attached tablet on 2026-08-22. It is
the warmed, already-running development client rather than a freshly reset
scenario: Android reported two active `ViewRootImpl` instances. Preserve it as
the historical starting point, but use the reset procedure below for an
apples-to-apples before/after comparison.

| Item | Baseline |
| --- | ---: |
| Neovim grid | 125 × 25 |
| TCP round-trip time | approximately 4–24 ms |
| Android frame p50 / p95 / p99 | 7 / 19 / 34 ms |
| Frames rendered | 703 |
| Janky frames | 64 (9.10%) |
| High-input-latency events | 312 (44.38% of rendered frames) |
| Slow UI-thread frames | 44 |
| Total PSS / RSS | 748,175 / 920,640 KB |
| Native heap PSS | 313,218 KB |
| Graphics PSS | 180,720 KB |
| Skia pipeline | Vulkan |

The earlier native-frame summary was approximately 20 ms p95, consistent with
the 19 ms `gfxinfo` snapshot above. Key-to-visible percentiles were not
available before opt-in correlation records existed, so they must not be
invented retroactively.

## Repeatable procedure

1. Use a trusted, low-contention LAN. Record the source revision, build type,
   tablet Android build, Gboard version, Neovim version, configuration revision,
   grid size, and measured TCP RTT.
2. Test both `nvim --clean` and the configured Neovim environment. In each,
   test a plain insert buffer and `:terminal`.
3. Force-stop and reopen Codey, connect, focus the editor, then warm the app for
   30 seconds without collecting samples.
4. Reset Android frame counters and clear logs immediately before each run:

   ```sh
   adb shell dumpsys gfxinfo dev.codey.android reset
   adb logcat -c
   ```

5. At the actual 125 × 25 grid, collect at least 100 printable inserts, 100
   cursor movements, and 20 scroll actions for each of Gboard, a hardware
   keyboard, and the Action Pad. Exercise steady 5 Hz input and a 20 Hz burst.
6. Repeat the first key after editor focus and while a keyboard-driven resize
   is in flight. Repeat once with a larger stress grid.
7. Capture the diagnostic log and a Perfetto trace. Then capture Android
   counters and memory:

   ```sh
   adb shell dumpsys gfxinfo dev.codey.android
   adb shell dumpsys meminfo dev.codey.android
   ```

8. Run 1,000 redraws, capture warmed memory again, and report PSS growth rather
   than comparing unrelated cold/warm snapshots.

For each source, correlate receipt, native-to-JS delivery, controller entry,
transport queue/start/completion, native socket write/read, framing/decode,
redraw validation/reduction/publication, picture creation, and React layout
commit. Report missing correlations and any maximum near one second as defects,
not as discarded outliers.

## Result matrix

Fill one row for every scenario; keep application time separate from host
mapping waits.

| Build | Neovim | Surface | Source | p50 | p95 | max | redraw→commit p95 | jank | high input |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Development | clean | buffer | Gboard | pending | pending | pending | pending | pending | pending |
| Development | configured | terminal | Gboard | pending | pending | pending | pending | pending | pending |
| Release | clean | buffer | Gboard | pending | pending | pending | pending | pending | pending |
| Release | configured | terminal | Action Pad | pending | pending | pending | pending | pending | pending |
| Release | configured | terminal | hardware | pending | pending | pending | pending | pending | pending |

Neovim mapping-prefix waits, including waits governed by `timeoutlen`, are host
behavior. Measure host receipt separately, label those samples as mapping
delays, and do not attribute them to the Android input or rendering path.

## Acceptance gates

- Ordinary unmapped release input: key-to-visible p50 at most 50 ms, p95 at
  most 100 ms, and maximum at most 250 ms.
- Development client: key-to-visible p95 at most 150 ms and no unexplained
  near-one-second stalls.
- Redraw receipt to publication/commit: p95 at most 8 ms for ordinary frames
  and 16 ms for full-grid frames.
- Cursor/mode-only work: at most 2 ms and no grid-picture recording.
- Janky frames below 5%; high-input-latency events below 2%.
- No linear memory growth and less than 50 MB warmed PSS growth after 1,000
  redraws.

The row-picture/damage-metadata contingency is intentionally inactive. Enable
it only if a post-optimization device trace shows full-grid redraw receipt to
commit above 16 ms p95 and picture recording is the dominant stage. A source
inspection or an unmeasured development build is not sufficient evidence for
changing the shared redraw result types.
