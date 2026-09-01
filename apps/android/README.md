# Android tablet client

This app is an Android-only Expo SDK 57 client for Codey. It proves
the mobile vertical slice while reusing the existing `transport`, `msgpack-rpc`,
`nvim-session`, and `editor-core` contracts:

```text
Skia + Android IME
  -> NvimSessionClient
  -> MessagePackRpcClient
  -> ExpoNvimProcessTransport -> CodeyNvim -> bundled nvim [--clean] --embed
   or ExpoTcpTransport -> CodeyTcp -> remote TCP endpoint
  -> Neovim
```

## Local and remote sessions

Fresh installs select **Local**. On arm64 Android 11 or newer, the personal POC
APK starts one bundled `nvim --embed` process and carries RPC bytes over
stdin/stdout. It adds `--clean` unless the selected Neovim config folder contains
a readable `init.lua`. Grant Android's all-files access, then use the two
**Browse** controls to choose an existing writable workspace and required Neovim
config folder under primary shared storage (the device's internal user storage).
The browser is intentionally limited to that storage root
in this POC; it does not expose removable volumes, cloud providers, or Android's
Storage Access Framework. The path remains editable as a manual fallback for
another known writable absolute filesystem path.

The browser returns canonical paths that the bundled process can use directly.
It does not attempt to convert a `content://` tree URI into a filesystem path.
Choosing either directory updates and saves the Local target without starting a
session; **Connect** remains an explicit second action and is unavailable until
the config folder is set.
Android's all-files settings page is opened explicitly when access has not been
granted.
The process gets a private HOME and stops with the app session; it is not a
background server. Data, state, and cache remain app-private even when an
external config folder is active.

Select **Remote** to retain the existing host/port TCP workflow. A legacy saved
endpoint is migrated to Remote automatically. The most recent local path and
remote endpoint are stored independently. Local connection settings remember one
device-wide Neovim config folder; Remote mode remembers one Action Pad YAML path
per endpoint.

The bundled implementation is intentionally arm64/API-30-only and meant for a
personal sideloaded APK. See [`native-poc/README.md`](native-poc/README.md) for
the build command, security boundary, binary lock, and the source-build work
required before F-Droid.

## Supported screen contract

- Only landscape tablet windows are supported: the active width must be greater
  than the active height.
- The shortest active window side must be at least `600dp`.
- Windows from `600dp` through `839dp` wide use the condensed tablet shell.
- Windows at least `840dp` wide use the large-tablet shell; approximately
  `1280x800dp` is the visual-QA baseline.
- Phones may install the APK, but an unsupported window cannot construct or
  connect an editor session.

If multi-window resizing takes a connected editor below the minimum, the app
disconnects safely before showing the unsupported-device explanation. Portrait
and square bounds are unsupported in the same way. Expo requests landscape at
the platform level, while the runtime gate remains authoritative on devices
that do not honor fixed-orientation requests. Returning to supported landscape
bounds starts a fresh disconnected client.

## Landscape workspace and dynamic action pad

The editor uses the available vertical space while the action pad occupies a
fixed `336dp` rail to its right. The full-width connection toolbar stays above
both.

Each menu contains an ordered array of arbitrarily named button groups. A
`group` interaction can temporarily replace only the invoking group's slot with
one group from another menu. One transient cluster can be active at a time;
opening one from a different slot restores the previous slot first, and nested
group actions continue to use the original host slot. Full-menu actions still
replace the whole page. Group names have no built-in layout meaning.

Every base-page group reserves a fixed rail-capacity envelope large enough for
all group-action targets reachable from its slot. Every button must explicitly
set the semantic `styles.size` value to `"1/1"`, `"1/2"`, `"1/3"`, `"1/4"`, or
`"1/5"`. Rows use 60 packing units: those sizes consume 60, 30, 20, 15, and 12
units respectively. Sequential packing therefore wraps mixed fractions exactly,
while the rendered widths leave the existing 4% gaps between buttons. A base
slot reserves the maximum exact row height of its reachable variants. Groups
remain in one shared vertical overflow container, so cluster swaps keep its
extent and offset stable. `styles` is a small action-pad contract, not an
unrestricted React Native style passthrough.

Buttons configure generic `tap` and `longPress` interaction slots, with at least
one interaction present. An interaction may send direct Neovim input, open a
whole menu, substitute a destination group, go Back, or focus the Android
software keyboard. Each independently chooses `after: stay` or `after: root`.
The bundled Yank, Delete, Motions, and TextObjects buttons open transient option
clusters on tap. Up and Down send `<Up>` or `<Down>` on tap, while a `450ms` hold
opens their transient navigation choices and suppresses the release tap. The
bundled clusters have no Back buttons.

The header shows the full-page breadcrumb separately from the active cluster,
for example `› Leader / Search · Delete`, and exposes that distinction to
accessibility services. Opening a full menu first clears the cluster and then
pushes a page. Back first clears a cluster and pops one page; on Home it only
clears the cluster. Input or keyboard interactions with `after: stay`, supported
landscape resizing, keyboard compaction, selection mode, and app suspension
retain it. Any
`after: root`, disconnect/reset, or activated configuration replacement restores
the complete root pad.

Every input interaction dispatches its complete Neovim notation in one ordered
operation, after any active Android IME composition has been committed. Inputs
inside navigation clusters use `after: stay` for repeated movement, while
one-off commands can use `after: root`. The rail retains 48dp touch targets and
the same long-press release-suppression guarantees.

When the software keyboard reduces the window height by at least `120dp`, the
pad switches to its compact treatment while preserving those targets and any
active cluster. The landscape groups remain vertically scrollable when the
keyboard leaves too little height for every action. The editor and toolbar also
relax their minimum heights so the 800 × 600dp condensed tablet layout does not
overflow.

The starter configuration is `src/action-pad/default.yaml`: one versioned YAML
document containing 12 menus, 30 logical groups, and 86 buttons. The app
validates it using the same parser as external configurations. No menu
definitions are maintained in TypeScript. `src/action-pad/index.ts` exports the
renderer, default configuration, document parser/validator/serializer, and
menu, group, button, and interaction types. Special keys and modified keys use
Neovim notation, such as `<Esc>`, `<Up>`, and `<C-r>`.

### Editing and saving Action Pad configuration

Navigate to the page or transient cluster you want to refine, then tap **Edit
Action Pad**, below the pad. The visible buttons gain pencil markers; tap
anywhere on a button to open its editor with that button's definition selected.
For a transient replacement this is the target
`{menuId, groupId, buttonId}`, even though the renderer retains the source slot
for layout. Both taps and holds select a button in this mode. Configured input,
menu, group, Back, and keyboard actions are suppressed.

Closing the editor keeps selection mode enabled and preserves the current page
and active cluster. Use **Done editing** or Android Back while the pad is visible
to exit selection mode and restore normal button actions. A successful **Save**,
or **Load / Reload** in Remote mode, resets the active pad to its complete root
layout.

Hold **Edit Action Pad** for `450ms` to open the general configuration editor
directly, without entering selection mode. Holding **Done editing** opens the
same editor while keeping selection mode enabled. The control also exposes an
**Open full Action Pad editor** accessibility action. It is not part of the YAML
and remains available even if every configured button is removed or the host is
disconnected. Opening the full editor without a targeted button starts in
**Manage menus**. This view lists every definition, with its label and ID,
group/button and incoming-link counts, and one of these navigation statuses:

- **Root** is the menu selected by `rootMenuId`.
- **Reachable** menus can be reached from Root through a Tap or Hold **Menu** or
  **Group** interaction.
- **Unused** menus cannot be reached from Root, even if they link to one another.

The manager can edit a menu, make it Root, or delete it. The same guarded delete
action remains available in Menu settings. Root cannot be deleted, and a
reachable or unused menu with incoming references cannot be deleted
individually until those links are removed. For each blocking reference, the
editor names the exact source menu, group, and button, whether the link is on
Tap or Hold, and whether it is a Menu or Group action. Selecting that reference
opens and scrolls to the matching interaction so it can be changed or removed.
IDs are shown with labels where duplicate labels would otherwise be ambiguous.

Removing a visible launcher button, group, or interaction does not implicitly
delete its destination menu definition. The destination therefore remains in
menu and destination dropdowns until it is deleted explicitly. After an
individual deletion in a valid working copy, the manager, dropdowns, move destinations,
and status counts update immediately. Field validation is shown directly in the
form and prevents Save until the working copy is valid.

When one or more menus are Unused, **Remove unused menus** offers a confirmation
that lists the affected definitions and their aggregate group/button counts. A
confirmed cleanup removes the complete root-unreachable set as one editor change,
including references between menus in that set, while preserving Root and every
Reachable menu. Cleanup is unavailable while the working copy is invalid or another
edit is pending.

The general editor also includes groups, buttons, duplication, ordering/move
controls, and all button properties. **Group** appears alongside the other
interaction types, followed by destination-menu and destination-group pickers;
changing the menu clears the group selection. Menu and group renames update
links. The existing Neovim session remains mounted while ordinary form inputs
own keyboard focus, but the active pad stays suspended until the editor closes.

Button settings offer Whole, Half, Third, Quarter, and Fifth widths. They also
offer Filled and Outline appearances plus optional background and outline colour
overrides. The palette includes Default, Green, Yellow, Cyan, and Red; button
colours additionally support Transparent, and a custom value accepts exactly
`#RRGGBB` (case-insensitive). Default removes the override so the appearance
controls the colour. Filled buttons default to `#24283b` with no visible outline;
Outline buttons default to a transparent background with a `#353b52` outline.
An incomplete custom value is retained while the editor stays open and shown as
a field error, but Save remains disabled until it is valid. The external
idle **Edit Action Pad** control uses the same set-back transparent treatment;
**Done editing** remains cyan/tinted and **Connect session** remains filled.

The primary YAML file lives in the connected Neovim environment. Remote mode
retains the arbitrary absolute or `~/` host-file field and remembers one file
per endpoint. Local mode instead uses the required **Neovim config folder** from
the connection screen and always reads or writes its fixed `action-pad.yaml`
child. The same folder is
a real Neovim config root: an optional `init.lua` is the entry point, and normal
`lua/`, `plugin/`, and `after/` children work through Neovim's runtime path.
Choose it before connecting with **Browse** or enter an absolute Android
filesystem path. The folder must already exist and be readable and writable;
startup is rejected if it is missing or invalid, or if an existing `init.lua`
is not a readable regular file. A valid folder without `init.lua` uses its
`action-pad.yaml` but starts clean. A folder with `init.lua`
loads that Lua configuration on the next explicit Local connection. Codey does
not reload or restart Neovim when files change: edit the configuration in Codey,
then source it deliberately or disconnect and reconnect. Version-2 connection
settings retain workspace and Remote details during migration, but require the
Local config folder to be selected once. Older Local Action Pad YAML preferences
are not reinterpreted as directories.

File operations need no extra service, plugin, or SSH connection. Remote mode
needs no Android storage permission; Local mode uses the all-files access already
required for an external workspace.

- In Remote mode, **Load / Reload** validates a file before replacing the active
  pad and working copy. Invalid files leave both unchanged. Loading over unsaved
  edits requires confirmation. Local mode loads its fixed file automatically on
  connection and does not expose a path or Load control in the editor.
- **Save** validates the working copy, writes the selected host file directly,
  and only then activates the configuration. The first Save creates a missing
  file and its parent directories; startup and reads never create files.
  In Remote mode, changing the path before Save writes that path and remembers
  it after success. In Local mode Save always targets the selected folder's
  `action-pad.yaml` child.
- **Cancel** offers **Keep editing** or **Discard and close** when edits are
  unsaved. Closing discards the in-memory working copy and never writes a host
  file.

Menu deletions and unused-menu cleanup follow the same working-copy lifecycle as every
other edit. They disappear from editor pickers immediately, but the live Action
Pad and host YAML keep the last activated configuration until a successful
**Save**. Discarding and closing restores the last activated definitions.

Connection settings persist the Local config folder; the Action Pad store
persists only Remote YAML paths. Unsaved edits,
including incomplete field text, live in memory while the editor remains open;
closing the editor or restarting the app loses them. Editing works offline while
the screen stays open, and **Connect session** reconnects without discarding the
current working copy. The selected file is loaded automatically on the first
successful connection for a target; reconnecting later does not reload it. In
Remote mode, use **Load / Reload** to read the host file again. File operations
require a connection.

Save is last-writer-wins: it does not compare revisions or inspect matching
Neovim buffers. It opens the selected path directly, truncates it, writes the
new YAML, and follows ordinary filesystem symlink behavior. Files in read-only
locations such as the Nix store need an editable destination. Operations run
with the Neovim process user's permissions. If a write fails after truncation,
the file may be incomplete; keep backups or Git history and reload, retry, or
restore the file manually.

Save normalizes YAML formatting and removes handwritten comments.
Keep a Git history if comments or earlier versions matter. The format is:

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

To replace only the invoking group's fixed slot, use both destination IDs:

```yaml
tap:
  type: group
  menuId: delete
  groupId: options
  after: stay
```

Menus, groups, and buttons are ordered lists. Menu IDs are unique throughout
the document, group IDs within each menu, and button IDs within each group.
Menu interactions use `menuId`; group interactions require both `menuId` and
`groupId`. Both destination definitions must exist. Same-menu group links and
cycles composed of menu and group links are rejected. A button needs `tap`,
`longPress`, or both, and must declare one of the five supported `styles.size`
fractions: `'1/1'`, `'1/2'`, `'1/3'`, `'1/4'`, or `'1/5'`. `styles.appearance`
may be `filled` or `outline`; `backgroundColor` and `outlineColor` may be a
case-insensitive `#RRGGBB`, and those two button fields also accept
`transparent`. Shorthand hex, alpha hex, named colours, and `rgb(...)` are
rejected. Optional button fields are `accessibilityLabel` and
`accessibilityHint`. Each interaction has an explicit `after: root` or
`after: stay`. Quote numeric labels and whitespace-sensitive inputs: inputs are
preserved exactly, not trimmed. Only a single YAML 1.2 document is supported,
up to 1 MiB; custom tags, anchors/aliases, unknown fields, and unsupported
versions are rejected.

Button labels may remain scalar strings, which use the regular
size-15 treatment (size 13 while the pad is compact), or use an ordered list of
typography runs. Every run declares `text`, a `fontSize` of `10`, `12`, `15`,
`18`, or `22`, and `bold: true` or `false`; an optional `color: '#RRGGBB'`
overrides the default `#c0caf5` for that run. Unbold runs use the bundled regular
face; bold runs use its bold face. Existing scalar labels and non-bold runs
render in regular rather than semibold, without changing their stored values.
If fonts are unavailable, system weights 400 and 700 are used.
Compact mode maps those sizes to
`9`, `10`, `13`, `16`, and `19` respectively. A run may contain one character,
so per-letter styling does not require offsets into Unicode text:

```yaml
label:
  - text: ' '
    fontSize: 22
    bold: false
  - text: 'Save'
    fontSize: 15
    bold: true
    color: '#9ece6a'
  - text: ' all'
    fontSize: 15
    bold: false
```

Rich labels contain between 1 and 64 runs. Their combined text must not be
blank, although whitespace-only separator runs are allowed. On Android, rich
labels use a native text renderer that automatically aligns each run's
font-box centre, including mixed text and Nerd Font icons. Alignment uses the
font's ascent/descent metrics, not each word or icon's visible outline; an
unusually shaped icon can still look optically different. Text remains one
continuous string with native word wrapping, explicit newlines, Unicode
shaping, and bidirectional layout. Splitting a combining or joined emoji
sequence across differently styled runs retains Android's usual shaping
limitations. Scalar string labels retain the existing React Native renderer.

Buttons remain fixed at 52dp normally or 48dp compact. Rich labels display at
most two complete lines, with native tail ellipsis for omitted text. If two
lines cannot fit, the renderer uses one; it never shrinks the selected run
sizes. At extreme accessibility font scaling, if even one line cannot fit,
only a regular default-size ellipsis (15 normally, 13 compact) is shown if it
fits. If that cannot fit either, the visual label is empty. The full button
accessibility label remains available in every case. Use the editor's shared
Normal/Compact preview to check large or multi-line treatments at either button
width. Colour, italics, custom font families, manual vertical offsets, and
per-run alignment controls are not part of this format. This rendering change
does not change YAML fields, version numbers, or remembered file paths.

This prototype evolves schema version 1 in place. It provides no migration or
implicit size for older YAML: a button without `styles.size` is invalid and must
be updated explicitly before it can be loaded. Older Codey builds reject
version-1 documents that use rich button labels; builds predating group
interactions reject those interactions as well.

**Load only configurations you trust.** A selected Local `init.lua` and its
runtime files are executable code loaded by Neovim at startup. Action Pad input
strings are passed directly to Neovim and can contain commands, including
commands that affect host files or run programs. Loading or editing the Action
Pad YAML never executes those strings; pressing an active input button does.
Configuration authors own
group density, fit, identifiers, and button ordering. The root menu's
Keyboard interaction focuses the Android IME without sending editor input.

Android bundles JetBrainsMono Nerd Font Mono for editor glyphs and all
action-pad text, including Nerd Font private-use characters. The editor and pad
load it independently. The pad retains system typography while its faces are
pending or unavailable; the editor waits for the three upright faces it uses
and falls back to system monospace if that load fails.

Button settings include a run editor and searchable Nerd Font icon picker.
Use **Add run** to append an empty regular size-15 run. Each run has an
**Insert Nerd Font icon…** control: pick an icon to insert it at that run's
remembered cursor position, replacing selected text, or appending if no cursor
position has been recorded. Focus returns to the run with the caret after the
icon. Icons inherit the run's size and Regular/Bold weight, so text and icons
can share one run. For an icon-only run, add an empty run, insert an icon and
choose any preset size (such as 22). Inserting an icon never adds a run and is
still available at the 64-run limit. Text-only edits, including icon insertion,
keep scalar labels as strings; size/weight changes or adding runs enable rich
formatting. **Remove label formatting** joins all text back into one string.
The editor warns without blocking Save when
private-use glyphs lack an explicit accessibility label; set a human-readable
label so a screen reader never has to interpret a Nerd Font code point.

## Touch cursor and software keyboard

A completed single-finger tap on a visible editor cell is translated to a
zero-based `nvim_input_mouse` left-button press. The client passes grid `0`, so
Neovim resolves splits, status lines, and other screen regions from the rendered
screen coordinates. Active Android composition is committed before the mouse
event, preserving input order.

Editor taps only target the Neovim screen: they do not open, refocus, close, or
hide the software keyboard. Use the root action pad's Keyboard button to start
software-keyboard input. If the keyboard is already open, it remains open while
tapping elsewhere in the editor.

Neovim remains authoritative. Codey does not change the `'mouse'` option or
bypass mouse mappings, so a configuration that disables mouse input in the
current mode intentionally disables tap-to-position as well. The current slice
supports completed taps only; drag selection, multi-tap, long-press/right-click,
wheel scrolling, stylus buttons, and multi-touch gestures are not implemented.

## IME compatibility mode

The app-local `CodeyIme` native view accepts `inputMode="terminal"` or
`inputMode="composed"`. Terminal mode is the default used by Codey: it requests
visible-password, no-suggestions, multiline input so coding keystrokes are
committed promptly while still forwarding only committed text to Neovim.
Composed mode remains available to screens that prioritize CJK composition,
swipe input, or autocorrection. This pass deliberately does not expose a user
setting; change the component prop when testing the compatibility mode.

## Run on a physical tablet

Enter the repository's Nix shell and install workspace dependencies:

```sh
nix develop
pnpm install
```

Enable USB debugging on the tablet, attach it, accept the authorization prompt,
and confirm it is visible:

```sh
adb devices
```

Build and install the native development client:

```sh
pnpm android:install
```

For subsequent TypeScript iterations, start the development-client Metro server:

```sh
pnpm android:metro
```

The tablet must be able to reach Metro and the Neovim host. In Codey, use the
host machine's private-LAN address rather than `127.0.0.1`. The connection is
plain unauthenticated TCP and must only be used on a trusted private network.

## Native regeneration and APKs

Expo Continuous Native Generation produces `apps/android/android/`; that folder
is ignored and can be recreated. Kotlin source for the TCP, IME, and rich action
label modules, plus the local NeoVim process module, is tracked under `modules/`.

To assemble the standalone local-NeoVim proof of concept without the Expo
development client:

```sh
pnpm android:poc
```

This checksum-verifies and stages the pinned arm64 bundle, performs a clean POC
prebuild, and assembles
`android/app/build/outputs/apk/release/app-release.apk`. Generated native
binaries, runtime data, package downloads, and the native project remain
untracked.

After changing Expo native configuration (including supported orientations),
native module registration, or Kotlin code, run a clean prebuild and reinstall
the development client. The native rich-label renderer requires a rebuilt
client; refreshing Metro cannot add it to an old APK. An existing APK will
retain its generated manifest until it is rebuilt and reinstalled:

```sh
pnpm android:prebuild
pnpm android:install
```

`pnpm android:test:native` includes the rich-label module's font-metric and
layout tests. Its Robolectric native-graphics tests explicitly use Android API
35, which works with the flake's JDK 17, and read the same font assets shipped
by Metro. Bitmap fixtures are written under
`modules/codey-action-label/android/build/reports/label-fixtures/` for visual
inspection. The minimum-platform compatibility tests use API 30, matching the
local NeoVim build's Android 11 floor. Device-specific visual gaps must be
reported separately from successful JavaScript and native unit tests.

The development profile in `eas.json` produces an installable Android APK. EAS
CLI is supplied by the flake. A local debug APK can be assembled directly with:

```sh
pnpm android:assemble
```

Its output is under `android/app/build/outputs/apk/debug/`.

For a locally bundled release APK, independent of Metro, use:

```sh
pnpm android:install:release
pnpm android:assemble:release
```

The release APK is written under `android/app/build/outputs/apk/release/`.
Benchmark instructions and the opt-in diagnostics flag are documented in
[`docs/performance.md`](../../docs/performance.md).

## Verification

From the repository root, `pnpm check` verifies both clients. Android-specific
commands are also exposed separately:

```sh
pnpm android:doctor
pnpm android:bundle
pnpm android:test
pnpm android:prebuild
pnpm android:test:native
pnpm android:assemble
pnpm android:assemble:release
```

The native tests and debug assembly require a generated `android/` tree, so run
the clean prebuild first when invoking those commands independently. No Android
Studio, emulator, or system image is required or included in the Nix shell.

The Android suite includes frozen baselines for all 12 starter menus,
YAML validation/round trips, editing operations, in-memory discard and direct
write cases, input isolation, and the complete Load → Edit → Save → Reload UI flow.
The shared host-document suite launches isolated `nvim --embed --headless`
processes and uses temporary files. It runs when `nvim` is on `PATH`, or when
`CODEY_NVIM_BIN` names a Neovim binary:

```sh
CODEY_NVIM_BIN=/path/to/nvim pnpm exec vitest run packages/nvim-session/test/host-documents.live.test.ts
```

For physical-tablet acceptance, use a temporary host YAML file and verify:

1. Navigate to a nested menu, tap **Edit Action Pad**, and confirm pencil markers
   appear. Tap or hold a button and confirm its whole-button editor opens
   without running its configured actions. Close the editor and confirm
   selection mode and the current menu remain. Check that **Done editing** and
   Android Back each exit selection mode, and a `450ms` hold on **Edit Action Pad**
   opens the general editor directly.
2. Open **Manage menus** and confirm the configured root is marked Root, menus
   reachable through Tap/Hold Menu and Group actions are marked Reachable, and
   a disconnected menu is marked Unused. Create duplicate menu labels and
   confirm IDs keep menu rows and references distinguishable.
3. Remove a visible button that launches a menu. Confirm the launcher disappears
   but its destination definition remains in Manage menus and relevant pickers.
   Delete an unreferenced non-root menu individually and confirm it disappears
   immediately from menu selectors, Tap/Hold destination pickers, Group
   destination pickers, and move destinations.
4. Attempt to delete a referenced menu. Confirm deletion is disabled and every
   incoming reference identifies the source menu/group/button, Tap or Hold, and
   Menu or Group action. Select each kind of reference and confirm the editor
   navigates and scrolls to that exact interaction. Remove the references, then
   confirm individual deletion succeeds; Root must remain protected.
5. Create a disconnected subtree whose unused menus reference one another. Run
   **Remove unused menus**, inspect and cancel the first confirmation, then
   confirm it on the second attempt. Verify the complete disconnected set is
   removed together while Root and all Reachable menus and links are unchanged.
6. Before saving menu deletions, choose **Discard and close** and confirm the live
   pad and host YAML still use the previous definitions. Reopen the editor and
   confirm the discarded cleanup is gone. Repeat the cleanup, Save, reload, and
   reopen the app; confirm deleted menus remain absent from the YAML, manager,
   all pickers, and live Action Pad.
7. Load the starter and build a mixed label with a size-22 icon plus bold and
   regular text runs, giving individual runs Green and Yellow font colours.
   Insert an icon at a cursor and over selected text in an
   existing run; check that its size/weight are preserved and the caret returns
   after it. Add an empty run and insert an icon to make an icon-only run.
   Reorder a run; check both Normal and Compact previews;
   exercise Whole, Half, Third, Quarter, and Fifth widths; compare Filled and
   Outline appearances and custom/transparent button colours; then Save and
   reload. Confirm the YAML retains every run and the active pad renders the
   same treatment in ordinary and selection modes. Confirm invalid custom hex
   remains visible while the editor stays open but blocks Save. Check a size-22 icon beside
   size-10/12/15 text
   in both orders: their font-box centres should align. Check word wrapping
   across runs, explicit newlines, and height-aware ellipsis without partial
   second lines or shrunken text. Increase Android font scaling, test fallback
   fonts, and check that TalkBack announces the complete button label exactly
   once even when the visible label is shortened.
8. In Local mode, confirm the editor shows only the read-only
   `<config-folder>/action-pad.yaml` destination and Save, with no Browse, Clear,
   or Load control. In Remote mode, change the path and Save; confirm the new
   file becomes the remembered path, then load the prior path to switch back.
9. Change the selected file outside Codey and Save. Confirm Codey overwrites it
   as last writer. Simulate a write failure and confirm the working copy remains
   open while recovery is left to Reload, retry, or restoring a manual backup.
10. Disconnect, edit, and reconnect from inside the still-open editor. Confirm
    the in-memory edits remain and are not written until Save. Then discard and
    close, reopen, and restart; confirm the discarded edits do not return.
11. Repeat at the `800x600dp` condensed and `1280x800dp` expanded landscape
   baselines, including the software keyboard. Confirm forms remain reachable
   and typing in them never changes the Neovim buffer. After leaving the editor,
   check the pad's tap/hold behavior and the normal Neovim IME. Rotate to
   portrait and confirm the unsupported screen replaces and disconnects the
   client; rotate back and confirm a fresh disconnected client appears.
