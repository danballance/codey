# Android input-to-paint performance

This document defines the repeatable performance benchmark for Codey's only
runtime path: the Android UI controlling its bundled `nvim --embed` process
over stdin/stdout. Network conditions are not a benchmark variable.

The primary reference device is the OPD2514 tablet running Android 16 (API 36),
with a physical display of 2400 x 3392 pixels at 420 dpi. Record the actual
device and software versions for every run; the supported runtime floor remains
Android 11 / API 30 on `arm64-v8a`.

## Builds

Install the development client, which prepares the bundled runtime and performs
a clean development prebuild, then start Metro:

```sh
pnpm android:install
pnpm android:metro
```

The development client uses Metro. TypeScript-only changes can reuse the
installed client; native configuration, Kotlin, or native-library changes need
another clean prebuild and reinstall.

Build the standalone release APK with bundled JavaScript, Hermes, and Neovim:

```sh
pnpm android:apk
adb install -r apps/android/android/app/build/outputs/apk/release/app-release.apk
```

The release APK does not need Metro while it runs. Its default local signing is
suitable for device testing, not public distribution.

## Opt-in diagnostics

Performance diagnostics are disabled by default. Enable them when starting
Metro or building the standalone APK:

```sh
EXPO_PUBLIC_CODEY_PERF=1 pnpm android:metro
EXPO_PUBLIC_CODEY_PERF=1 pnpm android:apk
```

Records are kept in a 1,024-entry in-memory ring and logged with the
`[codey-perf]` prefix. The closed metadata schema contains timing IDs, lengths,
input sources, connection generations, flush counts, resize state, dimensions,
and build type. It has no field for typed text, raw keys, RPC payloads, file
contents, or Action Pad commands.

Capture the JavaScript records with:

```sh
adb logcat -c
adb logcat -v monotonic ReactNativeJS:I '*:S'
```

Filter the result for `[codey-perf]`. Relevant records include input receipt,
native-to-JavaScript delivery, controller input, input-to-redraw,
redraw reduction and processing, snapshot publication, picture creation,
renderer layout commit, and key-to-visible. A process-local `sampleId` follows
each input to the next Neovim `flush` and committed Skia layout. Neovim does not
echo that ID, so the correlation assumes the next observed flush contains the
outstanding input; report ambiguous or missing correlations.

Perfetto sections currently cover `Codey/IME/*`, `Codey/redraw`, and
`Codey.GridPicture.record`. The local process transport does not yet expose
separate measured stdin-write or stdout-read stages. Treat input-to-redraw as
an aggregate across RPC encoding, the Expo native bridge, stdio, Neovim, and
RPC decoding; do not invent finer-grained timings from it.

## Benchmark procedure

1. Record the source revision, build type, device model, Android build, input
   method version, Neovim version, config revision, Action Pad revision, grid
   size, and display refresh rate.
2. Run both startup profiles: a config directory without `init.lua` (clean) and
   a trusted configured directory. In each profile, test an insert buffer and
   `:terminal`.
3. Force-stop and reopen Codey. Select the workspace and config directories,
   start Neovim, focus the editor, and warm the app for 30 seconds without collecting
   samples.
4. Reset Android frame counters and logs immediately before each run:

   ```sh
   adb shell dumpsys gfxinfo dev.codey.android reset
   adb logcat -c
   ```

5. At the normal 125 x 25 grid, collect at least 100 printable inserts, 100
   cursor movements, and 20 scroll actions for each of Gboard, a hardware
   keyboard, and the Action Pad. Exercise steady 5 Hz input and a 20 Hz burst.
6. Repeat the first key after editor focus and input during a keyboard-driven
   resize. Repeat once with a larger stress grid.
7. Capture the diagnostics log and a Perfetto trace, then collect Android frame
   and memory counters:

   ```sh
   adb shell dumpsys gfxinfo dev.codey.android
   adb shell dumpsys meminfo dev.codey.android
   ```

8. Run 1,000 redraws, capture warmed memory again, and report PSS growth from
   the warmed baseline rather than comparing unrelated cold and warm samples.
9. Repeat each scenario at least three times. Report the median run and retain
   every run so variability remains visible.

For each input source, correlate the available receipt, native-to-JavaScript,
controller, redraw, publication, picture, and layout stages. Label missing
local-transport instrumentation as unavailable. Treat any maximum near one
second as a defect to investigate, not an outlier to discard.

## Results

Fill one row for every scenario:

| Build | Neovim | Surface | Source | p50 | p95 | max | redraw-to-commit p95 | jank | high input |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Development | clean | buffer | Gboard | pending | pending | pending | pending | pending | pending |
| Development | configured | terminal | Gboard | pending | pending | pending | pending | pending | pending |
| Release | clean | buffer | Gboard | pending | pending | pending | pending | pending | pending |
| Release | configured | terminal | Action Pad | pending | pending | pending | pending | pending | pending |
| Release | configured | terminal | hardware | pending | pending | pending | pending | pending | pending |

Neovim mapping-prefix waits, including `timeoutlen`, remain Neovim behavior.
Record the active mappings and label those samples as mapping delays instead of
attributing them to Android rendering.

The old development snapshot measured a different connection architecture and
is not a baseline for the bundled runtime. Establish a fresh local-stdio
baseline with this procedure before evaluating regressions.

## Acceptance gates

- Ordinary unmapped release input: key-to-visible p50 at most 50 ms, p95 at
  most 100 ms, and maximum at most 250 ms.
- Development client: key-to-visible p95 at most 150 ms and no unexplained
  near-one-second stalls.
- Redraw receipt to publication/commit: p95 at most 8 ms for ordinary frames
  and 16 ms for full-grid frames.
- Cursor- or mode-only work: at most 2 ms and no grid-picture recording.
- Janky frames below 5%; high-input-latency events below 2%.
- No linear memory growth and less than 50 MB warmed PSS growth after 1,000
  redraws.

The row-picture/damage-metadata contingency remains inactive. Enable it only
when a release-device trace shows full-grid redraw receipt to commit above
16 ms p95 and picture recording is the dominant stage. Source inspection or an
unmeasured development build is not sufficient evidence for changing shared
redraw result types.
