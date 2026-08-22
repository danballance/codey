# Codey

Codey is a small remote Neovim client. Neovim remains the editor: it owns the
buffers, modes, mappings, selections, cursor, plugins, and undo history. Codey
connects to Neovim's native MessagePack-RPC endpoint and projects its line-grid
UI into a platform renderer.

The repository contains two end-to-end clients over the same shared protocol
and editor-state packages:

```text
apps/
  desktop/       Electron client with an HTML canvas renderer
  android/       Expo development client for landscape Android tablets
packages/
  transport/     Platform-neutral byte-stream contract and Node TCP adapter
  msgpack-rpc/   Streaming MessagePack-RPC client
  nvim-session/  Typed Neovim UI facade
  editor-core/   Platform-neutral redraw reducer and grid state
```

The Android path uses a Skia renderer, an Android IME view, and a local Expo
Kotlin TCP module. Phones remain installable, but a window whose shortest side
is below `600dp` only shows the unsupported-device explanation and cannot open
a Neovim session. The primary design target is a 12–14-inch tablet in landscape
with at least `840dp` of window width.

## Development environment

The checked-in Nix flake is the supported host environment:

```sh
nix develop
pnpm install
```

It provides Node.js, pnpm, Neovim, the Electron runtime libraries, and the
Android host toolchain: JDK 17, Watchman, ADB/platform tools, EAS CLI, Android
platform and build-tools 36, NDK `27.1.12297006`, and CMake `3.22.1`. Android
SDK licences are accepted declaratively by the flake. npm packages and Maven
artifacts are still resolved by pnpm and the Gradle wrapper from the checked-in
project metadata.

## Desktop client

Start a local endpoint and the Electron client:

```sh
nvim --clean --headless --listen 127.0.0.1:6666
pnpm dev
```

Enter `127.0.0.1` and `6666` in the connection bar. Once connected, click the
editor canvas and use Neovim normally.

## Android tablet development client

Use a physical Android tablet with developer options and USB debugging enabled.
The device and development host must also be able to reach each other on a
trusted private LAN.

Check the USB connection, then build and install the development client:

```sh
adb devices
pnpm android:install
```

For later JavaScript/TypeScript iterations, start Metro for the installed
development client with:

```sh
pnpm android:metro
```

The app is Android-only and requests landscape, including Android 16's temporary
large-screen compatibility mode. A runtime gate still rejects portrait windows
if the platform or device policy overrides that request. Use the development
host's private-LAN address in the connection toolbar; `127.0.0.1` on the tablet
means the tablet itself. Start Neovim on that concrete host address, for example:

```sh
nvim --clean --headless --listen 192.168.1.20:6666
```

Changes to Expo native configuration or native modules require a native
regeneration and reinstall:

```sh
pnpm android:prebuild
pnpm android:install
```

The generated `apps/android/android/` tree is disposable and ignored. The local
Expo modules under `apps/android/modules/` are source-controlled.

See [the Android client guide](apps/android/README.md) and
[host setup](docs/host-setup.md) for physical-device and LAN details.

## Verification

Run the complete desktop and Android verification from the Nix shell:

```sh
nix develop -c pnpm check
```

This runs TypeScript checks, shared Vitest tests, Android Jest tests, the
production Electron build, Expo Doctor, an Android Metro export, a clean native
prebuild, Kotlin unit tests, and `assembleDebug`. The resulting development APK
is under `apps/android/android/app/build/outputs/apk/debug/`.

Individual Android checks are also available:

```sh
pnpm android:doctor
pnpm android:bundle
pnpm android:test
pnpm check:android:native
```

With a clean Neovim endpoint already listening on loopback, the optional desktop
live test exercises the full TCP → RPC → session → redraw-reducer path:

```sh
CODEY_NVIM_PORT=6666 pnpm test:live-nvim
```

## Prototype security boundary

Treat the Neovim RPC port like shell access to the host account. This prototype
has no authentication or encryption. Do not expose it to the internet, add
router port forwarding, bind it to `0.0.0.0`, or use it on an untrusted network.
Restrict the port to the tablet address or trusted subnet with the host firewall
where practical.

See [the architecture notes](docs/architecture.md) for the component boundaries
and current limitations.
