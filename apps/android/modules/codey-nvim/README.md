# Codey NeoVim Android module

This local Expo module owns a single embedded NeoVim child process and exposes
its stdin/stdout as binary events. It deliberately does not open a localhost
socket or use an intermediary shell to launch NeoVim. NeoVim itself is not a
sandbox: normal commands, Lua, `system()`, and `:!` may start `/system/bin/sh`
with the app UID and access any files granted to the app.

The generated native runtime inputs are not committed. Before prebuilding the
Android app, stage these files:

- `android/src/main/jniLibs/arm64-v8a/libcodey_nvim.so`: the arm64 PIE NeoVim
  executable.
- `android/src/main/jniLibs/arm64-v8a/*.so`: every native dependency, including
  `libluajit-5.1.so`, the packaged command tools, and the eleven
  `libcodey_ts_<language>.so` Tree-sitter parsers.
- `android/src/main/assets/codey-nvim/runtime.zip`: the contents of NeoVim's
  `share/nvim/runtime` directory at the ZIP root, plus `codey-tools/` and the
  pinned `codey-treesitter/{lua,plugin,queries}` runtime.
- `android/src/main/assets/codey-nvim/bundle.properties`: schema/version and
  runtime checksum, exact Kickstart/nvim-treesitter revisions, native library,
  command/parser mappings, and runtime-data paths.

The app must use API 30 or newer, package only `arm64-v8a`, and extract native
libraries (`android:extractNativeLibs="true"` / legacy JNI packaging). The
executable is launched from `ApplicationInfo.nativeLibraryDir`; copying it to a
writable application directory is intentionally unsupported.

The process environment sets `CODEY_NVIM=1` and exposes the native-library,
nvim-treesitter runtime/revision, command-alias, and Lua-language-server paths
to a selected config. Parser libraries remain in the extracted APK native
directory (Android executable-code policy), while nvim-treesitter's matching
Lua, plugin, and query data is checksum-verified non-executable runtime data.
