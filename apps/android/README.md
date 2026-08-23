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

The action tree is configured as named `leading` and `trailing` button groups.
In portrait and square windows, each group flows across two rows; the leading
group anchors left and the trailing group right. In landscape, each group flows
across two columns; the leading group anchors to the top and the trailing group
to the bottom of a shared vertical scroll area. The root menu keeps common
native keys available and links to menus such as navigation, Leader, Search,
and Cmd. Entering a menu replaces the visible buttons with that menu's choices,
adds a generated Back button as the final trailing action, and shows the current
path as a breadcrumb. Disconnecting resets the pad and disables its controls.

Up and Down are dual-purpose controls: tap to send one arrow key, or hold for
`450ms` to open the corresponding navigation menu. A successful hold suppresses
the tap. Navigation actions keep their menu open for repeated movement; other
leaf actions normally return to the root. Each leaf dispatches its complete
Neovim input sequence in one ordered operation, after any active Android IME
composition has been committed.

When the software keyboard reduces the window height by at least `120dp`, the
pad switches to its compact treatment while preserving `48dp` touch targets.
The landscape groups remain vertically scrollable when the keyboard leaves too
little height for every action. The editor and toolbar also relax their minimum
heights so the 800 × 600dp condensed tablet layout does not overflow.

The bundled action tree is a typed TypeScript configuration in
`src/action-pad/config.ts`. `src/action-pad/index.ts` exports the `ActionPad`,
the configured root menu, the validator, and the public menu/button types. The
model covers native special keys, one-shot Ctrl, submenu branches, trusted raw
Neovim input sequences, dual tap/hold controls, explicit leading/trailing
groups, and the per-menu `afterInput` policy (`root` or `stay`). Keep configured
sequences in the application bundle: they are trusted code and are passed
directly to Neovim's input API, so the app does not load action trees from the
network or accept untrusted user-authored sequences. Ordinary configuration
changes need only a TypeScript reload or rebuild.

Native-key actions accept the canonical Android/DOM-style names exported by
`src/input.ts` (for example `Escape`, `ArrowUp`, and `F1`); startup validation
rejects aliases such as `Esc` before a button can silently dispatch nothing.

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
