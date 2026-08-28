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
grid size is sent to Neovim. A completed tap inside the rendered grid is
converted through those same cell metrics and sent as a zero-based
`nvim_input_mouse` left-button press with grid `0`, allowing Neovim to resolve
the target screen window while retaining authority over its mouse option and
mappings.

The Android app bundles JetBrainsMono Nerd Font Mono for editor glyphs and all
action-pad text so Nerd Font private-use characters share one known typeface.
Each surface handles loading independently: the pad retains system typography
while pending or unavailable, and the editor falls back to system monospace if
its four-face load fails.

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
raw-input, and composition-settlement calls plus committed-text, structured
special/hardware-key, and ordered-input events. Android composition updates are
not forwarded as duplicate input. Physical keys, configured action-pad input
sequences, and editor taps settle active composition before their input reaches
Neovim, so touch commands cannot overtake unfinished software-keyboard text.
Tapping the editor never changes IME focus; the root action pad exposes a configured
Keyboard interaction for opening it.

### Contextual action pad

The Android command area is a small interpreter for a validated graph of menus,
ordered groups, buttons, and interactions. Group IDs are arbitrary configuration
labels with no built-in placement semantics. A button configures `tap`,
`longPress`, or both from the same interaction union: direct Neovim input,
opening a whole menu, substituting one destination group, going Back, or
focusing the Android keyboard. Each interaction declares `after: 'root'` or
`after: 'stay'`, so return behavior is local to the button gesture instead of
inherited from its menu.

A group interaction resolves a destination menu and the exact destination group
object, then renders that group in the invoking base group's fixed slot. Target
definition identity and layout identity remain separate: selection mode edits
the destination `{menuId, groupId, buttonId}`, while the outer rendered group is
still identified by the current page and original host-group ID. Replacement
buttons use their actual definition identity. This lets memoized sibling groups
stay mounted while only the restored and newly substituted slots rerender.

Navigation state is reducer-owned and consists of a full-page stack plus at most
one active cluster. A `group` interaction with `after: 'stay'` replaces the
active cluster without adding history; a nested group interaction retains the
same original host slot. Activating a cluster in another group restores the old
host first. Opening a whole menu clears the cluster before pushing the page, so
Back returns to a clean prior page. Back clears a cluster and pops one page; at
Home it only clears the cluster. Any `after: 'root'`, disable/reset, or active
configuration replacement clears both page and cluster state. Input and
keyboard actions with `after: 'stay'`, layout/compact changes, selection mode,
and suspension preserve it.

The bundled Up/Down buttons send `<Up>` or `<Down>` on tap and substitute their
navigation choices on long press. Yank, Delete, Motions, and TextObjects use the
same transient mechanism on tap. Their consolidated `options` groups contain no
Back button; configured Back remains an ordinary button on full pages. Special
and modified keys are complete trusted `nvim_input` strings such as `<Esc>` and
`<C-w>h`. Navigation and Back transitions are local, so Neovim receives nothing
for either. Inputs can retain a cluster for repetition or return the complete
pad to root.

Below the editor, the action pad normally follows the Figma 213dp treatment.
When the software keyboard removes at least 120dp of usable height, it compacts
to 144dp while retaining two 48dp touch rows and yields the remaining space to
the editor. To the editor's right, it uses a `336dp` rail at full workspace
height. The trusted configuration still owns density and can overflow, but a
cluster swap never changes sibling positions, the scroll-view instance, its
content extent, or its scroll offset.

Each base-page slot has a fixed capacity envelope computed by following only
group-action targets reachable from that slot. Below the editor, a variant with
`buttonCount` buttons needs `max(1, ceil(buttonCount / 2))` columns. The slot
always renders against the maximum reachable column count with 48dp minimum
cells and 6dp internal and inter-group gaps. Its minimum basis is
`columns × 48 + (columns - 1) × 6`; surplus width is distributed
proportionally. Oversized configurations remain in a horizontal overflow
container whose content width is fixed across substitutions.

In the right rail, default and half-sized buttons consume two units and quarter
buttons consume one unit in four-unit rows. A slot reserves the maximum exact
row height across its reachable variants using the normal or compact button
height and existing gaps. The shared vertical overflow container therefore
keeps the same geometry through a substitution. Both placements preserve 48dp
touch targets and the existing press ownership, long-press, release, and stale
activation guards.

The current Neovim mode, full-page breadcrumb, and active-cluster label are
projections in the action-pad header, not a second Neovim state machine. The
visual context distinguishes them, for example `› Leader / Search · Delete`, and
the accessibility announcement names the page path separately from the active
cluster. Hardware-key input remains independent of the touch-menu path.

The action document is YAML data, with `version`, `rootMenuId`, and ordered
menus, groups, and buttons. A `group` interaction carries both `menuId` and
`groupId`. Strict semantic validation requires both destinations, rejects
same-menu references and cycles mixed across menu/group links, and the resolver
preserves destination object identity. The bundled starter and user-selected
host files use the same parser. The renderer sees only a validated graph, whose
identity changes after a successful Load/Save rather than on each form edit or
editor redraw; replacement resets navigation to root. This prototype
deliberately evolves schema version 1 in place and does not promise that older
builds can read group-enabled version-1 documents.

The configuration store owns the active document, editable draft, host-file
identity/revision, and endpoint-specific recovery cache. The separate editor
uses the same layout renderer with no-op input/keyboard callbacks. Entering the
editor settles the prior IME composition and blurs the Neovim input target;
ordinary form text cannot enter the session. Editor access sits outside user
configuration so an empty or unusable pad can always be repaired.

Host document operations are typed `nvim-session` methods implemented by fixed
`nvim_exec_lua` chunks with paths/content passed as RPC arguments. Reads do not
create files. Saves compare content revisions and resolved targets, protect
modified buffers, and publish a sibling temporary file without replacing a
dotfile symlink. Controller checks bind results to the endpoint and connection
generation. File failures and local wait timeouts do not tear down the editor
session. A timed-out write is not automatically replayed: its outcome must be
reconciled by reading the file.

User-selected configurations are executable input configuration, not a safe
command sandbox. Loading/editing/previewing does not dispatch their inputs, but
active input buttons may execute arbitrary Neovim commands. The existing
trusted-private-network requirement applies to both input and host file access.
There is no Android file backend, cloud/Git synchronization, or remote file
browser; Load/Save/Export use explicit host paths.

Expo Continuous Native Generation owns the ignored `apps/android/android/`
directory. Native module source remains tracked under `apps/android/modules/`.

## Current limitations

- One configured endpoint and one active connection per client.
- One basic Neovim grid.
- Manual host process startup and manual reconnect.
- Android requires a tablet-sized window and a development build.
- No TLS, authentication, discovery, daemon, or remote-access relay.
- Mouse gestures beyond a single left-button tap, clipboard integration, iOS,
  emulator support, advanced UI extensions, and Android phone layouts are out
  of scope.
