# Codey

Codey is an Android tablet client for a bundled Neovim runtime. Neovim remains
the editor: it owns buffers, modes, mappings, selections, cursor state, plugins,
and undo history. Codey starts one app-scoped `nvim --embed` process and renders
its line-grid UI with Skia.

```text
Android UI + IME
  -> NvimSessionClient
  -> MessagePackRpcClient
  -> ExpoNvimProcessTransport
  -> CodeyNvim native module
  -> bundled nvim --embed
       stdin  <- MessagePack-RPC requests
       stdout -> MessagePack-RPC responses and notifications
       stderr -> bounded diagnostic tail
```

There is no editor network listener, discovery service, or background daemon.
The child process stops with the app session.

## Supported device and window

The current native runtime is deliberately narrow:

- Android 11 / API 30 or newer;
- `arm64-v8a` devices;
- a landscape window wider than it is tall;
- a shortest active window side of at least `600dp`.

Windows below `840dp` wide use the condensed tablet shell; wider windows use
the expanded shell. At every supported width, compact **Set Workspace** and
**Set Config Directory** controls share one toolbar row without permanently
displaying either path. The current mode and Action Pad breadcrumb sit in a
footer beneath the editor, leaving the fixed `336dp` right-hand Action Pad rail
more vertical room without changing its button sizes. Unsupported windows never
construct an editor session.

Before starting Neovim, grant Android's all-files permission and choose two existing
directories:

- a writable workspace, used as Neovim's working directory; and
- a readable, writable Neovim config directory.

The config directory may contain `init.lua` and normal `lua/`, `plugin/`, and
`after/` children. Codey starts Neovim with `--clean` when there is no readable
`init.lua`. The Action Pad configuration has one fixed location:
`<config-directory>/action-pad.yaml`.

The optional single-file Codey Kickstart variant is paired with an APK-bundled
toolchain: Git over HTTPS, ripgrep, StyLua, Lua Language Server, and a pinned
eleven-language Tree-sitter set. It does not assume a general Unix userland or
download native executables at runtime; see the bundled runtime guide for the
exact supported and intentionally absent commands.

## Development environment

The checked-in Nix flake provides Node.js, pnpm, Neovim, JDK 17, ADB, Android
platform/build-tools 36, NDK `27.1.12297006`, CMake `3.22.1`, Watchman, and EAS
CLI:

```sh
nix develop
pnpm install
```

Generated Neovim binaries and runtime data are not committed. Attach an
authorized physical tablet, then install the development client and start
Metro. The install command stages the checksum-pinned runtime and regenerates
a clean development-profile Android project first:

```sh
adb devices
pnpm android:install
pnpm android:metro
```

Native configuration, Kotlin, or native-library changes require another clean
prebuild and reinstall. TypeScript-only changes can use the existing client and
Metro session.

To stage the runtime or regenerate the development native project without
installing it, use `pnpm android:prepare:nvim` or `pnpm android:prebuild`.

To build the standalone release APK, including runtime preparation and a clean
native generation:

```sh
pnpm android:apk
```

The APK is written to
`apps/android/android/app/build/outputs/apk/release/app-release.apk`. The
current local signing fallback is suitable for personal sideloading, not public
release identity.

See the [Android client guide](apps/android/README.md) and
[bundled runtime guide](apps/android/native-runtime/README.md) for details.

## Verification

Run the complete repository check from the Nix shell:

```sh
pnpm check
```

Useful Android checks are:

```sh
pnpm android:doctor
pnpm android:bundle
pnpm android:test
pnpm android:prebuild
pnpm android:test:native
pnpm android:assemble
pnpm android:assemble:release
```

The generated `apps/android/android/` directory is disposable. Native module
source is tracked under `apps/android/modules/`.

## Security boundary

Local stdio removes a network-facing Neovim endpoint; it does not make Neovim
or user configuration a sandbox. A selected `init.lua`, plugins, Action Pad
commands, Lua, `system()`, and `:!` execute with the Android app UID. With
all-files access, that UID can reach broad shared-storage content. Select only
trusted workspaces, config directories, files, plugins, and Action Pad YAML.

The Android manifest intentionally retains `INTERNET`. Development clients use
it for Metro and Expo services, while configured Neovim sessions can use it
through child commands—for example, bundled Git/libcurl fetches Kickstart
plugins over HTTPS. Codey does not use that permission for editor transport;
Neovim RPC remains on the child process's app-owned file descriptors.

The directory browser is limited to primary shared storage and works with real
filesystem paths. It does not turn Storage Access Framework `content://` URIs
into paths, enumerate cloud providers, or provide a filesystem sandbox.

See the [architecture notes](docs/architecture.md) for component boundaries and
the [performance guide](docs/performance.md) for device benchmarking. Codey is
licensed under [Apache-2.0](LICENSE); bundled runtime dependencies are listed in
[third-party notices](THIRD_PARTY_NOTICES.md).
