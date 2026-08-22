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

- Landscape is the only supported orientation.
- The shortest active window side must be at least `600dp`.
- Windows from `600dp` through `839dp` wide use the condensed tablet shell.
- Windows at least `840dp` wide use the large-tablet shell; approximately
  `1280x800dp` is the visual-QA baseline.
- Phones may install the APK, but an unsupported window cannot construct or
  connect an editor session.

If multi-window resizing takes a connected editor below the minimum, the app
disconnects safely before showing the unsupported-device explanation. Android
16 builds also opt into the platform's temporary fixed-orientation compatibility
mode so the tablet opens in landscape. The runtime landscape gate remains in
place because Android 17 removes that compatibility opt-out and device policy
may still override an orientation request.

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

After changing Expo native configuration or native module registration, run:

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

## Verification

From the repository root, `pnpm check` verifies both clients. Android-specific
commands are also exposed separately:

```sh
pnpm android:doctor
pnpm android:bundle
pnpm android:test
pnpm android:prebuildey' is dirty
ey' is dirty

pnpm android:test:native
pnpm android:assemble
```

The native tests and debug assembly require a generated `android/` tree, so run
the clean prebuild first when invoking those commands independently. No Android
Studio, emulator, or system image is required or included in the Nix shell.
