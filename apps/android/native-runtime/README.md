# Bundled Neovim runtime

Codey packages an arm64 Neovim executable, its dependent shared libraries, and
the Neovim runtime data inside the Android app. At run time, the native module
starts one app-scoped `nvim --embed` child process and carries MessagePack-RPC
over its stdin/stdout file descriptors. Stderr is drained separately into a
bounded diagnostic tail.

This directory contains the checksum lock and licence input for that bundle. It
does not contain generated binaries.

## Current scope

- Android 11 / API 30 or newer.
- `arm64-v8a` only.
- One Neovim process per app session.
- One user-selected absolute workspace directory.
- One user-selected absolute Neovim config directory.
- A fixed Action Pad file at `<config-directory>/action-pad.yaml`.
- App-private HOME, data, state, cache, temporary, and extracted runtime paths.

The native directory browser covers primary shared storage. Manual absolute
paths remain available, but Storage Access Framework `content://` URIs are not
filesystem paths and are not converted.

When the config directory has no readable `init.lua`, Codey launches
`nvim --clean --embed`. When it has one, the directory becomes Neovim's real
config root through `XDG_CONFIG_HOME` and `NVIM_APPNAME`; the normal `lua/`,
`plugin/`, and `after/` children participate in the runtime path. Existing
`init.lua` must be a readable regular file, and startup configuration errors
fail the connection.

The executable is launched directly. There is no intermediary shell, listener,
service, or daemon, and the child is stopped when its app session closes.

## Prepare the runtime

From the repository root inside `nix develop`:

```sh
pnpm android:prepare:nvim
```

The equivalent Android-package command is:

```sh
cd apps/android
pnpm run prepare:nvim
```

`scripts/prepare-nvim.sh` reads `termux-packages.lock`, downloads the pinned
official Termux arm64 packages into an ignored cache, and verifies every SHA-256
checksum. It then:

1. extracts Neovim and its dependent shared libraries;
2. renames the executable to `libcodey_nvim.so` for Android packaging;
3. patches every runpath to the APK native-library directory;
4. verifies arm64 ELF type, dynamic linker, dependency closure, absence of text
   relocations and Termux runpaths, and 16 KiB load alignment;
5. creates a deterministic runtime-data archive and checksum metadata; and
6. stages bundled licence texts and third-party notices.

Generated JNI libraries and assets live under the `codey-nvim` module's ignored
build inputs. Downloaded packages and the generated Android project are also
ignored by Git.

## Build the standalone APK

From the repository root:

```sh
pnpm android:apk
```

Or from `apps/android`:

```sh
pnpm run build:apk
```

The build command prepares the runtime again, sets the `standalone` build
profile, generates a clean native Expo project without the development client,
and assembles:

```text
apps/android/android/app/build/outputs/apk/release/app-release.apk
```

Install it on an arm64 Android 11+ device, grant all-files access, select an
existing writable workspace and readable/writable config directory, and press
**Start**. Directory selection saves settings but does not start Neovim.

The ordinary local debug signing fallback is suitable for a personal sideload,
not public release identity. Do not redistribute that APK until the publication
requirements below are complete.

## Runtime integrity and lifecycle

Android extracts the packaged executable and dependent shared libraries. Codey
checksum-verifies the runtime-data archive, rejects unsafe archive paths and
symbolic links, and installs it into a versioned app-private directory. Runtime
data is not executable; only the packaged native-library executable is run.

The native process manager assigns a monotonically increasing session ID.
Writes and data/exit events carry that identity so late events cannot cross
session generations. Kotlin owns blocking stdin/stdout I/O, serializes writes,
and drains stdout and stderr concurrently. Closing stdin requests termination;
cleanup escalates after a bounded wait and is idempotent.

## Filesystem and configuration security

Android all-files access is retained because Neovim, Git, plugins, configuration,
and shell commands need real filesystem paths. The app manifest also retains
`INTERNET` for Metro/Expo development services and possible future app features;
Neovim's editor session itself uses only the child-process file descriptors.

Neither `--clean` nor configured startup is a sandbox. A selected `init.lua`,
plugins, Action Pad commands, Lua, `system()`, and `:!` execute with the Android
app UID. They can access anything available to that UID, including files covered
by all-files access. Select only trusted config folders, workspaces, files,
plugins, and Action Pad YAML.

The Action Pad editor reads and writes the fixed YAML path through the running
Neovim RPC session. Writes truncate the destination before streaming the new
contents, so an I/O failure after the write begins may leave an incomplete file.
Keep important configuration in version control or maintain a backup.

## Publication requirements

The pinned Termux binaries are a temporary, auditable supply-chain input for
personal builds. Before a public or F-Droid release:

- build Neovim and every native dependency from source in a reproducible recipe;
- retain corresponding source archives, notices, and LGPL relinking materials;
- add F-Droid metadata and reproducibility checks;
- establish a stable release signing process;
- audit lifecycle and storage behavior on supported physical devices; and
- decide whether broad all-files access remains acceptable or a separate
  workspace backend is required.

See the repository [third-party notices](../../../THIRD_PARTY_NOTICES.md) for
the pinned component versions and licences.
