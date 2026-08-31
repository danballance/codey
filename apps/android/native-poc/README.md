# Bundled NeoVim proof of concept

This is the deliberately narrow first implementation of local NeoVim on
Android. It produces a personal, sideloadable APK; it is not yet an F-Droid
recipe or a production release pipeline.

## Scope

- Android 11 / API 30 or newer.
- `arm64-v8a` only.
- One app-scoped `nvim --clean --embed` process at a time.
- MessagePack-RPC over the child process's stdin/stdout, with stderr retained
  only as a bounded diagnostic tail.
- A user-selected absolute workspace path, using Android all-files access. The
  native browser covers primary shared storage only; the editable field remains
  available for manually entered filesystem paths.
- Existing remote TCP mode remains available and unchanged at the protocol
  layer.

The executable and dependent DSOs are checksum-pinned official Termux arm64
packages. The build script renames NeoVim to `libcodey_nvim.so`, patches its
runpath to the APK native-library directory, checks the complete DSO closure,
checks 16 KiB ELF load alignment, and packages the runtime as verified private
data. Generated binaries and downloaded packages are ignored by Git.

## Build

From the repository's Nix development shell:

```sh
pnpm android:prepare:nvim:poc
pnpm android:poc
```

The second command prepares the artifacts again, creates a clean native Expo
project without the development client, and writes the release APK to:

```text
apps/android/android/app/build/outputs/apk/release/app-release.apk
```

The Gradle release build uses the ordinary local debug signing fallback unless
you explicitly configure another signing key. This is suitable for a personal
proof of concept, not a public release identity. Do not redistribute this POC
APK; the source-build, LGPL compliance, and signing work below is a publication
gate.

## Install and use

Install the APK on an arm64 Android 11+ device, choose **Local**, grant the
all-files permission when prompted, and use **Browse** to choose an existing
writable directory below `/storage/emulated/0`. Selection only saves the Local
workspace; press **Connect** separately to start NeoVim. You can instead type a
known writable absolute filesystem path manually. Choose **Remote** to keep
using the existing host/port workflow.

This POC browser deliberately does not use `ACTION_OPEN_DOCUMENT_TREE`, map
`content://` URIs to paths, enumerate cloud document providers, or browse
removable storage. NeoVim needs a real working-directory path for ordinary
filesystem and Git operations, while a Storage Access Framework tree is a
provider URI rather than a portable filesystem location.

Local mode intentionally uses a private clean HOME/XDG environment. It does
not load the user's desktop NeoVim configuration or plugins, open a localhost
server, run an intermediary launcher shell, run a background service, or keep
NeoVim alive after the app session closes. `--clean` is not a security sandbox:
NeoVim commands, Lua, `system()`, and `:!` can launch `/system/bin/sh` and access
anything available to the app UID, including the workspace granted through
all-files access. Only open trusted files and send trusted Action Pad commands.

## Before F-Droid

Replace the Termux binary lock with reproducible source builds, add F-Droid
metadata and reproducibility checks, provide a stable release signing process,
audit native licenses/source offers, test lifecycle and storage behavior on
real devices, and decide whether to retain the broad all-files permission or
add a Storage Access Framework workspace backend.
