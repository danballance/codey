# Architecture

Codey now has two deliberately narrow, end-to-end client paths over the same
shared packages.

```text
Electron
  canvas renderer + DOM input
    -> narrow preload API
    -> Electron main process
    -> NvimSessionClient
    -> MessagePackRpcClient
    -> NodeTcpTransport
    -> headless Neovim

Android tablet
  Skia renderer + native Android IME
    -> app-local connection/editor controller
    -> NvimSessionClient
    -> MessagePackRpcClient
    -> ExpoTcpTransport
    -> local Expo Kotlin TCP module
    -> headless Neovim
```

The Electron renderer has no Node.js access; its TCP socket remains in the main
process. On Android, the JavaScript adapter satisfies the same byte-stream
contract while socket ownership and blocking I/O remain in the Kotlin module.
Platform orchestration stays inside each app, so proving the mobile path does
not require an Electron refactor.

## Shared package rules

- `transport` knows bytes and connection lifecycle, not MessagePack or Neovim.
- `msgpack-rpc` frames a continuous byte stream, tracks request IDs, and exposes
  requests and notifications without knowing Neovim methods.
- `nvim-session` is the only package that names Neovim RPC methods.
- `editor-core` reduces redraw events into a single-grid model. It has no socket,
  Electron, React Native, DOM, canvas, or Skia dependencies.
- Neovim is authoritative. The grid is a rendering projection, not an editable
  document model.

`DuplexTransport`, `MessagePackRpcClient`, `NvimSessionClient`, and the
`editor-core` public API are unchanged. The mobile app consumes their raw
TypeScript exports through Expo's standard pnpm-aware Metro configuration.

## Redraw and resize lifecycle

Neovim sends a `redraw` notification containing a batch of UI events. The core
applies all events in order. A snapshot reaches either platform renderer only
when the batch contains `flush`, so intermediate mutations never produce a
partial frame.

The Android Skia renderer draws grid backgrounds and glyphs, RGB highlights,
reverse colors, text decorations, cursor, mode, and dimensions from those
snapshots. Available canvas bounds are converted to rows and columns whenever
system bars, the software keyboard, or multi-window bounds change, and the new
grid size is sent to Neovim.

This slice opts into `ext_linegrid` and `rgb`, but not multigrid or externalized
command-line, popup-menu, or message UIs.

## Android platform boundary

The app evaluates the active Android window before constructing any editor
resource. The generated manifest leaves orientation unspecified. Runtime
eligibility depends only on tablet-sized bounds:

- shortest side below `600dp`: unsupported; no transport, session, renderer, or
  IME is created;
- shortest side at least `600dp`, width below `840dp`: supported condensed
  tablet shell;
- shortest side at least `600dp`, width at least `840dp`: primary large-tablet
  shell.

Phones are not filtered from the manifest. If an active editor window becomes
unsupported during multi-window resizing, the controller tears down the session
idempotently before showing the unsupported-device screen. Supported portrait
and square bounds use a stacked terminal and action pad; landscape bounds place
the same persistent action pad in a fixed `336dp` right rail. Changing layout
does not recreate the connection, editor controller, or action-pad state.

The app-local controller owns exactly one current connection. It validates and
persists host/port settings, exposes explicit connect, disconnect, and reconnect
states, rejects stale native events from earlier connection IDs, and performs
no automatic reconnect.

### TCP module

The local Expo module exposes this binary boundary:

```text
open(host, port, timeoutMs) -> Promise<connectionId>
write(connectionId, Uint8Array) -> Promise<void>
close(connectionId) -> Promise<void>
data event  { connectionId, bytes }
close event { connectionId, code?, message? }
```

Each socket has TCP no-delay enabled, ordered writes, background reads, and one
terminal close event. The TypeScript `ExpoTcpTransport` adapter translates this
boundary to `DuplexTransport` and isolates reconnect generations.

### Input module

The local Expo native view exposes imperative `focus()`, `blur()`, structured-key,
and raw-input calls plus committed-text, structured special/hardware-key, and raw
input events. Android composition updates are not forwarded as duplicate input.
Both visible keys and configured command sequences settle active composition
before their input reaches Neovim, so touch commands cannot overtake unfinished
software-keyboard text.

### Contextual action pad

The Android command area is a two-row, app-local action tree. Its bundled,
type-checked configuration describes native keys, complete trusted `nvim_input`
sequences, submenus, one-shot Ctrl, and the Up/Down buttons whose tap action is a
single movement while a long press opens navigation choices. Branch traversal is
local: Neovim receives nothing until a configured action is chosen, which makes
Back a purely local operation. Navigation menus can remain open for repeated
movement; one-shot command menus return to the root after dispatch.

Below the editor, the action pad normally follows the Figma 213dp treatment.
When the software keyboard removes at least 120dp of usable height, it compacts
to 144dp while retaining two 48dp touch rows and yields the remaining space to
the editor. To the editor's right, it uses a `336dp` rail at full workspace
height. The rail flattens the two configured rows in order into a scrollable,
two-column flex flow with the normal 52dp portrait treatment; keyboard
compaction reduces those controls to 48dp without changing their order.

The current Neovim mode and menu breadcrumb are projections in the action pad,
not a second Neovim state machine. Hardware-key input remains independent of the
touch-menu path. The action tree is trusted application code and is never loaded
from the connected host or another unauthenticated remote source.

Expo Continuous Native Generation owns the ignored `apps/android/android/`
directory. Native module source remains tracked under `apps/android/modules/`.

## Current limitations

- One configured endpoint and one active connection per client.
- One basic Neovim grid.
- Manual host process startup and manual reconnect.
- Android requires a tablet-sized window and a development build.
- No TLS, authentication, discovery, daemon, or remote-access relay.
- Mouse, clipboard integration, iOS, emulator support, advanced UI
  extensions, and Android phone layouts are out of scope.
