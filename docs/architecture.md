# Architecture

Codey has one supported editor path: an Android tablet UI controlling one
bundled, app-scoped Neovim process.

```text
Skia renderer + Android IME + Action Pad
  -> TabletClientController
  -> NvimSessionClient
  -> MessagePackRpcClient
  -> ExpoNvimProcessTransport
  -> CodeyNvim Expo module
  -> bundled nvim --embed
       stdin  <- encoded RPC requests
       stdout -> RPC responses and redraw notifications
       stderr -> bounded diagnostic tail
```

No socket is opened for the editor session. The JavaScript transport crosses
the Expo native bridge, while Kotlin owns blocking child-process I/O and process
lifecycle. Neovim's stdin/stdout remain a continuous byte stream; the same RPC,
session, and redraw layers above the transport do not need a special local
protocol.

## Shared package boundaries

- `transport` defines byte-stream and close-lifecycle contracts.
- `msgpack-rpc` frames the stream, assigns request IDs, and dispatches responses
  and notifications without knowing Neovim methods.
- `nvim-session` is the typed facade that names Neovim RPC methods.
- `editor-core` reduces redraw batches into an immutable single-grid snapshot.
  It has no Android, React Native, Skia, native-process, or filesystem
  dependencies.
- `perf` carries opt-in, content-free timing correlation.

Neovim is authoritative. The grid is a rendering projection, not a second text
model. Codey never attempts to reproduce Neovim buffers, mappings, undo, modes,
or plugin state.

## Native runtime boundary

`CodeyNvim` owns one process manager. Its native API covers runtime status,
all-files settings, workspace directory listing, process start/write/stop, and
data/exit events. A monotonically increasing session ID binds every write and
event to the process that produced it. Late events from an earlier generation
are ignored.

Process startup performs these checks before spawning Neovim:

- Android API level is at least 30;
- the device exposes `arm64-v8a`;
- the executable, dependent DSOs, and runtime bundle are present;
- Android all-files access is granted;
- the workspace is an existing writable directory; and
- the config directory is an existing readable, writable, non-root directory.

An existing `init.lua` must be a readable regular file. Without one, the command
is `nvim --clean --embed`. With one, `XDG_CONFIG_HOME` and `NVIM_APPNAME` make
the selected directory Neovim's real config root, and a strict post-start check
turns config errors into a failed connection. Data, state, and cache live in an
app-private profile keyed by the canonical config path. HOME, temporary files,
and the extracted runtime are also app-private.

The executable is launched directly from Android's extracted native-library
directory. There is no intermediary shell, listener, service, or daemon.
Stdout is reserved for MessagePack-RPC. Stderr is drained concurrently into a
bounded 16 KiB tail so diagnostics cannot deadlock the process or grow without
limit. Closing a session closes stdin, requests process termination, escalates
to forced termination after a bounded wait, and drains terminal events
idempotently.

The runtime archive is checksum-verified and extracted with traversal checks
into a versioned private directory. Runtime data is not executable; only the
packaged native-library executable is run.

## Connection and redraw lifecycle

The app-local controller owns one current process connection and exposes
explicit disconnected, connecting, connected, and error states. It does not
automatically reconnect. Every connection receives a generation number, and
resources from superseded generations are closed or ignored.

Neovim sends `redraw` notifications containing ordered event batches. The core
applies a batch in order and publishes only at `flush`, so no renderer sees a
partial frame. The Skia canvas draws backgrounds, glyphs, RGB highlights,
reverse colours, decorations, cursor, mode, and dimensions from the published
snapshot.

Available canvas bounds are converted to rows and columns when system bars,
the software keyboard, or multi-window geometry changes. Resize requests remain
generation-bound. A completed editor tap is converted through the same cell
metrics and sent as a zero-based `nvim_input_mouse` left-button press on grid
`0`; Neovim resolves the actual window and retains authority over its mouse
option and mappings.

This slice enables `ext_linegrid` and RGB. It does not enable multigrid or
externalized command-line, popup-menu, tabline, wildmenu, or message UIs.

## Device and window gate

Expo requests landscape, and a runtime gate remains authoritative:

- portrait, square, or shortest side below `600dp`: unsupported and no editor
  resource is constructed;
- supported landscape below `840dp` wide: condensed shell;
- supported landscape at least `840dp` wide: expanded shell.

If resizing makes an active window unsupported, Codey tears down the session
before showing the unsupported-device screen. Returning to supported landscape
creates a fresh disconnected client. Both supported shells place compact **Set
Workspace** and **Set Config Directory** controls in one toolbar row without
permanently displaying either path. Below it, the workspace reserves a fixed
`336dp` right rail for the Action Pad; the editor column owns a footer containing
Neovim mode and the current page/cluster breadcrumb. Keeping that status outside
the rail gives the pad the reclaimed vertical viewport while preserving its
`52dp` normal and `48dp` compact button heights.

## Workspace and configuration settings

Codey persists one local workspace path and one local Neovim config directory.
There is no target-kind discriminator, host, port, endpoint identity, or
per-endpoint preference. The form may temporarily hold an unset config
directory, but connection construction rejects it.

The native browser returns canonical directories beneath primary shared
storage. Directory selection is picker-only: each toolbar control reopens at
its saved path, with an unset config selection falling back to the workspace.
The browser displays its current path but does not translate Storage Access
Framework `content://` URIs, enumerate cloud providers, or expose a virtual
filesystem to Neovim.

The selected config directory has two roles:

1. it is the optional executable Neovim configuration root; and
2. it owns the fixed Action Pad file at `<config-directory>/action-pad.yaml`.

Codey does not watch or automatically source changes to Lua files. Users source
them deliberately or reconnect for a fresh startup.

## Input ordering

The `CodeyIme` native view exposes focus, blur, committed-text, structured-key,
raw-input, and composition-settlement operations. Terminal mode requests
multiline visible-password input without suggestions so coding input is
committed promptly. Composed mode remains available for compatibility testing.

Physical keys, Action Pad sequences, and editor taps settle active Android
composition before their input enters the controller. This prevents a touch or
configured command from overtaking unfinished software-keyboard text. Tapping
the editor does not change IME focus; the root Action Pad contains the explicit
Keyboard action.

## Contextual Action Pad

The Action Pad interprets a validated YAML graph of menus, ordered groups,
buttons, and tap/long-press interactions. Inputs are complete trusted Neovim
notation strings. Navigation, Back, and group substitution are local UI state
and do not send RPC input.

A group interaction substitutes one destination group into the invoking base
slot. The base slot reserves a fixed capacity envelope for every reachable
variant, so swaps preserve sibling positions, scroll extent, and scroll offset.
At most one transient cluster is active. Full-menu navigation uses a separate
stack; root/reset and activated configuration changes clear both layers.

Every button declares a semantic size (`1/1`, `1/2`, `1/3`, `1/4`, or `1/5`),
appearance, and optional strict `#RRGGBB` colour overrides. Labels may be a
legacy scalar or a bounded list of styled text/icon runs. The JavaScript and
native rich-label renderers share the same bundled JetBrainsMono Nerd Font
faces and semantic style resolution.

The full-screen editor owns an in-memory working copy separate from the active
pad. Invalid or incomplete IDs, labels, destinations, and colour values block
Save. Opening the editor settles composition, blurs Neovim input, and suspends
the live pad, so form typing cannot enter Neovim. Closing with unsaved changes
requires explicit discard confirmation.

The destination is always `<config-directory>/action-pad.yaml`. It is displayed
read-only; there is no arbitrary host path or remembered path selection. On the
first successful connection, Codey reads that file or uses the bundled starter
when it does not exist. Save serializes the validated working copy to the fixed
file and activates the saved configuration.

Action Pad file operations remain generation-bound and preserve dirty edits
across failures. A write that has begun cannot be assumed to be safely
cancelled; failure recovery must report whether the file may be incomplete.

## Permissions and security

The release keeps Android's `MANAGE_EXTERNAL_STORAGE` access because Neovim and
ordinary plugins need real filesystem paths for workspace, config, Git, and
shell operations. It also keeps `INTERNET` for Metro/Expo development services
and possible non-editor app features. Neither permission changes editor
transport: Neovim RPC remains on app-owned child-process file descriptors.

The local process is not a sandbox. Selected `init.lua`, plugins, Action Pad
commands, Lua, `system()`, and `:!` execute with the Android app UID and can
access files allowed by all-files permission. Only trusted configuration,
workspaces, files, and Action Pad YAML should be used.

## Generated and tracked native content

Expo Continuous Native Generation owns the ignored `apps/android/android/`
directory. Kotlin module source remains tracked under `apps/android/modules/`.
Checksum locks, licence material, and native-runtime publication constraints are
documented under `apps/android/native-runtime/`.

## Current limitations

- One process connection and one basic Neovim grid.
- Android 11/API 30+, `arm64-v8a`, physical landscape tablet workflow.
- Explicit connect/disconnect; no background process or automatic reconnect.
- Fixed local Action Pad path and no cloud/Git configuration synchronization.
- No clipboard integration, iOS client, emulator support, advanced external UI
  extensions, Android phone layout, drag selection, or advanced mouse gestures.
- The pinned binary runtime is suitable for personal sideloading, not yet a
  reproducible public/F-Droid release pipeline.
