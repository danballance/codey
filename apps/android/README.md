# Android tablet client

This Expo SDK 57 app is Codey's supported client. It starts one bundled,
app-scoped Neovim process and reuses the shared byte transport, MessagePack-RPC,
Neovim session, editor-state, and performance contracts:

```text
Skia renderer + Android IME + Action Pad
  -> TabletClientController
  -> NvimSessionClient
  -> MessagePackRpcClient
  -> ExpoNvimProcessTransport
  -> CodeyNvim native module
  -> bundled nvim --embed
       stdin  <- RPC requests
       stdout -> RPC responses and redraw notifications
       stderr -> bounded diagnostic tail
```

The process is launched directly, stopped with the app session, and never kept
as a background editor service.

## Runtime and connection settings

The current native runtime supports:

- Android 11 / API 30 or newer;
- `arm64-v8a` devices;
- primary shared storage paths; and
- one Neovim process at a time.

Before starting Neovim, grant Android's all-files access and select two existing
directories:

- **Workspace** is a writable absolute path used as Neovim's working directory.
- **Neovim config folder** is a readable, writable, non-root absolute path.

The **Set Workspace** and **Set Config Directory** controls open the directory
browser at the saved location; when no config directory is set, its browser
starts at the workspace. Selection is browser-only and enumerates directories
under primary shared storage. The browser does not translate Storage Access
Framework `content://` URIs, enumerate cloud document providers, or browse
removable volumes. Choosing a directory saves the form; pressing **Start**
launches Neovim as a separate operation.

The config folder can contain `init.lua` and the normal `lua/`, `plugin/`, and
`after/` children. If `init.lua` is absent, Neovim starts with `--clean`. If it
exists, it must be a readable regular file and it executes during connection.
Codey uses app-private HOME, data, state, cache, temporary, and extracted
runtime locations in both cases. Lua changes are not watched or sourced
automatically; source them deliberately or restart Neovim.

Codey stores a single workspace/config pair under a new local-settings record.
Earlier connection-target records and arbitrary Action Pad path preferences are
not imported. After upgrading from a build that stored them, select the two
directories once. To retain an existing custom pad, copy it to the fixed path
described below before connecting or saving.

## Supported screen contract

- The active window must be landscape: width greater than height.
- Its shortest side must be at least `600dp`.
- Windows below `840dp` wide use the condensed tablet shell.
- Windows at least `840dp` wide use the expanded shell; approximately
  `1280x800dp` is the visual-QA baseline.

An unsupported window does not construct an editor session. If multi-window
resizing makes a connected window unsupported, Codey tears down the process
before showing the explanation. Returning to a supported landscape window
creates a fresh disconnected client.

The toolbar spans the window, with the workspace and Neovim config field/Browse
pairs sharing one row at every supported width. Beneath it, the editor uses the
remaining workspace and the Action Pad occupies a fixed `336dp` rail on the
right. The current Neovim mode and Action Pad breadcrumb appear in a footer
directly beneath the editor instead of consuming space at the top of the rail.
The reclaimed height expands the pad's vertically scrollable viewport without
changing its `52dp` normal or `48dp` compact button heights. The pad becomes
compact when the software keyboard substantially reduces the window height.

## Action Pad

The pad is a versioned YAML graph of menus, ordered groups, buttons, and tap or
long-press interactions. The bundled starter is
`src/action-pad/default.yaml`; menu definitions are not duplicated in
TypeScript.

An interaction can:

- send one complete Neovim notation string;
- open a complete menu;
- substitute a destination group into the invoking group slot;
- go Back; or
- focus the Android software keyboard.

Each interaction explicitly chooses `after: stay` or `after: root`. Full-menu
navigation uses a stack. One transient group cluster can be active, and the
invoking base slot reserves the largest layout envelope reachable from it, so a
substitution does not move sibling groups or reset scroll position. Stopping Neovim,
reset, activated configuration replacement, and `after: root` restore the root
pad.

Every button declares a semantic size: `1/1`, `1/2`, `1/3`, `1/4`, or `1/5`.
Rows pack those as 60, 30, 20, 15, and 12 units. Filled or outline appearances
can use default colours or strict `#RRGGBB` overrides; button backgrounds and
outlines also accept `transparent` where the schema permits it.

Button labels can be scalar strings or lists of styled text/icon runs. Rich
runs choose a bundled font size (`10`, `12`, `15`, `18`, or `22`), regular or
bold weight, and an optional `#RRGGBB` colour. The Android rich-label renderer
and Skia editor use bundled JetBrainsMono Nerd Font faces. Give icon-only or
private-use labels a human-readable accessibility label.

### Fixed file and lifecycle

The only Action Pad destination is:

```text
<config-directory>/action-pad.yaml
```

The editor displays this path as read-only. It has no separate path chooser or
remembered file location. On the first successful connection for the selected
target, Codey reads the file through the active Neovim RPC session. If it does
not exist, the bundled starter remains active. Reading never creates a file.

**Save** validates and serializes the in-memory working copy, writes the fixed
file through the same session, and activates the new pad only after the write
succeeds. The underlying operation creates missing parent directories, opens
the file directly, truncates it, writes UTF-8 YAML, and follows ordinary
filesystem symlinks. It is last-writer-wins and does not compare file revisions
or matching Neovim buffers. A failure after truncation can leave the file
incomplete; keep Git history or a backup for important configurations.

Files are limited to 1 MiB. Save normalizes YAML formatting and does not retain
handwritten comments. File operations require a running process and are
bound to that connection generation. A pending write is never replayed after a
restart.

The full-screen editor owns a working copy separate from the active pad.
Incomplete IDs, labels, destinations, sizes, or colour values block Save.
Cancel asks before discarding dirty edits. Ordinary form fields own keyboard
focus while the live pad is suspended, so editor typing cannot reach Neovim.
If the process stops, dirty in-memory edits remain available for an explicit
restart and retry.

### Editing workflow

Tap **Edit Action Pad** to enter button-selection mode. Pencil markers appear,
and tapping or holding a visible button opens the full editor at that button
without running its configured action. **Done editing** or Android Back exits
selection mode. Holding the edit control opens the general editor directly.

**Manage menus** identifies the Root menu, definitions reachable from it, and
unused definitions. Root cannot be deleted. A referenced menu remains protected
until its incoming Tap/Hold Menu or Group links are removed. The editor can
navigate directly to each blocking reference. **Remove unused menus** deletes a
confirmed root-unreachable set as one working-copy change.

Adding, deleting, duplicating, renaming, reordering, and moving menus, groups,
buttons, interactions, and label runs changes only the working copy until Save.
Deleting a launcher does not implicitly delete its destination definition.
Discard restores the last activated configuration.

### YAML shape

A minimal document looks like:

```yaml
version: 1
rootMenuId: home
menus:
  - id: home
    label: Home
    groups:
      - id: main
        buttons:
          - id: escape
            label: Esc
            styles:
              size: '1/2'
              appearance: outline
              outlineColor: '#73daca'
            tap:
              type: input
              nvimInput: '<Esc>'
              after: root
```

A group substitution names both destination definitions:

```yaml
tap:
  type: group
  menuId: delete
  groupId: options
  after: stay
```

Menu IDs are unique across the document, group IDs within a menu, and button
IDs within a group. Destinations must exist. Same-menu group links and cycles
composed of menu and group links are rejected. A button needs `tap`,
`longPress`, or both. Numeric and whitespace-sensitive strings should be
quoted; input strings are preserved exactly.

Only one YAML 1.2 document is accepted. Custom tags, aliases, unknown fields,
unsupported versions, missing size declarations, invalid colours, and documents
over 1 MiB are rejected. Rich labels contain 1 to 64 runs and their combined
text cannot be blank, although separator runs may contain whitespace.

## Editor input

The app-local `CodeyIme` native view uses terminal mode by default: multiline,
visible-password, and no-suggestions flags encourage coding keystrokes to be
committed promptly. A composed compatibility mode remains available to code
that needs CJK composition, swipe input, or autocorrection, but is not currently
exposed as a user preference.

Physical keys, Action Pad input, and editor taps first settle active Android
composition. Every Action Pad notation string enters the controller as one
ordered operation.

A completed single-finger tap on a visible editor cell becomes a zero-based
`nvim_input_mouse` left-button press on grid `0`. Neovim resolves the target and
retains authority over its `mouse` option and mappings. Taps do not open or
close the software keyboard; use the Action Pad Keyboard button. Drag selection,
multi-tap, long-press/right-click, wheel, stylus-button, and multi-touch gestures
are not implemented.

## Develop on a physical tablet

Enter the repository's Nix shell and install workspace dependencies:

```sh
nix develop
pnpm install
```

Enable USB debugging, attach and authorize an arm64 Android 11+ tablet, then
install the development client and start Metro. The install command prepares
the checksum-pinned runtime and performs a clean development prebuild:

```sh
adb devices
pnpm android:install
pnpm android:metro
```

The development client uses the retained Android `INTERNET` permission to reach
Metro and Expo development services. TypeScript-only changes can reuse the
client. Native configuration, Kotlin, native module registration, or bundled
library changes require another clean prebuild and reinstall.

Use `pnpm android:prepare:nvim` to stage only the runtime, or
`pnpm android:prebuild` to stage it and regenerate the native project without
installing.

Expo Continuous Native Generation creates the ignored `android/` directory.
Tracked native module source lives under `modules/`.

## Standalone APK

Build the runtime and standalone release APK with:

```sh
pnpm android:apk
```

This runs runtime preparation, generates a clean Android project with the
`standalone` profile, omits the development client, and assembles:

```text
apps/android/android/app/build/outputs/apk/release/app-release.apk
```

The ordinary local debug signing fallback is suitable for personal sideloading,
not public release identity. The pinned binary runtime is not yet the
reproducible source-build pipeline required for public or F-Droid distribution.
See [the bundled runtime guide](native-runtime/README.md).

## Verification

From the repository root:

```sh
pnpm check
```

Useful Android-specific checks are:

```sh
pnpm android:doctor
pnpm android:bundle
pnpm android:test
pnpm android:prebuild
pnpm android:test:native
pnpm android:assemble
pnpm android:assemble:release
```

The native tests and Gradle assemblies require a generated `android/` tree.
Run the clean prebuild first when invoking them independently. No Android Studio,
emulator, or system image is included in the Nix shell.

For physical acceptance, verify at both `800x600dp` condensed and
`1280x800dp` expanded landscape sizes:

1. Grant all-files access, choose the workspace/config directories, start
   Neovim, edit a file, stop it, and start it again.
2. Test a config folder without `init.lua`, then a trusted folder with one.
3. Confirm a missing `action-pad.yaml` uses the starter; Save, restart Neovim, and
   confirm the fixed file reloads.
4. Exercise button selection, menu management, guarded deletion, unused-menu
   cleanup, rich text/icons, every button width, both appearances, custom
   colours, validation, discard, and save-failure recovery.
5. Test Gboard, hardware keys, Action Pad ordering, tap-to-position, terminal
   input, software-keyboard resize, and accessibility font scaling/TalkBack.
6. Resize to an unsupported window and confirm the process closes; restore a
   supported landscape window and confirm a fresh disconnected client appears.

Performance capture and thresholds are in
[the performance guide](../../docs/performance.md).

## Security boundary

All-files access is retained because Neovim, Git, shell commands, configuration,
and plugins need real filesystem paths. The manifest also retains `INTERNET` for
Metro, Expo development services, and possible future app features. The editor
process itself communicates only through its app-owned file descriptors.

This is not a sandbox. Selected `init.lua`, plugins, Lua, `system()`, `:!`, and
activated Action Pad commands execute with the app UID and can reach files that
the app can access. Loading or editing YAML does not execute its input strings;
pressing an active input button does. Select only trusted workspaces, config
folders, files, plugins, and Action Pad configurations.
