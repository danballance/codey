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
across two columns in a shared vertical scroll area; the first group is placed
at the top, the last at the bottom, and any intermediate groups are distributed
between them. Group names have no layout meaning.

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

The bundled action tree is a typed TypeScript configuration in
`src/action-pad/config.ts`. `src/action-pad/index.ts` exports the `ActionPad`,
the configured root menu, and the public menu, group, button, and interaction
types. The small model covers ordered named groups and reusable input, menu,
Back, and Keyboard interactions for tap or long press. Special keys and modified
keys are written directly in Neovim notation, such as `<Esc>`, `<Up>`, and
`<C-r>`.

Keep configured sequences in the application bundle: they are trusted code and
are passed directly to Neovim's input API, so the app does not load action trees
from the network or accept untrusted user-authored sequences. Configuration
authors own group density, fit, identifiers, and navigation placement. Ordinary
configuration changes need only a TypeScript reload or rebuild. The root menu's
Keyboard interaction focuses the Android IME without sending editor input.

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
