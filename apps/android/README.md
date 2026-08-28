# Android tablet client

This app is an Android-only Expo SDK 57 development client for Codey. It proves
the mobile vertical slice while reusing the existing `transport`, `msgpack-rpc`,
`nvim-session`, and `editor-core` contracts:

```text
Skia + Android IME
  -> NvimSessionClient
  -> MessagePackRpcClient
  -> ExpoTcpTransport
  -> local Expo Kotlin TCP module
  -> Neovim
```

## Supported screen contract

- Portrait, landscape, and square tablet windows are supported.
- The shortest active window side must be at least `600dp`.
- Windows from `600dp` through `839dp` wide use the condensed tablet shell.
- Windows at least `840dp` wide use the large-tablet shell; approximately
  `1280x800dp` is the visual-QA baseline.
- Phones may install the APK, but an unsupported window cannot construct or
  connect an editor session.

If multi-window resizing takes a connected editor below the minimum, the app
disconnects safely before showing the unsupported-device explanation. The app
does not request a fixed orientation, so rotating or resizing a supported tablet
reflows the existing editor session instead of reconstructing it.

## Adaptive workspace and dynamic action pad

In portrait and square windows, the command area remains below the editor. In
landscape, the editor uses the available vertical space while the action pad
moves into a fixed `336dp` rail to its right. The full-width connection toolbar
stays above both. The same action pad remains mounted across rotations, so its
active menu and input state survive the layout change.

Each menu contains an ordered array of arbitrarily named button groups. In
portrait and square windows, every group flows across two rows and the groups
share the available width in declaration order. In landscape, every group flows
through left-aligned fractional rows in a shared vertical scroll area; the
default half-sized buttons form two columns. The first group is placed at the
top, the last at the bottom, and any intermediate groups are distributed between
them. Group names have no layout meaning.

A button may set the semantic `styles.size` value to `"1/4"` or `"1/2"`.
This currently affects only the landscape rail, where an omitted value defaults
to `"1/2"`. Half and quarter buttons map to `48%` and `22%` widths with a `4%`
column gap, so two halves, four quarters, or one half and two quarters pack a
row. The below-editor layout ignores the value and keeps its existing two-row
flow. `styles` is a small action-pad contract, not an unrestricted React Native
style passthrough.

Buttons configure generic `tap` and `longPress` interaction slots, with at least
one interaction present. An interaction may send direct Neovim input, open a
menu, go Back, or focus the Android software keyboard, and independently chooses
whether the menu stack returns to the root or stays where the interaction left
it. The bundled Up and Down buttons demonstrate composition of these primitives:
tap sends `<Up>` or `<Down>`, while a `450ms` hold opens the corresponding
navigation menu and suppresses the release tap. Entering a menu replaces the
visible groups and shows its breadcrumb. Back is an ordinary configured button,
so it appears only where the configuration places it. Disconnecting resets the
pad and disables its controls.

Every input interaction dispatches its complete Neovim notation in one ordered
operation, after any active Android IME composition has been committed. Buttons
in navigation menus use `after: 'stay'` for repeated movement, while one-off
command buttons use `after: 'root'`.

When the software keyboard reduces the window height by at least `120dp`, the
pad switches to its compact treatment while preserving `48dp` touch targets.
The landscape groups remain vertically scrollable when the keyboard leaves too
little height for every action. The editor and toolbar also relax their minimum
heights so the 800 × 600dp condensed tablet layout does not overflow.

The starter configuration is `src/action-pad/default.yaml`: one versioned YAML
document containing all 12 menus. The app validates it using the same parser as
external configurations. No menu definitions are maintained in TypeScript.
`src/action-pad/index.ts` exports the renderer, default configuration, document
parser/validator/serializer, and menu, group, button, and interaction types.
Special keys and modified keys use Neovim notation, such as `<Esc>`, `<Up>`, and
`<C-r>`.

### Editing and saving Action Pad configuration

Navigate to the menu you want to refine, then tap **Edit Action Pad**, below
the pad. The visible buttons gain pencil markers; tap anywhere on a button to
open its editor with that menu, group, and button selected. Both taps and holds
select a button in this mode. Configured input, menu, Back, and keyboard actions
are suppressed, so navigate to the desired menu before entering selection mode.

Closing the editor keeps selection mode enabled and preserves the current menu.
Use **Done editing** or Android Back while the pad is visible to exit selection
mode and restore normal button actions. A successful **Save** or **Load / Reload**
still resets the active pad to its root menu.

Hold **Edit Action Pad** for `450ms` to open the general configuration editor
directly, without entering selection mode. Holding **Done editing** opens the
same editor while keeping selection mode enabled. The control also exposes an
**Open full Action Pad editor** accessibility action. It is not part of the YAML
and remains available even if every configured button is removed or the host is
disconnected. The general editor includes menus, groups, buttons, duplication,
ordering/move controls, all button properties, and a preview. The preview can
navigate menus but never sends commands or opens the Neovim keyboard. The
existing Neovim session remains mounted while ordinary form inputs own keyboard
focus.

The primary YAML file lives on the connected Neovim host, not on Android.
Choose an absolute host path or a path beginning with `~/`. The suggested path
is `stdpath("config")/codey/action-pad.yaml`; use a file in your dotfiles or Git
repository if preferred. The app remembers the active path with its endpoint.
No additional host service, plugin, SSH connection, or Android storage
permission is needed.

- **Load / Reload** validates a file before replacing the active pad and draft.
  Invalid files leave both unchanged. Loading over unsaved edits requires
  confirmation.
- **Save** validates the draft, updates the active host file, and only then
  activates the configuration. The first Save creates a missing file and its
  parent directories; startup and reads never create files. Once a file is
  active, Load another file to switch or Export to create a separate copy.
- **Export copy** writes the current valid draft to another host path. Existing
  destinations require confirmation. Export does not change the active file,
  activate the draft, or mark the draft saved.
- **Cancel** offers to discard edits, keep editing, or **Keep draft & close**.
  Keeping a draft lets you return later without changing the active pad.
  Neither closing nor discarding writes a host file.

The app keeps the last valid configuration and incomplete drafts in local
recovery storage. Editing works offline; host operations require a connection.
Use **Connect host** inside the editor to reconnect without discarding edits.
Reconnecting refreshes a clean configuration but never silently replaces an
unsaved draft or uploads it. If a Save response is lost, the next explicit Save
reads the host file to reconcile the attempt before writing again.

External changes cause a conflict instead of an overwrite: Reload the host
version or Export your draft elsewhere. Saves preserve ordinary file
permission mode bits and symlinks and refuse to overwrite a matching Neovim buffer with
unsaved changes. Files in read-only locations such as the Nix store need an
editable destination. Operations run with the Neovim process user's permissions.
Atomic replacement creates a new inode; owner/group, ACLs, extended attributes,
and other hard links are not preserved. Use an ordinary user-owned YAML file.

Save and Export normalize YAML formatting and remove handwritten comments.
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
            tap:
              type: input
              nvimInput: '<Esc>'
              after: root
```

Menus, groups, and buttons are ordered lists. Menu IDs are unique throughout
the document, group IDs within each menu, and button IDs within each group.
Menu interactions use `menuId`; their targets must exist and references must
not form cycles. A button needs `tap`, `longPress`, or both. Optional button
fields are `accessibilityLabel`, `accessibilityHint`, and
`styles: { size: '1/4' }` or `styles: { size: '1/2' }`. Each interaction has an
explicit `after: root` or `after: stay`. Quote numeric labels and
whitespace-sensitive inputs: inputs are preserved exactly, not trimmed.
Only a single YAML 1.2 document is supported, up to 1 MiB; custom tags,
anchors/aliases, unknown fields, and unsupported versions are rejected.

**Load only configurations you trust.** Input strings are passed directly to
Neovim and can contain commands, including commands that affect host files or
run programs. Loading, editing, and previewing a configuration never executes
those strings; pressing an active input button does. Configuration authors own
group density, fit, identifiers, and navigation placement. The root menu's
Keyboard interaction focuses the Android IME without sending editor input.

Android bundles JetBrainsMono Nerd Font Mono for editor glyphs and all
action-pad text, including Nerd Font private-use characters. The editor and pad
load it independently. The pad retains system typography while its faces are
pending or unavailable; the editor waits for its four faces and uses system
monospace if that load fails.

Button settings include a searchable Nerd Font icon picker. Choosing an icon
inserts its glyph at the current label cursor or replaces the selected label
text; the YAML format remains unchanged because the glyph is stored directly
in `label`. Set an explicit accessibility label when a button is icon-only.

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
is ignored and can be recreated. Kotlin source for the TCP and IME modules is
tracked under `modules/`.

After changing Expo native configuration (including supported orientations),
native module registration, or the Kotlin IME bridge, run a clean prebuild and
reinstall the development client. An existing APK will retain its generated
manifest until it is rebuilt and reinstalled:

```sh
pnpm android:prebuild
pnpm android:install
```

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

The Android suite includes frozen migration baselines for all 12 starter menus,
YAML validation/round trips, editing operations, recovery and conflict cases,
input isolation, and the complete Load → Edit → Save → Reload → Export UI flow.
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
2. Load the starter, change a label/input/size, create and move a button, then
   Save. Confirm the host file changed and the active pad returns to its root.
3. Reload, then Export to a different path. Confirm the source stays linked;
   exporting a later unsaved edit must not activate it or clear its dirty state.
4. Change the source outside Codey and try Save. Confirm the app offers Reload
   or Export without overwriting the external change.
5. Disconnect, edit, and choose **Keep draft & close**. Reopen/restart and
   reconnect; the draft must remain local until an explicit Save.
6. Repeat in portrait and landscape, including the smallest supported tablet
   window with the keyboard visible. Confirm forms remain reachable and
   typing or previewing never changes the Neovim buffer. After leaving the
   editor, check the pad's tap/hold behavior and the normal Neovim IME.
