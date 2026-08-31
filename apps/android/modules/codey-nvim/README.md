# Codey NeoVim Android module

This local Expo module owns a single embedded NeoVim child process and exposes
its stdin/stdout as binary events. It deliberately does not open a localhost
socket or use an intermediary shell to launch NeoVim. NeoVim itself is not a
sandbox: normal commands, Lua, `system()`, and `:!` may start `/system/bin/sh`
with the app UID and access any files granted to the app.

The generated proof-of-concept inputs are not committed. Before prebuilding the
Android app, stage these files:

- `android/src/main/jniLibs/arm64-v8a/libcodey_nvim.so`: the arm64 PIE NeoVim
  executable.
- `android/src/main/jniLibs/arm64-v8a/*.so`: every native dependency, including
  `libluajit-5.1.so`.
- `android/src/main/assets/codey-nvim/runtime.zip`: the contents of NeoVim's
  `share/nvim/runtime` directory, with the runtime files at the ZIP root.
- `android/src/main/assets/codey-nvim/bundle.properties`: `version=<nvim-version>`
  and `runtimeSha256=<lowercase-runtime.zip-sha256>`.

The app must use API 30 or newer, package only `arm64-v8a`, and extract native
libraries (`android:extractNativeLibs="true"` / legacy JNI packaging). The
executable is launched from `ApplicationInfo.nativeLibraryDir`; copying it to a
writable application directory is intentionally unsupported.
