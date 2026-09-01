# Codey

Codey is a small Neovim client. Neovim remains the editor: it owns the
buffers, modes, mappings, selections, cursor, plugins, and undo history. Codey
connects to Neovim's native MessagePack-RPC endpoint and projects its line-grid
UI into a platform renderer. Android can either start the bundled local
NeoVim proof of concept or connect to an existing remote TCP endpoint.

The repository contains two end-to-end clients over the same shared protocol
and editor-state packages:

```text
apps/
  desktop/       Electron client with an HTML canvas renderer
  android/       Expo development client for Android tablets
packages/
  transport/     Platform-neutral byte-stream contract and Node TCP adapter
  msgpack-rpc/   Streaming MessagePack-RPC client
  nvim-session/  Typed Neovim UI facade
  editor-core/   Platform-neutral redraw reducer and grid state
```

The Android path uses a Skia renderer, an Android IME view, and local Expo
Kotlin modules for TCP and the bundled process. Phones remain installable, but a window whose shortest side
is below `600dp`, or is not wider than it is tall, only shows the
unsupported-device explanation and cannot open a Neovim session. Supported
landscape windows place the action pad in a scrollable right-hand rail. Ordered
base groups keep fixed rail-capacity envelopes. A configured group action can
temporarily replace only its invoking slot without moving siblings or changing
scroll extent, while Cmd, Leader,
Search, Window, and Code remain whole-page navigation. The header distinguishes
the page path from the one active transient cluster. The primary design target
remains a 12–14-inch tablet. A completed editor tap is forwarded through
Neovim's native mouse API to position the cursor; the configured Keyboard
interaction opens the Android software keyboard.

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

The app is Android-only and requires a landscape tablet window. Use the
**Remote** tab with the development host's private-LAN address;
`127.0.0.1` on the tablet means the tablet itself. Start Neovim on that concrete
host address, for example:

```sh
nvim --clean --headless --listen 192.168.1.20:6666
```

The personal arm64 Android 11+ proof-of-concept APK can instead start its own
NeoVim process. Build it with `pnpm android:poc`, then select **Local**, grant
Android all-files access, and choose an existing writable workspace and Neovim
config folder before connecting.
See [the bundled NeoVim POC guide](apps/android/native-poc/README.md) for its
scope, binary provenance, and the work intentionally deferred before F-Droid.

Changes to Expo native configuration, including orientation support, or native
modules require a clean native regeneration and reinstall. The installed APK
does not pick up these changes from Metro alone:

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
prebuild, Kotlin unit tests, and both debug and release assembly. Generated APKs
are under `apps/android/android/app/build/outputs/apk/`.

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

Local mode removes the network endpoint, not Neovim's command power. A config
folder is required before connecting. Neovim starts with `--clean` when that
folder has no `init.lua`; otherwise that Lua and normal config runtime files
execute automatically.
Neither mode is a sandbox: commands, Lua, `system()`, and `:!` run with the
Android app UID and can access files covered by the app's all-files grant. Use
trusted Local config folders, files, and Action Pad configurations.

See [the architecture notes](docs/architecture.md) for the component boundaries
and current limitations. Codey source is available under [Apache-2.0](LICENSE);
bundled proof-of-concept dependencies are listed in
[third-party notices](THIRD_PARTY_NOTICES.md).
