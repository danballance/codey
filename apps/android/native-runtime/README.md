# Bundled Neovim runtime

Codey packages an arm64 Neovim executable, its dependent shared libraries, and
the Neovim runtime data inside the Android app. At run time, the native module
starts one app-scoped `nvim --embed` child process and carries MessagePack-RPC
over its stdin/stdout file descriptors. Stderr is drained separately into a
bounded diagnostic tail.

This directory contains checksum locks, licence inputs, and the portable
single-file Kickstart configuration for that bundle. It does not contain
generated binaries.

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

## Bundled command scope

The APK includes the tools required by the Codey Kickstart variant: Git with
HTTPS transport and a private CA bundle, ripgrep, StyLua, Lua Language Server,
and eleven Tree-sitter parsers. Git's compiled shell path is relocated to
`/system/bin/sh`; its non-essential sample hook templates are omitted because
some advertise Perl or Watchman. Interactive credential prompting is disabled,
so private HTTPS repositories need a non-interactive credential configuration.

This is not a general Termux userland. SSH transport, `make`, a C/C++ compiler,
`fd`, Node.js, Python, Perl, Watchman, and arbitrary language servers or
formatters are not bundled. The Codey configuration therefore skips clipboard
provider probing, gates optional native plugin builds on `make`, disables Mason
and on-device Tree-sitter installation, and uses syntax fallback for languages
outside the pinned parser set.

The current binary feasibility recipe also retains dormant Termux defaults in
some imported libraries. The launcher overrides active HOME, temporary, Git,
TLS, Neovim, LuaLS, and runtime paths, but direct Lua `os.tmpname()` calls and
optional OpenSSL-provider, BFD-plugin, or terminal-info discovery can still be
limited. These are not needed by the supplied Kickstart path; eliminating every
such default is part of the source-build work required before distribution.

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
checksum. It also invokes `scripts/prepare-treesitter-parsers.sh`, which reads
`tree-sitter-parsers.lock` and builds the generated parser sources with the
project's pinned Android NDK. `native-libraries.lock` is the shared allowlist
used both for ELF staging validation and Gradle's do-not-strip rules. The
combined process:

1. extracts Neovim, the selected command-line tools, and their shared-library
   closure;
2. renames the executable to `libcodey_nvim.so` for Android packaging;
3. cross-compiles the pinned Bash, C, Diff, HTML, Lua, LuaDoc, Markdown,
   Markdown-inline, Query, Vim, and Vimdoc Tree-sitter parsers as APK JNI
   libraries;
4. adds the matching pinned nvim-treesitter Lua/plugin files and only those
   languages' query directories (plus the `html_tags` query dependency);
5. patches every imported runpath and dependency name for the APK
   native-library directory, relocates Git's compiled shell path to Android's
   system shell, and redirects LuaLS's embedded sibling-file lookup to its
   checksum-verified runtime bootstrap;
6. verifies checksums, parser ABI 13--15, exported parser symbols, arm64 ELF
   type, dynamic linker, dependency closure, valid GNU property notes, absence
   of text relocations and Termux runpaths, and 16 KiB load alignment;
7. creates a deterministic runtime-data archive and checksum/revision metadata;
   and
8. stages bundled licence texts and third-party notices.

The parser `.so` files live in Android's extracted, read-only native-library
directory. They are deliberately not downloaded or compiled in the writable
Neovim data directory: modern Android will not load arbitrary executable code
from that location. Parser source archives, nvim-treesitter, and their SHA-256
checksums and exact commits are independently auditable in
`tree-sitter-parsers.lock`.

At the current pins, HTML uses Tree-sitter language ABI 14 and the other ten
parsers use ABI 15. Neovim 0.12.5 accepts language ABI 13 through 15; the helper
extracts each generated `LANGUAGE_VERSION` and rejects a future incompatible
update before packaging it.

Generated JNI libraries and assets live under the `codey-nvim` module's ignored
build inputs. Downloaded packages and the generated Android project are also
ignored by Git.

## Use the bundled Kickstart configuration

Copy `native-runtime/kickstart-codey/init.lua` to the `init.lua` at the config
directory selected in Codey. Its upstream commit, upstream source checksum, and
Codey-adapted checksum are in `native-runtime/kickstart-codey/upstream.lock` and
are validated while preparing the runtime.

The Android launcher sets `CODEY_NVIM=1` plus the native-library,
nvim-treesitter runtime/revision, command-alias, and Lua-language-server paths
documented beside the configuration. The configuration validates those values,
prepends the bundled nvim-treesitter runtime, and loads all eleven parser
libraries by absolute path. It disables Tree-sitter install/update and Mason
downloads on Android, enables Codey's bundled Lua language server directly,
and falls back to ordinary Vim syntax for an unbundled language. Without the
Codey marker, the same file keeps upstream Kickstart's desktop behavior.

Update Kickstart, nvim-treesitter, its queries, and all parser revisions as one
compatibility unit. Never update only the Lua/query half or only a parser
library. The detailed update checklist is in
`native-runtime/kickstart-codey/README.md`.

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
`INTERNET` for Metro/Expo development services and configured Neovim child
processes. In particular, bundled Git/libcurl uses HTTPS to fetch Kickstart
plugins. The embedded editor transport itself remains local: Neovim RPC uses
only the child process's app-owned file descriptors and opens no listener.

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
